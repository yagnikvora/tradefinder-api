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
// THE ANSWER THOSE THREE QUESTIONS GET WRONG, AND WHAT FIXES IT
//
// All three are calibrated for a MEAN-REVERTING session, and on a one-sided day every one of
// them fails in the same direction:
//
//   "Is there room left?"   measures the day against one ATR. A genuine trend day expands its
//                           true range to 1.5–2.5 ATR, so `atrUsed` passes 0.8 by mid-morning,
//                           the state locks to `Extended`, `roomAtr` returns zero, `buildPlan`
//                           refuses to produce a plan, and the stock cannot be entered again
//                           for the rest of the session. The harder a stock trends, the sooner
//                           it is disqualified.
//
//   "Has it just started?"  requires a pulse of 55 before ANY trigger may fire. A steady grind
//                           has burst RVOL near 1.0 and velocity near zero — that is what makes
//                           it a grind — and scores around 35. So on precisely the stocks worth
//                           holding all day, this module is not wrong, it is silent.
//
//   "Still going the       reads every healthy pullback as a reversal, because a retracement
//    same way?"            inside a live trend is, by construction, a few minutes going the
//                          other way.
//
// `conviction.service.ts` measures the session's SHAPE and this module now takes it as an
// input. When a day is Forming the extension ceilings are widened; when it is CONFIRMED the
// range and leg ceilings are withdrawn altogether. That escalation is not squeamishness about
// a big number — it is what the data forced. Widening alone was the first attempt and it does
// not survive real trend days: on 2026-08-05 BOSCHLTD ran 2.65 ATR of intraday range and NHPC
// 2.90, and the leg ceiling binds sooner still, because on a one-sided day the leg IS the day.
// No multiplier anyone would ship as a default rescues those, and chasing one would be fitting
// a constant to a premise that is wrong: range mean-reverts on an ordinary session, which is
// what the ceiling was built for, and on a trend day it does not.
//
// What replaces it is not nothing. Distance from VWAP still gates at every phase — "is this
// entry a chase" stays answerable however far the day has come — plus the trend-intact test,
// and `trend.minMinutesLeft`, because the real limit on a continuation trade is how long is
// left to hold it rather than how far the day has already come.
//
// Alongside that, the pulse floor drops to something a grind can clear, a pullback inside the
// healthy band is no longer called a reversal, and a new trigger, `trendPullback`, fires on
// each retracement that turns back with the trend. That last one is deliberately the only
// repeating trigger here: on a trend day the ignition was at 09:40 and is gone, and the
// tradable events for the remaining five hours are the dips. A model that fires once on these
// stocks describes them; one that fires on each pullback trades them.
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
  ConvictionReading, Direction, Extension, FactorReason, MomentumConfig, MomentumSignal,
  PulseSummary, SignalAction, SignalPlan, SignalState, SignalTrigger, StrikeChoice, TradeType,
  TriggerKind,
} from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import type { MomentumQuote } from '../data/quotes.js';
import type { StockChain } from '../data/option-chain.js';
import { selectStrike } from '../services/strike.service.js';
import {
  lastTrigger, readingAt, recordTrigger, triggerCount,
  type FiredTrigger, type SymbolSessionState,
} from '../data/session-state.js';
import type { PulseReading } from '../services/pulse.service.js';
import type { GreeksReading } from '../services/greeks.service.js';
import type { OpeningRange } from '../data/session-state.js';
import { minuteOfSession, SESSION_MINUTES } from '../session.js';
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
  trendPullback: 'Trend-day pullback',
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
  /**
   * The session-shape read. Null when the conviction layer is off — every trend-day
   * behaviour below then reduces to exactly the original gates, so this is a pure extension
   * rather than a change of the existing path.
   */
  conviction?: ConvictionReading | null;
  liquidityScore: number | null;
  config: MomentumConfig;
  nowMs: number;
}

/**
 * What the trend layer thinks, resolved once and passed around.
 *
 * Assembling this in one place matters more than it looks: the multiplier, the pulse floor and
 * the pullback band all have to agree about WHICH phase the stock is in, and computing each
 * one where it is used is how a row ends up entered on a confirmed-day budget against a
 * forming-day pulse floor.
 */
