// The timing layer. WHEN, as opposed to what.
//
// THE PROBLEM THIS SOLVES
//
// `score.service.ts` answers "how much evidence is there that this stock is in a momentum
// move today". Every input to it is cumulative, so the answer is largest once the move is
// finished. Acting on it buys options into the end of a leg: the delta move is already in
// the premium, the implied-volatility bid that came with the move is already paid, and what
// is left to capture is whatever comes AFTER a stock has already done a day's work. That is
// the trade that "does not move according to the signal" — not because the signal was wrong
// about the stock, but because it was a statement about the past being read as a forecast.
//
// So this module never looks at the score to decide anything. It asks three questions of the
// last few minutes and refuses the entry if any of them answers badly:
//
//   HAS IT JUST STARTED?   A trigger with a TIMESTAMP — the first crossing of a level, not
//                          the fact of being above it. "Above the opening range" is true for
//                          four hours; "broke the opening range ninety seconds ago" is a
//                          trade. Triggers are recorded in session state on first firing and
//                          aged from there, so the board can tell the two apart.
//
//   IS THERE ROOM LEFT?    A stock that has already covered 80% of a normal day's range
//                          needs an abnormal day to pay another leg. `extension` measures
//                          how much of the ATR budget is spent, and past the ceiling the
//                          state is `Extended` however good the score is. This is the single
//                          gate that would have stopped most late entries.
//
//   IS IT STILL GOING      The day can be up and the last ten minutes down. The cumulative
//   THE SAME WAY?          factors cannot see that — change-from-previous-close stays
//                          positive all the way through a rollover — so a position taken on
//                          direction alone is wrong long before the score notices. When the
//                          micro direction opposes the day's, the state is `Reversing`.
//
// AND THEN THE ARITHMETIC NOBODY ELSE DOES. `plan` converts the price target into an
// estimated OPTION move using the delta, gamma and premium actually quoted on the chain, and
// reports how far the stock must travel for the option to gain `signal.targetOptionMovePct`.
// A setup whose whole remaining room cannot pay that is not a trade for an option buyer, and
// this is the only place in the module that says so. The estimate is first-order and ignores
// decay and any implied-volatility change over the hold — both are reported separately by
// the Greeks factor, and folding a guess about them in here would present a model as a
// measurement.

import type {
  Direction, Extension, FactorReason, MomentumConfig, MomentumSignal, PulseSummary,
  SignalAction, SignalPlan, SignalState, SignalTrigger, StrikeChoice, TradeType, TriggerKind,
} from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import type { MomentumQuote } from '../data/quotes.js';
import type { StockChain } from '../data/option-chain.js';
import { selectStrike } from '../services/strike.service.js';
import {
  lastTrigger, readingAt, recordTrigger,
  type FiredTrigger, type SymbolSessionState,
} from '../data/session-state.js';
import type { PulseReading } from '../services/pulse.service.js';
import type { GreeksReading } from '../services/greeks.service.js';
import type { OpeningRange } from '../data/session-state.js';
import { clamp, fmtPct } from '../services/scoring.js';

const round = (v: number, d = 2): number => +v.toFixed(d);
const minutesBetween = (from: number, to: number): number => (to - from) / 60_000;

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  baseBreak: 'Range break',
  vwapReclaim: 'VWAP reclaim',
  vwapLoss: 'VWAP loss',
  orbBreak: 'Opening-range break',
  dayExtreme: 'New session extreme',
  priorRange: 'Prior-range break',
  thrust: 'Volume thrust',
};

export interface SignalInputs {
  quote: MomentumQuote;
  pulse: PulseReading;
  /** The pulse factor's 0–100 score, so the gate uses the same number the board shows. */
  pulseScore: number | null;
  symState: SymbolSessionState | undefined;
  baseline: SymbolBaseline | undefined;
  openingRange: OpeningRange | null;
  greeks: GreeksReading | null;
  /** The near-month chain, when this row was enriched. Null for most of the board. */
  chain?: StockChain | null;
  /** From the futures contract — NSE lists the same lot for that underlying's options. */
  lotSize?: number | null;
  /** The day's direction, from the full factor vote. */
  direction: Direction;
  liquidityScore: number | null;
  config: MomentumConfig;
  nowMs: number;
}