interface TrendContext {
  /** True when the day is Forming or Confirmed and the conviction layer is enabled. */
  active: boolean;
  confirmed: boolean;
  direction: 1 | -1 | null;
  /** What the extension ceilings are multiplied by. 1 when no trend is active. */
  budgetMultiplier: number;
  /** The pulse floor to apply — relaxed on a trend day, ordinary otherwise. */
  pulseFloor: number;
  burstFloor: number;
  /**
   * True once cumulative range and leg length stop being gated on at all — see
   * `signal.trend.retireRangeCeilings`. Only reached on a CONFIRMED day that is STILL MAKING
   * PROGRESS: the relaxed budget is earned continuously rather than granted once, so a trend
   * day that stops extending immediately reverts to ordinary extension rules and is marked
   * spent, which on a stock that has travelled 2.6 ATR it comprehensively is.
   */
  rangeCeilingsRetired: boolean;
  /** The day was one-sided and has stopped making new extremes. */
  stale: boolean;
}

function trendContext(i: SignalInputs): TrendContext {
  const s = i.config.signal;
  const t = s.trend;
  const c = i.conviction;

  const active =
    t.enabled && !!c?.ready && (c.phase === 'Forming' || c.phase === 'Confirmed') && c.direction !== 'Neutral';

  if (!active || !c)
    return {
      active: false, confirmed: false, direction: null, budgetMultiplier: 1,
      pulseFloor: s.minPulseScore, burstFloor: s.minBurstRvol,
      rangeCeilingsRetired: false, stale: false,
    };

  const confirmed = c.phase === 'Confirmed';
  const stale = trendStale(i);
  return {
    active: true,
    confirmed,
    direction: c.direction === 'Bullish' ? 1 : -1,
    // A stale day keeps its phase — it IS still one-sided — but loses the concessions. The
    // phase is a description and the concessions are a bet on continuation, and only one of
    // those survives a stock that stopped going anywhere ninety minutes ago.
    budgetMultiplier: stale ? 1 : confirmed ? t.budgetMultiplier.confirmed : t.budgetMultiplier.forming,
    pulseFloor: stale ? s.minPulseScore : confirmed ? t.minPulseScore.confirmed : t.minPulseScore.forming,
    burstFloor: stale ? s.minBurstRvol : t.minBurstRvol,
    rangeCeilingsRetired: confirmed && t.retireRangeCeilings && !stale,
    stale,
  };
}

/**
 * Has the one-sided day stopped making new extremes?
 *
 * The gate that `Trending` would otherwise swallow. A confirmed trend day outranks `Stalling`
 * in the state machine, and it should — a trend day pausing is not a trend day ending. What it
 * must not do is keep offering dips to buy in something that has not made a new high in two
 * hours, because every reading this layer has stays excellent through exactly that: BOSCHLTD
 * on 2026-08-05 topped at 11:00 and then held 100% VWAP adherence and zero crossings until the
 * close while quietly distributing, and each re-entry taken after noon bought a lower high.
 */
function trendStale(i: SignalInputs): boolean {
  const since = i.conviction?.minutesSinceExtreme;
  if (since === null || since === undefined) return false;
  return since > i.config.signal.trend.maxMinutesSinceExtreme;
}

/**
 * How far price has come back off the day's extreme, in ATR, and whether it is turning back.
 *
 * Measured from `quote.high`/`quote.low` — the session's own extremes — rather than from the
 * zigzag leg. A trend-day dip worth entering is usually deep enough to flip the zigzag, at
 * which point `pulse.pullback` starts measuring the retracement's own leg and reads near zero
 * exactly when the pullback is most complete. Distance from the day's high has no such
 * discontinuity, and it is the number a trader is actually looking at.
 */
interface PullbackRead {
  offExtremeAtr: number | null;
  /** The same distance one fast window ago. Shrinking means price is coming back. */
  wasOffExtremeAtr: number | null;
  /** |price − VWAP| in ATR. */
  vwapDistAtr: number | null;
  /** False once price has broken through VWAP against the trend by more than the tolerance. */
  vwapSideIntact: boolean;
}