/* ------------------------------------------------------------------- the triggers --- */

interface Candidate {
  kind: TriggerKind;
  direction: 1 | -1;
  price: number;
}

/**
 * What just happened, in the order of how early it fires.
 *
 * Every one of these is a CROSSING, tested against where price was one fast window ago.
 * Testing the condition alone ("price is above the opening range") would re-fire on every
 * cycle for the rest of the session and make the age meaningless.
 */
function detectTrigger(i: SignalInputs, dir: 1 | -1): Candidate | null {
  const { quote, pulse, baseline, openingRange, symState, config, nowMs } = i;
  const then = readingAt(symState, config.thresholds.pulse.fastWindowMin * 60_000, nowMs);
  if (!then) return null;

  const price = quote.ltp;
  const up = dir === 1;

  // 1. A compressed base being left. The earliest honest trigger: by definition the move is
  //    only as old as the break, because until now price was inside the range.
  if (pulse.base?.compressed && pulse.base.breaking === (up ? 'up' : 'down')) {
    const wasInside = up ? then.ltp <= pulse.base.high : then.ltp >= pulse.base.low;
    if (wasInside) return { kind: 'baseBreak', direction: dir, price };
  }

  // 2. VWAP, crossed rather than merely on the right side of.
  if (quote.vwap > 0 && then.vwap > 0) {
    const nowAbove = price > quote.vwap;
    const wasAbove = then.ltp > then.vwap;
    if (up && nowAbove && !wasAbove) return { kind: 'vwapReclaim', direction: dir, price };
    if (!up && !nowAbove && wasAbove) return { kind: 'vwapLoss', direction: dir, price };
  }

  // 3. The opening range, once it is a finished range rather than a forming one.
  if (openingRange?.complete && openingRange.high > 0) {
    const level = up ? openingRange.high : openingRange.low;
    const crossed = up ? price > level && then.ltp <= level : price < level && then.ltp >= level;
    if (crossed) return { kind: 'orbBreak', direction: dir, price };
  }

  // 4. Previous session's range and the 20-day extreme. A break of either is what the trend
  //    factor scores; what matters here is that it happened in the last few minutes.
  const priorLevel = up
    ? Math.max(baseline?.prevHigh ?? 0, baseline?.priorHigh ?? 0)
    : Math.min(baseline?.prevLow || Number.MAX_VALUE, baseline?.priorLow || Number.MAX_VALUE);
  if (up ? priorLevel > 0 && price > priorLevel && then.ltp <= priorLevel
         : priorLevel < Number.MAX_VALUE && price < priorLevel && then.ltp >= priorLevel)
    return { kind: 'priorRange', direction: dir, price };

  // The two CONTINUATION triggers below have no level behind them — they are velocity and
  // extremes, which is exactly what a retracement inside a live leg also looks like from
  // three minutes away. Firing them against a leg that has not materially turned would give
  // every healthy breather a bearish ignition of its own, and the row would flip sides twice
  // a leg. The structural triggers above are not subject to this: losing VWAP or breaking
  // back through the opening range against an up leg IS the reversal, not a wobble.
  const againstLiveLeg = pulse.legDirection !== null && pulse.legDirection !== dir;
  const shallow = pulse.pullback !== null && pulse.pullback <= config.signal.pullback.maxDepth;
  if (againstLiveLeg && shallow) return null;

  // 5. A session extreme extended after a stretch of not being. The `<= windowMin` check is
  //    what makes this a break rather than a running commentary on a stock that grinds to a
  //    new high every thirty seconds.
  const sinceExtreme = up ? pulse.minutesSinceDayHigh : pulse.minutesSinceDayLow;
  const extendedNow = up ? price >= quote.high - 1e-9 : price <= quote.low + 1e-9;
  if (extendedNow && sinceExtreme !== null && sinceExtreme <= pulse.windowMin &&
      (pulse.legAgeMin ?? 0) <= config.signal.maxTriggerAgeMin)
    return { kind: 'dayExtreme', direction: dir, price };

  // 6. Nothing structural — velocity and volume alone. Deliberately the last resort and held
  //    to a higher bar, because a thrust with no level behind it is also what a fat-fingered
  //    print looks like.
  const t = config.thresholds.pulse;
  const fastVelocity = Math.abs(pulse.velocityAtrPerMin ?? 0) >= (t.velocityAtrPerMin[2]?.at ?? 0.02);
  const heavyBurst = (pulse.burstRvol ?? 0) >= config.signal.minBurstRvol * 1.5;
  if (fastVelocity && heavyBurst) return { kind: 'thrust', direction: dir, price };

  return null;
}