function readPullback(i: SignalInputs, dir: 1 | -1): PullbackRead {
  const { quote, pulse, config } = i;
  const atr = pulse.atr;
  const t = config.signal.trend;
  const then = readingAt(i.symState, config.thresholds.pulse.fastWindowMin * 60_000, i.nowMs);

  if (!atr || atr <= 0)
    return { offExtremeAtr: null, wasOffExtremeAtr: null, vwapDistAtr: null, vwapSideIntact: true };

  const extreme = dir === 1 ? quote.high : quote.low;
  const off = dir === 1 ? extreme - quote.ltp : quote.ltp - extreme;
  const wasOff = then ? (dir === 1 ? extreme - then.ltp : then.ltp - extreme) : null;

  const vwapDistAtr = quote.vwap > 0 ? Math.abs(quote.ltp - quote.vwap) / atr : null;
  // A dip THROUGH VWAP is tolerated up to the same distance a touch is measured over — a
  // trend-day pullback often wicks the other side before it turns. Beyond that the day has
  // stopped being one-sided and this is no longer a pullback, whatever its depth says.
  const vwapSideIntact =
    quote.vwap <= 0 || (quote.ltp - quote.vwap) * dir >= -atr * t.vwapTouchAtr;

  return {
    offExtremeAtr: round(Math.max(0, off) / atr, 3),
    wasOffExtremeAtr: wasOff === null ? null : round(Math.max(0, wasOff) / atr, 3),
    vwapDistAtr: vwapDistAtr === null ? null : round(vwapDistAtr, 3),
    vwapSideIntact,
  };
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
function detectTrigger(i: SignalInputs, dir: 1 | -1, trend: TrendContext): Candidate | null {
  const { quote, pulse, baseline, openingRange, symState, config, nowMs } = i;
  const then = readingAt(symState, config.thresholds.pulse.fastWindowMin * 60_000, nowMs);
  if (!then) return null;

  const price = quote.ltp;
  const up = dir === 1;

  // 0. THE TREND-DAY RE-ENTRY, tested first because on a one-sided day it is the only trigger
  //    that describes a trade still available. Everything below fires on a level being taken
  //    out for the first time, and on a stock that has been walking one direction since 09:40
  //    those all fired hours ago.
  //
  //    Three conditions, and the third is what makes it a trigger rather than a description:
  //    price has come back off the day's extreme into the healthy band (or reached VWAP), it
  //    has NOT broken the trend's side of VWAP, and it is now closer to the extreme than it
  //    was one fast window ago — that is, the dip has finished dipping.
  if (trend.active && trend.direction === dir && !trend.stale) {
    const t = config.signal.trend;
    const pb = readPullback(i, dir);

    if (pb.offExtremeAtr !== null && pb.wasOffExtremeAtr !== null && pb.vwapSideIntact) {
      const inBand = pb.offExtremeAtr >= t.pullbackAtr.min && pb.offExtremeAtr <= t.pullbackAtr.max;
      const atVwap = pb.vwapDistAtr !== null && pb.vwapDistAtr <= t.vwapTouchAtr;
      // Turning back, by enough to be a turn rather than a tick. The same buffer the base
      // break uses, so "it moved" means the same thing in both places.
      const buffer = config.thresholds.pulse.breakBufferAtr;
      const resuming = pb.wasOffExtremeAtr - pb.offExtremeAtr >= buffer;

      if ((inBand || atVwap) && resuming) return { kind: 'trendPullback', direction: dir, price };
    }
  }

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

/**
 * How spent the day is — against a budget that depends on what KIND of day it is.
 *
 * The multiplier is the single most consequential number in this module. `atrUsedMax` of 0.8
 * is right for an ordinary session: past it a mean-reverting day needs an abnormal afternoon
 * to pay another leg, and buying that is a bet on the tail. It is badly wrong for a confirmed
 * one-sided day, which routinely runs 1.5–2.5 ATR — there the same ceiling marks the stock
 * spent by mid-morning and refuses every entry for the remaining four hours, so the stocks
 * that trended hardest were the ones this layer disqualified soonest.
 *
 * Scaling the ceiling rather than removing it keeps the protection that made the ceiling worth
 * having: a confirmed trend day that has genuinely run 2.6 ATR still reads `Extended`.
 */
function extensionOf(pulse: PulseReading, cfg: MomentumConfig, trend: TrendContext): Extension {
  const e = cfg.signal.extension;
  const multiplier = trend.budgetMultiplier;
  // Intraday range, not true range. A gap is movement nobody could have traded, and charging
  // it against the budget marked every gapper spent before the session opened — NHPC on
  // 2026-08-05 read 1.13 ATR used at 09:15 and was refused for the whole of a day it then
  // trended one direction through. Falls back to true range only when there is no intraday
  // reading at all, which is a warming-up state rather than a normal one.
  const atrUsed = pulse.intradayAtrUsed ?? pulse.atrUsed;
  const vwapAtr = pulse.vwapAtr === null ? null : Math.abs(pulse.vwapAtr);
  const legMoveAtr = pulse.legMoveAtr;

  const atrUsedMax = e.atrUsedMax * multiplier;
  const vwapAtrMax = e.vwapAtrMax * multiplier;
  const legMoveAtrMax = e.legMoveAtrMax * multiplier;

  // On a confirmed one-sided day the range and leg ceilings are not merely widened, they are
  // withdrawn: a wide range and a long leg are what a trend day IS, so testing against them
  // asks whether the setup is present and then rejects it for being present. Distance from
  // VWAP still applies at every phase, because "is this entry a chase" stays a real question
  // however far the day has come — and on a trend day the pullback requirement is what keeps
  // the answer no.
  const gateRange = !trend.rangeCeilingsRetired;

  const extended =
    (gateRange && atrUsed !== null && atrUsed >= atrUsedMax) ||
    (vwapAtr !== null && vwapAtr >= vwapAtrMax) ||
    (gateRange && legMoveAtr !== null && legMoveAtr >= legMoveAtrMax);

  return {
    atrUsed,
    trueRangeAtrUsed: pulse.atrUsed,
    gapAtr: pulse.gapAtr,
    vwapAtr,
    legMoveAtr,
    budgetMultiplier: round(multiplier, 2),
    // Infinity would serialise to null through JSON and read as "unknown" rather than
    // "withdrawn", so a retired ceiling is reported as 0 and `budgetMultiplier` plus the
    // state's own sentence carry the meaning.
    atrUsedMax: gateRange ? round(atrUsedMax, 3) : 0,
    extended,
  };
}

/**
 * Remaining room, in ATR.
 *
 * ORDINARILY this is the day's range budget: intraday range grows roughly one-for-one with a
 * continued move in the same direction, so what is left before the ceiling is
 * `atrUsedMax − atrUsed`.
 *
 * ON A CONFIRMED TREND DAY there is no such budget, and this returns null — "not measurable"
 * rather than a number, which is the same convention the rest of this module uses for a
 * reading it cannot honestly produce.
 *
 * VWAP headroom was tried here first and is wrong for the same reason the range ceiling was
 * wrong, one level up: on a sustained trend VWAP lags a long way behind price and STAYS
 * behind, so "distance from VWAP" saturates and becomes another permanent bar. NHPC on
 * 2026-08-05 sat 3.4 ATR below its VWAP for most of the afternoon while continuing to fall.
 *
 * The question VWAP distance was standing in for — "is this entry a chase" — is already
 * answered, and answered better, by the pullback band: a trend entry may only be taken
 * 0.15–0.55 ATR back off the day's extreme, which is a direct measurement of not chasing.
 * Adding a second, weaker proxy for the same thing only produced a gate that fired on the
 * strongest trends. What still limits the trade is stated elsewhere and is not a distance:
 * the trend-intact test, `maxMinutesSinceExtreme`, and `minMinutesLeft`.
 */
function roomAtr(pulse: PulseReading, cfg: MomentumConfig, trend: TrendContext): number | null {
  if (trend.rangeCeilingsRetired) return null;

  const used = pulse.intradayAtrUsed ?? pulse.atrUsed;
  if (used === null) return null;
  return round(Math.max(0, cfg.signal.extension.atrUsedMax * trend.budgetMultiplier - used), 3);
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
function buildPlan(
  i: SignalInputs,
  dir: 1 | -1,
  trend: TrendContext,
  trendMode: boolean,
): { plan: SignalPlan; strike: StrikeChoice | null } | null {
  const { quote, pulse, greeks, config } = i;
  const s = config.signal;
  const atr = pulse.atr;
  if (!atr || atr <= 0 || quote.ltp <= 0) return null;

  const entry = quote.ltp;
  const room = roomAtr(pulse, config, trend);

  // A trend-day continuation leg is worth more than an ignition scalp and can carry a wider
  // stop, because what invalidates it is the day's structure failing rather than a tick.
  const wantAtr = trendMode ? s.trend.targetAtr : s.targetAtr;
  const wantStopAtr = trendMode ? s.trend.stopAtr : s.stopAtr;

  // Target: the configured distance, but never past the room the model thinks is left.
  const targetAtr = room === null ? wantAtr : Math.min(wantAtr, room);
  const targetDist = targetAtr * atr;
  if (targetDist <= 0) return null;

  const atrStop = wantStopAtr * atr;

  // Structure beats arithmetic when structure is tighter. Two candidates: the base a break
  // came out of, and — on a trend day — VWAP, which is the level a one-sided day is actually
  // defended at and the one whose loss ends the thesis. Taking the tighter of whatever is
  // available stops the plan paying a full ATR to learn something the chart already said.
  const structural = pulse.base?.compressed
    ? dir === 1
      ? entry - pulse.base.low
      : pulse.base.high - entry
    : null;
  const vwapStop =
    trendMode && quote.vwap > 0 && (entry - quote.vwap) * dir > 0
      ? Math.abs(entry - quote.vwap) + 0.08 * atr
      : null;

  const tighter = [structural, vwapStop].filter((v): v is number => v !== null && v > 0 && v < atrStop);
  const floor = 0.12 * atr;
  const stopDist = Math.max(floor, tighter.length ? Math.min(...tighter) : atrStop);

  const target = dir === 1 ? entry + targetDist : entry - targetDist;
  const stop = dir === 1 ? entry - stopDist : entry + stopDist;
  const targetPct = (targetDist / entry) * 100;

  // ---- which contract, and what that pays ----
  //
  // The strike is picked against the target just computed, so the option numbers below
  // describe the contract a reader would actually buy rather than a notional ATM one. When
  // there is no chain — most of the board, since the enrichment shortlist is finite — this
  // falls back to the ATM greeks, and `basis` says which happened.
  //
  // On a trend-day re-entry the contract is picked inside a DELTA BAND rather than on payoff
  // alone. The payoff ranking is right for a fifteen-minute ignition scalp and wrong for a
  // 30–90 minute hold taken three or four times a session: it walks out to the cheapest strike
  // every time, and four entries in a day is four spreads paid on a contract whose delta
  // stopped tracking the stock the plan was built on.
  const strike = selectStrike({
    chain: i.chain ?? null,
    direction: dir,
    spot: entry,
    targetPrice: target,
    lotSize: i.lotSize ?? null,
    preferDelta: trendMode ? { min: s.trend.strike.minDelta, max: s.trend.strike.maxDelta } : null,
    maxThetaPctPerHour: trendMode ? s.trend.strike.maxThetaPctPerHour : null,
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

/**
 * The plan a CONFIRMED TREND DAY deserves, whatever the timing layer is currently saying.
 *
 * `buildPlan` above already takes a `trendMode` flag that widens the target and prefers the VWAP
 * stop — the level a one-sided day is actually defended at, and the one whose loss ends the
 * thesis. Inside `buildSignal` that flag is only set when the state machine happens to be
 * `Trending`, which is a statement about the last few minutes and not about the day.
 *
 * The trend-day ALERT needs the same maths at a different moment: conviction is promoted to
 * Confirmed on a session-scale reading, and the row is very often `Quiet` at that instant because
 * nothing is igniting right now. Rebuilding the plan in the alert would be a second
 * implementation of the strategy, which this codebase does not do anywhere else and should not
 * start doing for the message that tells you to place an order. So the existing builder is
 * exposed, pinned to trend mode.
 */
export function buildTrendDayPlan(
  i: SignalInputs,
  dir: 1 | -1,
): { plan: SignalPlan; strike: StrikeChoice | null } | null {
  // The trend context is derived from the same inputs rather than passed in, so a caller outside
  // this file cannot construct one that disagrees with what `buildSignal` would have used.
  return buildPlan(i, dir, trendContext(i), true);
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

  const trend = trendContext(i);
  const extension = extensionOf(pulse, config, trend);
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
      entryKind: null,
      trendEntriesToday: triggerCount(symState, 'trendPullback'),
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
  //
  // The FLOOR ITSELF MOVES on a trend day. A steady one-directional grind has a burst RVOL
  // near 1.0 and a velocity near zero — that is what makes it a grind — and scores the pulse
  // around 35 against the ordinary 55. Holding it to that floor is not a conservative choice,
  // it is a guarantee that the stocks worth holding all day never produce a single trigger.
  const pulseStrong = (pulseScore ?? 0) >= trend.pulseFloor;
  const burstOk = pulse.burstRvol === null || pulse.burstRvol >= trend.burstFloor;

  // A trend-day re-entry is MEANT to fire several times a session, so it keeps its own,
  // shorter cooldown. Sharing the 15-minute one would allow at most one entry per pullback
  // pair and quietly halve the number of trades the layer exists to find.
  // On a slow grind the micro bias sits inside the deadband for minutes at a time, so `dir` is
  // null and no trigger could be tested at all — which would silence the trend-day re-entry on
  // exactly the stocks whose whole character is that they move slowly. When a trend is active
  // its direction stands in: the `resuming` test inside the trigger is a stricter statement
  // about which way price is going than the deadband is, so nothing is being waved through.
  const triggerDir: 1 | -1 | null = dir ?? (trend.active ? trend.direction : null);

  let fired: FiredTrigger | null = null;
  if (triggerDir !== null && pulseStrong && burstOk && symState) {
    const candidate = detectTrigger(i, triggerDir, trend);
    if (candidate) {
      const cooldownMin =
        candidate.kind === 'trendPullback' ? s.trend.reentryCooldownMin : s.cooldownMin;
      fired = recordTrigger(
        symState, candidate.kind, candidate.direction, candidate.price, nowMs, cooldownMin * 60_000,
      );
    }
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
  const audible = (pulseScore ?? 0) >= trend.pulseFloor * 0.7;

  // The trend-day read of the same moment. A retracement inside a one-sided day looks
  // identical to the start of a reversal from three minutes away — same leg against the day,
  // same micro direction opposing — and the ONLY things that separate them are how deep it
  // went and whether the trend's side of VWAP survived. Both are measurements.
  const tpb = trend.active && trend.direction !== null ? readPullback(i, trend.direction) : null;
  const trendDipHealthy =
    trend.active &&
    tpb !== null &&
    tpb.vwapSideIntact &&
    (tpb.offExtremeAtr === null || tpb.offExtremeAtr <= s.trend.pullbackAtr.max);
  // A one-sided day that has decisively lost the side it was one-sided on has not pulled
  // back, it has broken. This outranks everything: whoever is holding it is holding it on a
  // thesis that just expired.
  const trendBroken = trend.active && tpb !== null && !tpb.vwapSideIntact;

  let state: SignalState;
  if (trendBroken) {
    state = 'Reversing';
  } else if (audible && aligned === false && (legAgainstDay || deepRetrace) && !trendDipHealthy) {
    // The day says one thing and the last minutes say the other, and the turn is big enough
    // to be a turn. This is the state that costs money on a held option, so it outranks
    // every other reading — except a trend-day dip that has stayed inside its band, which is
    // this exact shape and is the entry rather than the exit.
    state = 'Reversing';
  } else if (extension.extended) {
    state = 'Extended';
  } else if (fresh && trigger !== null && trigger.kind === 'trendPullback' && trend.active) {
    // A trend-day re-entry is not an ignition and must not be labelled one — the leg it is
    // joining started hours ago, and calling it `Igniting` would misreport both how much room
    // is in front of it and how long the hold is expected to be.
    state = 'Trending';
  } else if (fresh && pulseStrong && trigger !== null && dir !== null && trigger.direction === dir) {
    // An ignition has a direction, and it is the trigger's. A recalled trigger pointing the
    // other way to the current minutes is not one — it is a break that has already rolled
    // over, which is the `Reversing`/`Stalling` case below.
    state = 'Igniting';
  } else if (trend.active && trend.direction !== null) {
    // One-sided and intact, but nothing to enter on this minute. A real and useful state:
    // this is the row to have open when the next dip comes.
    state = 'Trending';
  } else if (sinceExtreme !== null && sinceExtreme >= s.stallMinutes && legDir !== null) {
    state = 'Stalling';
  } else if (legWithDay && (legAge ?? 0) > 0 && ((pulseScore ?? 0) >= trend.pulseFloor * 0.6 || retracing)) {
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
  //
  // On a trend day it is the TREND's direction, not the leg's and not the last three minutes'.
  // During the dip that this layer wants to enter, both of those point the wrong way — that is
  // what a dip is — and taking either would put the entry on the wrong side of the trade the
  // row is recommending.
  const tradeDir: 1 | -1 | null =
    state === 'Trending' ? trend.direction : state === 'Extending' ? legDir : dir;

  /* ---- the gates ---- */
  const room = roomAtr(pulse, config, trend);
  const trendMode = state === 'Trending' && trend.active;
  const minutesLeft = Math.max(0, SESSION_MINUTES - minuteOfSession(nowMs));
  const built = tradeDir === null ? null : buildPlan(i, tradeDir, trend, trendMode);
  const plan = built?.plan ?? null;
  const strike = built?.strike ?? null;

  if (state === 'Extended') {
    const parts: string[] = [];
    if (extension.atrUsed !== null && extension.atrUsed >= extension.atrUsedMax)
      parts.push(
        `${(extension.atrUsed * 100).toFixed(0)}% of a normal day's range already travelled` +
        (trend.budgetMultiplier > 1
          ? ` — and that is against the ${extension.atrUsedMax.toFixed(2)} ATR budget a ${trend.confirmed ? 'confirmed' : 'forming'} trend day earns, not the ordinary ${s.extension.atrUsedMax}`
          : ''),
      );
    if (extension.vwapAtr !== null && extension.vwapAtr >= s.extension.vwapAtrMax * trend.budgetMultiplier)
      parts.push(`price ${extension.vwapAtr.toFixed(2)} ATR from VWAP`);
    if (extension.legMoveAtr !== null && extension.legMoveAtr >= s.extension.legMoveAtrMax * trend.budgetMultiplier)
      parts.push(`this leg has already run ${extension.legMoveAtr.toFixed(2)} ATR`);
    blockers.push(`the move is spent — ${parts.join('; ')}`);
  }
  if (state === 'Reversing')
    blockers.push(
      trendBroken
        ? `the one-sided day has broken — price is through VWAP against a ${i.conviction?.direction.toLowerCase() ?? 'trending'} day that held it all session`
        : `the last ${pulse.windowMin.toFixed(0)} minutes are going the other way (${microDirection.toLowerCase()} against a ${direction.toLowerCase()} day)`,
    );
  if (state === 'Stalling')
    blockers.push(`no new extreme for ${sinceExtreme?.toFixed(0)} minutes — the leg has stopped working`);
  if (!pulseStrong && state !== 'Extended')
    blockers.push(
      `momentum pulse ${Math.round(pulseScore ?? 0)} is below the ${Math.round(trend.pulseFloor)} this model acts on` +
      (trend.active ? ` (already relaxed from ${s.minPulseScore} because the day is one-sided)` : ''),
    );
  if (trigger && !fresh)
    blockers.push(`the ${TRIGGER_LABEL[trigger.kind].toLowerCase()} fired ${trigger.ageMin.toFixed(0)} minutes ago — that entry has gone`);
  if (!trigger && state !== 'Extending' && state !== 'Trending')
    blockers.push('nothing has triggered — no level broken and no volume thrust in the window');
  // A `Trending` row with nothing fresh is not failing a gate — it is a live trend with no dip
  // to buy this minute, which is a different and much more useful thing to say.
  if (state === 'Trending' && trend.stale)
    blockers.push(
      `the one-sided day has not made a new ${trend.direction === 1 ? 'high' : 'low'} for ` +
      `${(i.conviction?.minutesSinceExtreme ?? 0).toFixed(0)} minutes — it is holding its ground, not still trending`,
    );
  else if (state === 'Trending' && !(fresh && trigger?.kind === 'trendPullback'))
    blockers.push(
      tpb?.offExtremeAtr !== null && tpb?.offExtremeAtr !== undefined
        ? `trend intact but only ${tpb.offExtremeAtr.toFixed(2)} ATR off the day's ${trend.direction === 1 ? 'high' : 'low'} — waiting for a dip of ${s.trend.pullbackAtr.min}–${s.trend.pullbackAtr.max} ATR to enter on`
        : 'trend intact but no pullback to enter on yet',
    );
  if (room !== null && room < s.minRoomAtr)
    blockers.push(
      trend.rangeCeilingsRetired
        ? `only ${room.toFixed(2)} ATR of headroom from VWAP — this entry is a chase even on a trend day`
        : `only ${room.toFixed(2)} ATR of room left before the model calls the day spent`,
    );
  // Time, not distance, is what actually limits a continuation trade — and it is the gate that
  // replaces the range ceiling on a confirmed day rather than simply being added to it.
  if (trendMode && minutesLeft < s.trend.minMinutesLeft)
    blockers.push(
      `only ${minutesLeft.toFixed(0)} minutes of session left — a trend leg is a 30–90 minute hold and this one has nowhere to run`,
    );
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

  /* ---- trend-day re-entry ---- */
  const trendEntry =
    trendMode &&
    tradeDir !== null &&
    fresh &&
    trigger !== null &&
    trigger.kind === 'trendPullback' &&
    trigger.direction === tradeDir;

  const entrable =
    tradeDir !== null &&
    (state === 'Igniting' || (state === 'Extending' && pullbackEntry) || trendEntry) &&
    blockers.length === 0;

  const entryKind: MomentumSignal['entryKind'] = !entrable
    ? null
    : trendEntry
      ? 'trend'
      : state === 'Extending'
        ? 'pullback'
        : 'ignition';

  const action: SignalAction = entrable
    ? tradeDir === 1
      ? 'Buy Call'
      : 'Buy Put'
    : state === 'Extended' || state === 'Reversing' || (pulseScore ?? 0) < trend.pulseFloor * 0.5
      ? 'Stand Aside'
      : 'Watch';

  /* ---- entry quality ---- */
  //
  // Nothing cumulative goes into this. It is deliberately not the score, and a row can be a
  // 90 with an entry quality of 12 — that pairing is the whole reason this layer exists.
  const wantTarget = trendMode ? s.trend.targetAtr : s.targetAtr;
  const roomScore = room === null ? 50 : clamp((room / Math.max(0.01, wantTarget)) * 100, 0, 100);

  // On a trend day the weighting changes, because what makes the entry good changes. Freshness
  // and pulse are ignition virtues: they say the move just started and is moving fast. Neither
  // describes what is good about buying the third dip in BOSCHLTD at 13:40 — there, the quality
  // of the entry IS the quality of the day, so conviction takes the weight the pulse gives up.
  const convictionScore = i.conviction?.ready ? i.conviction.score : 0;
  const parts: Array<{ v: number; w: number }> = trendMode
    ? [
        { v: convictionScore, w: 0.4 },
        { v: freshness ?? 0, w: 0.2 },
        { v: roomScore, w: 0.25 },
        { v: clamp(liquidityScore ?? 0, 0, 100), w: 0.15 },
      ]
    : [
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
  // A confirmed one-sided day that has just finished a dip is the highest-probability entry
  // this module produces, and the arithmetic above under-rates it because half its inputs are
  // ignition virtues it does not have. Floored rather than boosted, so the number stays
  // comparable with everything else on the board.
  if (trendEntry) entryQuality = Math.max(entryQuality, trend.confirmed ? 70 : 58);

  /* ---- the sentences ---- */
  if (trigger)
    reasons.push({
      ok: fresh,
      text: `${trigger.label} ${trigger.ageMin < 1 ? 'just now' : `${trigger.ageMin.toFixed(0)}m ago`} at ₹${trigger.price.toFixed(2)}` +
        (trigger.movedSincePct !== 0 ? ` — ${fmtPct(trigger.movedSincePct)} since` : ''),
    });
  reasons.push({
    ok: state === 'Igniting' || state === 'Extending' || state === 'Trending',
    text: STATE_SENTENCE[state],
  });
  if (i.conviction?.ready && trend.active)
    reasons.push({
      ok: trend.confirmed,
      text:
        `${trend.confirmed ? 'Confirmed' : 'Forming'} one-sided day, conviction ${i.conviction.score.toFixed(0)}` +
        (i.conviction.heldMin !== null ? `, held ${i.conviction.heldMin.toFixed(0)}m` : '') +
        ` — extension budget widened to ${extension.atrUsedMax.toFixed(2)} ATR`,
    });
  if (extension.atrUsed !== null)
    reasons.push({
      ok: extension.atrUsed < extension.atrUsedMax,
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
    entryKind,
    trendEntriesToday: triggerCount(symState, 'trendPullback'),
    reasons,
    blockers,
  };
}

const STATE_SENTENCE: Record<SignalState, string> = {
  Igniting: 'Move is starting — the leg is in front, not behind',
  Trending: 'One-sided day, still intact — the trade is each dip, not the break',
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