/* --------------------------------------------------------------------- the states --- */

function extensionOf(pulse: PulseReading, cfg: MomentumConfig): Extension {
  const e = cfg.signal.extension;
  const atrUsed = pulse.atrUsed;
  const vwapAtr = pulse.vwapAtr === null ? null : Math.abs(pulse.vwapAtr);
  const legMoveAtr = pulse.legMoveAtr;

  const extended =
    (atrUsed !== null && atrUsed >= e.atrUsedMax) ||
    (vwapAtr !== null && vwapAtr >= e.vwapAtrMax) ||
    (legMoveAtr !== null && legMoveAtr >= e.legMoveAtrMax);

  return { atrUsed, vwapAtr, legMoveAtr, extended };
}

/**
 * Remaining room, in ATR.
 *
 * The day's true range grows roughly one-for-one with a continued move in the same
 * direction, so what is left before the extension ceiling is `atrUsedMax − atrUsed`. When
 * there is no ATR baseline there is no budget to measure and this returns null rather than
 * assuming the room is there.
 */
function roomAtr(pulse: PulseReading, cfg: MomentumConfig): number | null {
  if (pulse.atrUsed === null) return null;
  return round(Math.max(0, cfg.signal.extension.atrUsedMax - pulse.atrUsed), 3);
}

const directionOfBias = (bias: number, deadband: number): Direction =>
  bias > deadband ? 'Bullish' : bias < -deadband ? 'Bearish' : 'Neutral';

/* ----------------------------------------------------------------------- the plan --- */

/**
 * Entry, stop, target — and what those are worth on the option.
 *
 * The stop prefers STRUCTURE over arithmetic when structure is available and tighter: a base
 * break that trades back inside its base is wrong, and waiting for a full ATR stop to be hit
 * pays for information already in hand. It is floored at a fraction of ATR so a very tight
 * base cannot produce a stop inside the bid-ask noise.
 */
function buildPlan(i: SignalInputs, dir: 1 | -1): { plan: SignalPlan; strike: StrikeChoice | null } | null {
  const { quote, pulse, greeks, config } = i;
  const s = config.signal;
  const atr = pulse.atr;
  if (!atr || atr <= 0 || quote.ltp <= 0) return null;

  const entry = quote.ltp;
  const room = roomAtr(pulse, config);

  // Target: the configured distance, but never past the room the model thinks is left.
  const targetAtr = room === null ? s.targetAtr : Math.min(s.targetAtr, room);
  const targetDist = targetAtr * atr;
  if (targetDist <= 0) return null;

  const atrStop = s.stopAtr * atr;
  const structural = pulse.base?.compressed
    ? dir === 1
      ? entry - pulse.base.low
      : pulse.base.high - entry
    : null;
  const floor = 0.12 * atr;
  const stopDist = Math.max(
    floor,
    structural !== null && structural > 0 && structural < atrStop ? structural : atrStop,
  );

  const target = dir === 1 ? entry + targetDist : entry - targetDist;
  const stop = dir === 1 ? entry - stopDist : entry + stopDist;
  const targetPct = (targetDist / entry) * 100;

  // ---- which contract, and what that pays ----
  //
  // The strike is picked against the target just computed, so the option numbers below
  // describe the contract a reader would actually buy rather than a notional ATM one. When
  // there is no chain — most of the board, since the enrichment shortlist is finite — this
  // falls back to the ATM greeks, and `basis` says which happened.
  const strike = selectStrike({
    chain: i.chain ?? null,
    direction: dir,
    spot: entry,
    targetPrice: target,
    lotSize: i.lotSize ?? null,
    config,
  });

  // Average delta over the move rather than the delta at entry: delta rises through a
  // favourable move, and using the entry figure understates the payoff by roughly half the
  // gamma contribution. Both legs gain |delta| when the underlying goes their way, so the
  // same expression serves calls and puts.
  const premium = strike ? strike.entryCost : dir === 1 ? greeks?.callLtp ?? null : greeks?.putLtp ?? null;
  const baseDelta = strike ? strike.delta : dir === 1 ? greeks?.callDelta ?? null : greeks?.putDelta ?? null;
  // The strike carries raw gamma (per rupee); the ATM reading carries it per 1% of spot.
  const gammaPer1Pct = strike
    ? (strike.gamma ?? 0) * entry / 100
    : greeks?.gammaPer1Pct ?? null;

  let optionMovePctAtTarget: number | null = null;
  let underlyingMovePctForTargetOption: number | null = null;

  if (premium !== null && premium > 0 && baseDelta !== null && Math.abs(baseDelta) > 0.01) {
    const d0 = Math.abs(baseDelta);
    const g = Math.abs(gammaPer1Pct ?? 0);

    const optionGainPct = (movePct: number): number => {
      const avgDelta = Math.min(1, d0 + 0.5 * g * movePct);
      return (avgDelta * (movePct / 100) * entry) / premium * 100;
    };

    // The selected strike already carries a payoff net of its own bid-ask; preferring it
    // keeps the headline number and the contract's own line from disagreeing on screen.
    optionMovePctAtTarget = strike?.gainPctAtTarget ?? round(optionGainPct(targetPct), 1);

    // Invert it for the target gain. Two fixed-point passes: the first solves with the entry
    // delta, the second with the average delta over the move that produced. That converges
    // fast enough here because gamma's contribution is second-order.
    let need = (s.targetOptionMovePct / 100) * premium / (d0 * entry) * 100;
    for (let pass = 0; pass < 2; pass++) {
      const avgDelta = Math.min(1, d0 + 0.5 * g * need);
      need = (s.targetOptionMovePct / 100) * premium / (avgDelta * entry) * 100;
    }
    underlyingMovePctForTargetOption = round(need, 2);
  }

  const plan: SignalPlan = {
    entry: round(entry),
    stop: round(stop),
    target: round(target),
    stopPct: round((stopDist / entry) * 100, 2),
    targetPct: round(targetPct, 2),
    rewardRisk: stopDist > 0 ? round(targetDist / stopDist, 2) : null,
    optionMovePctAtTarget,
    underlyingMovePctForTargetOption,
    meetsOptionTarget:
      underlyingMovePctForTargetOption === null ? null : underlyingMovePctForTargetOption <= round(targetPct, 2),
    basis: strike ? 'strike' : premium !== null && baseDelta !== null ? 'chain' : 'atr-only',
  };

  return { plan, strike };
}

/* -------------------------------------------------------------------------- build --- */

export function buildSignal(i: SignalInputs): MomentumSignal {
  const { quote, pulse, pulseScore, symState, config, nowMs, direction, liquidityScore } = i;
  const s = config.signal;

  const summary: PulseSummary = {
    ready: pulse.ready,
    score: pulseScore,
    bias: 0,
    movePct: pulse.movePct,
    velocityAtrPerMin: pulse.velocityAtrPerMin,
    burstRvol: pulse.burstRvol,
    efficiency: pulse.efficiency,
    acceleration: pulse.acceleration,
    legAgeMin: pulse.legAgeMin,
    legMovePct: pulse.legMovePct,
    pullback: pulse.pullback,
    minutesSinceExtreme: pulse.minutesSinceExtreme,
    note: pulse.note,
  };

  const extension = extensionOf(pulse, config);
  const blockers: string[] = [];
  const reasons: FactorReason[] = [];

  // The micro read. Velocity scaled by persistence, so a choppy path does not vote loudly —
  // the same expression the pulse factor's bias uses, kept here rather than passed so the
  // signal is computable for a row whose factor list has been rebuilt.
  const rawBias = pulse.velocityAtrPerMin === null
    ? 0
    : Math.tanh(pulse.velocityAtrPerMin / (config.thresholds.pulse.fullScaleVelocityAtr || 0.02));
  const bias = pulse.efficiency === null ? rawBias : rawBias * pulse.efficiency;
  summary.bias = round(bias, 3);

  const microDirection = directionOfBias(bias, config.scoring.directionDeadband);
  const aligned =
    microDirection === 'Neutral' || direction === 'Neutral' ? null : microDirection === direction;

  if (!pulse.ready) {
    return {
      state: 'Quiet',
      action: 'Stand Aside',
      entryQuality: 0,
      freshness: null,
      trigger: null,
      microDirection,
      aligned,
      pulse: summary,
      extension,
      plan: null,
      strike: null,
      reasons: [{ ok: false, text: pulse.note ?? 'Timing layer warming up — not enough readings yet' }],
      blockers: ['the last few minutes are not measurable yet'],
    };
  }

  const dir: 1 | -1 | null =
    microDirection === 'Bullish' ? 1 : microDirection === 'Bearish' ? -1 : null;

  /* ---- the trigger ---- */
  //
  // Only a pulse that clears the bar is allowed to fire one. Without that gate every stock
  // crosses its VWAP a dozen times a session on no volume and the board fills with events
  // that are arithmetic rather than signals.
  const pulseStrong = (pulseScore ?? 0) >= s.minPulseScore;
  const burstOk = pulse.burstRvol === null || pulse.burstRvol >= s.minBurstRvol;

  let fired: FiredTrigger | null = null;
  if (dir !== null && pulseStrong && burstOk && symState) {
    const candidate = detectTrigger(i, dir);
    if (candidate) fired = recordTrigger(symState, candidate.kind, dir, candidate.price, nowMs, s.cooldownMin * 60_000);
  }

  // A trigger is an EVENT and keeps its own lifetime. The crossing that fired it scrolls out
  // of the detection window within a few minutes, and without this the row would go from
  // "opening-range break two minutes ago" straight to "nothing has triggered" while the
  // trade was still live — losing both the entry reference price and, worse, the ability to
  // say "that fired eleven minutes ago, you are late". Recalled to twice the freshness
  // limit so the late case is stated rather than silent.
  if (!fired && symState) {
    const prev = lastTrigger(symState);
    // Recalled whichever way it pointed. A stale up-trigger on a stock now heading down is
    // not noise to be hidden — it is the single most useful thing the row can say to
    // somebody already holding the call.
    if (prev && minutesBetween(prev.at, nowMs) <= s.maxTriggerAgeMin * 2) fired = prev;
  }

  const trigger: SignalTrigger | null = fired
    ? {
        kind: fired.kind,
        label: TRIGGER_LABEL[fired.kind],
        direction: fired.direction,
        at: fired.at,
        price: round(fired.price),
        ageMin: round(minutesBetween(fired.at, nowMs), 1),
        movedSincePct:
          fired.price > 0 ? round((((quote.ltp - fired.price) / fired.price) * 100) * fired.direction, 2) : 0,
      }
    : null;

  const freshness = trigger
    ? round(clamp((1 - trigger.ageMin / Math.max(0.1, s.maxTriggerAgeMin)) * 100, 0, 100), 0)
    : null;
  const fresh = trigger !== null && trigger.ageMin <= s.maxTriggerAgeMin;

  /* ---- the state ---- */
  //
  // The ordering matters and the awkward case is the PULLBACK. A retracement inside a live
  // leg has, by definition, a micro direction opposing the day — so testing micro-versus-day
  // alone would label every healthy breather "Reversing" and the layer would refuse the one
  // entry that is actually better than chasing. What separates the two is whether the move
  // against the leg is MATERIAL: either the ATR-scaled zigzag has actually turned, or the
  // retracement is deeper than the band a pullback lives in. Both are measurements, not
  // thresholds on the same number that produced the disagreement.
  const legAge = pulse.legAgeMin;
  const sinceExtreme = pulse.minutesSinceExtreme;
  const legDir = pulse.legDirection;
  const dayDir: 1 | -1 | null = direction === 'Bullish' ? 1 : direction === 'Bearish' ? -1 : null;

  const retracing = pulse.pullback !== null && pulse.pullback >= s.pullback.minDepth;
  const deepRetrace = pulse.pullback !== null && pulse.pullback > s.pullback.maxDepth;
  const legAgainstDay = legDir !== null && dayDir !== null && legDir !== dayDir;
  const legWithDay = legDir !== null && (dayDir === null || legDir === dayDir);
  const audible = (pulseScore ?? 0) >= s.minPulseScore * 0.7;

  let state: SignalState;
  if (audible && aligned === false && (legAgainstDay || deepRetrace)) {
    // The day says one thing and the last minutes say the other, and the turn is big enough
    // to be a turn. This is the state that costs money on a held option, so it outranks
    // every other reading.
    state = 'Reversing';
  } else if (extension.extended) {
    state = 'Extended';
  } else if (fresh && pulseStrong && trigger !== null && dir !== null && trigger.direction === dir) {
    // An ignition has a direction, and it is the trigger's. A recalled trigger pointing the
    // other way to the current minutes is not one — it is a break that has already rolled
    // over, which is the `Reversing`/`Stalling` case below.
    state = 'Igniting';
  } else if (sinceExtreme !== null && sinceExtreme >= s.stallMinutes && legDir !== null) {
    state = 'Stalling';
  } else if (legWithDay && (legAge ?? 0) > 0 && ((pulseScore ?? 0) >= s.minPulseScore * 0.6 || retracing)) {
    state = 'Extending';
  } else {
    state = 'Quiet';
  }

  /**
   * The direction an entry here would actually be taken in.
   *
   * Not always the micro direction: entering an established leg on a retracement means
   * trading WITH the leg while the last few minutes point against it. Conflating the two is
   * what would make the alignment gate reject every pullback entry it was meant to allow.
   */
  const tradeDir: 1 | -1 | null = state === 'Extending' ? legDir : dir;

  /* ---- the gates ---- */
  const room = roomAtr(pulse, config);
  const built = tradeDir === null ? null : buildPlan(i, tradeDir);
  const plan = built?.plan ?? null;
  const strike = built?.strike ?? null;

  if (state === 'Extended') {
    const parts: string[] = [];
    if (extension.atrUsed !== null && extension.atrUsed >= s.extension.atrUsedMax)
      parts.push(`${(extension.atrUsed * 100).toFixed(0)}% of a normal day's range already travelled`);
    if (extension.vwapAtr !== null && extension.vwapAtr >= s.extension.vwapAtrMax)
      parts.push(`price ${extension.vwapAtr.toFixed(2)} ATR from VWAP`);
    if (extension.legMoveAtr !== null && extension.legMoveAtr >= s.extension.legMoveAtrMax)
      parts.push(`this leg has already run ${extension.legMoveAtr.toFixed(2)} ATR`);
    blockers.push(`the move is spent — ${parts.join('; ')}`);
  }
  if (state === 'Reversing')
    blockers.push(`the last ${pulse.windowMin.toFixed(0)} minutes are going the other way (${microDirection.toLowerCase()} against a ${direction.toLowerCase()} day)`);
  if (state === 'Stalling')
    blockers.push(`no new extreme for ${sinceExtreme?.toFixed(0)} minutes — the leg has stopped working`);
  if (!pulseStrong && state !== 'Extended')
    blockers.push(`momentum pulse ${Math.round(pulseScore ?? 0)} is below the ${s.minPulseScore} this model acts on`);
  if (trigger && !fresh)
    blockers.push(`the ${TRIGGER_LABEL[trigger.kind].toLowerCase()} fired ${trigger.ageMin.toFixed(0)} minutes ago — that entry has gone`);
  if (!trigger && state !== 'Extending')
    blockers.push('nothing has triggered — no level broken and no volume thrust in the window');
  if (room !== null && room < s.minRoomAtr)
    blockers.push(`only ${room.toFixed(2)} ATR of room left before the model calls the day spent`);
  if (s.requireAlignment && tradeDir !== null && dayDir !== null && tradeDir !== dayDir)
    blockers.push('the direction this entry would take disagrees with the day');
  if ((liquidityScore ?? 0) < config.thresholds.liquidity.grade.average)
    blockers.push('too thin to get the size on that this implies');
  // Whether the prize is 20% or 40% is a SIZING question, not a validity one, so by default
  // this is stated and costs entry quality rather than refusing the trade. Turning
  // `requireOptionTarget` on makes it a gate, for somebody who only wants setups that can
  // pay the full number — a much shorter list, which is the honest consequence.
  // The stock can be a perfect setup and the only contract on it untradable. That is a
  // blocker rather than a warning: a 40% move on paper through a book 8% wide, in a strike
  // nobody is quoting, is not a gain anyone collects.
  if (strike && strike.spreadPct !== null && strike.spreadPct > s.strike.maxSpreadPct * 2)
    blockers.push(
      `the best strike (${strike.label}) is quoted ${strike.spreadPct.toFixed(1)}% wide — the spread eats the trade`,
    );
  if (plan?.meetsOptionTarget === false && s.requireOptionTarget)
    blockers.push(
      `the stock needs ${plan.underlyingMovePctForTargetOption?.toFixed(2)}% for a ${s.targetOptionMovePct}% option gain, ` +
      `and the plan only has ${plan.targetPct.toFixed(2)}% of room`,
    );

  /* ---- pullback entry into an established leg ---- */
  const pullbackEntry =
    s.pullback.enabled &&
    state === 'Extending' &&
    pulse.pullback !== null &&
    pulse.pullback >= s.pullback.minDepth &&
    pulse.pullback <= s.pullback.maxDepth;

  const entrable =
    tradeDir !== null &&
    (state === 'Igniting' || (state === 'Extending' && pullbackEntry)) &&
    blockers.length === 0;

  const action: SignalAction = entrable
    ? tradeDir === 1
      ? 'Buy Call'
      : 'Buy Put'
    : state === 'Extended' || state === 'Reversing' || (pulseScore ?? 0) < s.minPulseScore * 0.5
      ? 'Stand Aside'
      : 'Watch';

  /* ---- entry quality ---- */
  //
  // Nothing cumulative goes into this. It is deliberately not the score, and a row can be a
  // 90 with an entry quality of 12 — that pairing is the whole reason this layer exists.
  const roomScore = room === null ? 50 : clamp((room / Math.max(0.01, s.targetAtr)) * 100, 0, 100);
  const parts: Array<{ v: number; w: number }> = [
    { v: freshness ?? 0, w: 0.3 },
    { v: pulseScore ?? 0, w: 0.3 },
    { v: roomScore, w: 0.25 },
    { v: clamp(liquidityScore ?? 0, 0, 100), w: 0.15 },
  ];
  let entryQuality = parts.reduce((a, p) => a + p.v * p.w, 0);
  if (state === 'Reversing') entryQuality *= 0.4;
  if (state === 'Extended') entryQuality *= 0.35;
  if (state === 'Stalling') entryQuality *= 0.6;
  // A setup whose whole remaining room cannot pay the option gain being aimed at is a worse
  // entry than one that can, even when nothing about it is wrong. It costs quality rather
  // than being refused — see the blocker above for why.
  if (plan?.meetsOptionTarget === false) entryQuality *= 0.75;
  if (pullbackEntry) entryQuality = Math.max(entryQuality, 55); // a clean retracement is a real entry

  /* ---- the sentences ---- */
  if (trigger)
    reasons.push({
      ok: fresh,
      text: `${trigger.label} ${trigger.ageMin < 1 ? 'just now' : `${trigger.ageMin.toFixed(0)}m ago`} at ₹${trigger.price.toFixed(2)}` +
        (trigger.movedSincePct !== 0 ? ` — ${fmtPct(trigger.movedSincePct)} since` : ''),
    });
  reasons.push({
    ok: state === 'Igniting' || state === 'Extending',
    text: STATE_SENTENCE[state],
  });
  if (extension.atrUsed !== null)
    reasons.push({
      ok: extension.atrUsed < s.extension.atrUsedMax,
      text: `${(extension.atrUsed * 100).toFixed(0)}% of a normal day's range used${
        room === null ? '' : ` — ${room.toFixed(2)} ATR of room left`
      }`,
    });
  if (plan?.optionMovePctAtTarget !== null && plan?.optionMovePctAtTarget !== undefined)
    reasons.push({
      ok: (plan.optionMovePctAtTarget ?? 0) >= s.targetOptionMovePct,
      text:
        `Target ₹${plan.target.toFixed(2)} (${fmtPct(plan.targetPct)}) ≈ ${plan.optionMovePctAtTarget.toFixed(0)}% on ` +
        (strike ? `the ${strike.label}` : 'the ATM option'),
    });
  if (strike)
    reasons.push({
      ok: strike.warnings.length === 0,
      text:
        `Buy ${strike.label} @ ₹${strike.entryCost.toFixed(2)}` +
        (strike.costPerLot !== null ? ` (₹${strike.costPerLot.toLocaleString('en-IN')} a lot)` : '') +
        ` — ${strike.reason}`,
    });

  return {
    state,
    action,
    entryQuality: round(clamp(entryQuality, 0, 100), 0),
    freshness,
    trigger,
    microDirection,
    aligned,
    pulse: summary,
    extension,
    plan,
    strike,
    reasons,
    blockers,
  };
}

const STATE_SENTENCE: Record<SignalState, string> = {
  Igniting: 'Move is starting — the leg is in front, not behind',
  Extending: 'Leg is established and still working — entry is a pullback, not a chase',
  Extended: 'Move is largely spent — a strong score here is describing what already happened',
  Stalling: 'Leg has stopped making progress',
  Reversing: 'The last minutes are going against the day',
  Quiet: 'Nothing moving on the minute scale',
};

/**
 * Downgrade a trade type the timing layer will not stand behind.
 *
 * `Momentum Buy` on a spent move is the failure this whole layer exists to fix, so the
 * headline label is not allowed to say it. It becomes `Watch` — the model still likes the
 * stock, and `signal.blockers` says exactly which gate stopped the entry.
 */
export function gateTradeType(base: TradeType, signal: MomentumSignal | null, cfg: MomentumConfig): TradeType {
  if (!signal || !cfg.signal.enabled || !cfg.signal.gateTradeType) return base;
  if (base === 'Avoid') return base;
  if (base === 'Momentum Buy' && signal.action === 'Buy Call') return base;
  if (base === 'Momentum Sell' && signal.action === 'Buy Put') return base;
  return 'Watch';
}
