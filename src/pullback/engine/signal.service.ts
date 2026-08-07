// Assembling a signal, and — more importantly — refusing to.
//
// Everything upstream of this file MEASURES. This is the only place that decides, and the
// decision is expressed as a list of BLOCKERS rather than as a boolean, because the near misses
// are most of the value: a setup blocked only by "reward:risk is 1.4, needs 1.5" is something a
// trader wants on screen, and one blocked by six conditions is not. A boolean cannot carry that
// difference, and a scanner that shows nothing on a quiet afternoon is indistinguishable from a
// scanner that is broken.
//
// SO EVERY ROW PRODUCES SOMETHING. A row whose blockers are empty and whose pullback has
// confirmed becomes a SIGNAL. A row with a real trend that is at the zone, or on its way back to
// it, becomes a WATCH — the same object, with its blockers populated and `fired` false. The
// board's "Upcoming Pullbacks" card is built entirely from the second kind, and it is the card
// that is actually actionable: by the time a confirmation candle has closed, the entry is
// already one bar old.
//
// THREE OF THE GATES BELOW ARE ABOUT THE PRICE AND NOT ABOUT THE SETUP, and they are the ones
// that changed this module's results most. Everything else here asks "is this a pullback worth
// trading". These ask "is the number beside it a price you can still get", which is a different
// question with a different answer, because the plan is measured from the confirmation bar's close
// and by the time a scan publishes it the market has moved on:
//
//   ENTRY PROXIMITY   `minEntryExtensionAtr` … `maxEntryExtensionAtr`. How far the confirmation
//                     closed beyond the pullback zone. Inside the band it has not turned; a long
//                     way past it, it has turned without you — and the stop is drawn from the same
//                     pullback low either way, so the second case pays for the bounce and keeps
//                     all of the risk.
//   ENTRY DRIFT       `maxChaseR` / `maxGiveBackR`. The same idea against the LIVE price rather
//                     than against the zone, in units of the plan's own risk.
//   HOLD TIME         `minHoldBars`, scaled by the timeframe, because a 15-minute pullback needs
//                     about three times as long to reach its target as a 5-minute one and the old
//                     fixed 30-minute floor let more than half of them be closed by the clock.
//
// All three were measured rather than chosen. A 45-symbol, 120-session replay is in
// `tools/pullback-research.ts`; the per-gate numbers are on the config fields in `types.ts`.
//
// THE COOLDOWN IS A GATE, NOT A DEDUPE. `pullback.cooldownMin` stops the same leg firing twice.
// It is deliberately shorter than a session — twenty minutes by default — because a stock that
// is genuinely trending gives three or four pullbacks in a day and each is a separate trade with
// its own structure and its own stop. A once-a-day signal on those names would describe the
// trend rather than trade it. That is the same lesson the momentum module's trend re-entry
// learned, arrived at from the other direction.

import type { StockChain } from '../../momentum/data/option-chain.js';
import { minuteOfSession, SESSION_MINUTES } from '../../momentum/session.js';
import type { Bar } from '../indicators/series.js';
import { buildPlan } from './risk.service.js';
import { selectOption } from './option.service.js';
import { alignedTimeframes, scoreSignal } from './score.service.js';
import type {
  EntryKind, PullbackConfig, PullbackRead, PullbackSignal, Timeframe, TimeframeRead, TrendRead,
} from '../types.js';

export interface SignalInput {
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
  read: TimeframeRead;
  trend: TrendRead;
  pullback: PullbackRead;
  /** Every computed timeframe, for the alignment bonus. */
  frames: Partial<Record<Timeframe, TimeframeRead>>;
  /** The live price, so a signal that fired four bars ago shows how far it has run without you. */
  price: number;
  chain: StockChain | null;
  /** Series price plus this is the equivalent spot price. Non-zero only for an index. */
  spotAdjust: number;
  lotSize: number | null;
  /** When this symbol/timeframe last fired, for the cooldown. */
  lastFiredAt: number | null;
  cfg: PullbackConfig;
  nowMs: number;
}

export interface SignalResult {
  signal: PullbackSignal;
  /** True when every gate passed and this is a live entry. */
  fired: boolean;
}

/**
 * A pullback that has confirmed is a `pullback` entry; anything else is `holding`.
 *
 * The distinction exists to pick the option, and it is the brief's: an entry AT the zone has a
 * defined stop a short distance away and a one-to-two-hour horizon, which is what 0.30–0.45
 * delta is for. A row where the trend is running and price never came back is a decision to
 * join late — worse entry, longer hold, wider stop — and 0.45–0.60 buys the delta that makes
 * that survivable.
 */
const entryKindOf = (p: PullbackRead): EntryKind =>
  p.phase === 'Resuming' || p.phase === 'AtZone' ? 'pullback' : 'holding';

/**
 * How far `entry` sits beyond the near edge of the pullback zone, in ATR, signed with the trade.
 *
 * Measured to the edge rather than to the middle because the edge is what price had to clear for
 * the retracement to be over — and the zone is already widened by `zoneToleranceAtr`, so this is
 * distance past the outermost of {9 EMA, 20 EMA, VWAP} plus that tolerance. Negative means the
 * entry is still inside the band.
 *
 * Null when there is no zone or no ATR, in which case the gate does not run: an unmeasurable
 * reading is not a failed one, the same rule the score applies to a warming component.
 */
export function zoneExtensionAtr(
  p: PullbackRead,
  entry: number,
  direction: 1 | -1,
  atr: number | null,
): number | null {
  if (!p.zone || !atr || !(atr > 0)) return null;
  const past = direction === 1 ? entry - p.zone.top : p.zone.bottom - entry;
  return +(past / atr).toFixed(3);
}

/**
 * Evaluate one symbol on one timeframe.
 *
 * Returns null only when there is genuinely nothing to say — no direction, or no plan can be
 * priced. Everything else comes back as a signal object with its blockers attached, and the
 * caller decides whether it belongs on the signal list or the watchlist.
 */
export function evaluateSignal(i: SignalInput): SignalResult | null {
  const { cfg, trend, pullback, read } = i;

  // Direction comes from the trend hypothesis, falling back to the pullback's own read when the
  // trend was rejected. Both agree by construction — `readPullback` is called with the trend's
  // direction — and the fallback exists so a vetoed row still produces a watch entry rather
  // than vanishing, which is what the "Bullish / Bearish" cards count.
  const direction: 1 | -1 | 0 =
    trend.state === 'Bullish' ? 1 : trend.state === 'Bearish' ? -1 : pullback.direction;
  if (direction === 0) return null;

  const blockers: string[] = [];
  const reasons: string[] = [];

  /* ------------------------------------------------------------------------ gates --- */

  for (const f of trend.failed) blockers.push(`trend: ${f}`);
  for (const v of trend.vetoes) blockers.push(v);

  if (pullback.phase !== 'Resuming')
    blockers.push(
      pullback.phase === 'Failed'
        ? `the pullback failed — ${pullback.note ?? 'structure broke'}`
        : pullback.phase === 'AtZone'
          ? `at the zone, no confirmation candle yet${pullback.note ? ` — ${pullback.note}` : ''}`
          : pullback.phase === 'None'
            ? (pullback.note ?? 'no pullback to trade')
            : `${pullback.phase.replace(/([A-Z])/g, ' $1').trim().toLowerCase()} — not at the zone yet`,
    );

  /* ------------------------------------------------------------------------- plan --- */

  // The entry is the CONFIRMATION BAR'S CLOSE, not the live price. That is the price the setup
  // was defined at, and the stop and every target are measured from it — quoting the plan
  // against a live price that has already moved would report a reward:risk the trade never had.
  // A watch row has no confirmation, so it is priced at the last closed bar as a projection.
  const entry = pullback.confirmation?.close ?? read.close;
  if (entry === null || !(entry > 0)) return null;

  const plan = buildPlan({
    bars: i.bars, read, pullback, direction, entry, cfg,
  });
  if (!plan) return null;

  // Gated on `roomR`, not on `rewardRisk`. With a 2R primary target the reward:risk is 2.00 on
  // every row by construction, so comparing a floor against it is a gate that cannot fire — see
  // `TargetPlan.roomR`.
  if (plan.target.roomR < cfg.risk.minRewardRisk)
    blockers.push(
      `only ${plan.target.roomR.toFixed(2)}R of room to the next real objective (needs ` +
      `${cfg.risk.minRewardRisk}) — the retracement was deep enough that the stop it demands ` +
      `(${plan.stop.recommended.distanceAtr.toFixed(2)} ATR) costs more than the leg repeating would pay`,
    );
  if (plan.stop.warning) reasons.push(plan.stop.warning);

  /* ------------------------------------------------------------- where the entry sits --- */

  // How far past the zone the confirmation closed. See `PullbackConfig.pullback.minEntryExtensionAtr`
  // — below the floor the turn has not happened, above the ceiling it has happened without you, and
  // this band is the strongest single separation in the module.
  const extensionAtr = zoneExtensionAtr(pullback, entry, direction, read.atr);

  if (extensionAtr !== null && extensionAtr < cfg.pullback.minEntryExtensionAtr)
    blockers.push(
      `the confirmation closed ${extensionAtr < 0 ? `${Math.abs(extensionAtr).toFixed(2)} ATR INSIDE the zone` : `only ${extensionAtr.toFixed(2)} ATR clear of it`} ` +
      `(needs ${cfg.pullback.minEntryExtensionAtr}) — price is still at the level it is supposed to be ` +
      'leaving, so this is a green bar inside a retracement rather than the end of one',
    );

  if (extensionAtr !== null && extensionAtr > cfg.pullback.maxEntryExtensionAtr)
    blockers.push(
      `the confirmation closed ${extensionAtr.toFixed(2)} ATR clear of the zone (limit ` +
      `${cfg.pullback.maxEntryExtensionAtr}) — the stop is still drawn from the pullback low, so this ` +
      'entry pays the whole bounce and keeps the whole risk',
    );

  /* ------------------------------------------------------------------ still an entry --- */

  // How much of the plan's own risk the market has already spent while this setup was being
  // published. See `PullbackConfig.pullback.maxChaseR` — the short version is that every number on
  // this row is measured from the confirmation close, and once the live price is far enough from
  // it the row is describing a trade that is no longer available at the price beside it.
  const risk = plan.stop.recommended.distance;
  const entryDriftR = risk > 0 ? +((((i.price - entry) * direction) / risk).toFixed(3)) : null;

  if (entryDriftR !== null && entryDriftR > cfg.pullback.maxChaseR)
    blockers.push(
      `price is already ${entryDriftR.toFixed(2)}R past the ${entry.toFixed(2)} confirmation close ` +
      `(limit ${cfg.pullback.maxChaseR}) — the stop has not moved, so buying here is a ` +
      `${(plan.target.primary.r - entryDriftR).toFixed(2)}R trade taking ${(1 + entryDriftR).toFixed(2)}R of risk, ` +
      'not the plan on this row',
    );

  if (entryDriftR !== null && entryDriftR < -cfg.pullback.maxGiveBackR)
    blockers.push(
      entryDriftR <= -1
        ? `price is ${Math.abs(entryDriftR).toFixed(2)}R below the entry — the stop at ` +
          `${plan.stop.recommended.price.toFixed(2)} has already been taken out and this setup is over`
        : `price has given back ${Math.abs(entryDriftR).toFixed(2)}R of the ${risk.toFixed(2)} risk since the ` +
          `confirmation (limit ${cfg.pullback.maxGiveBackR}) — the turn did not hold, and what is left ` +
          'is a coin flip with a fraction of a stop under it',
    );

  /* ------------------------------------------------------------------------ score --- */

  const score = scoreSignal({ trend, pullback, read, frames: i.frames, direction, cfg });

  if (score.coverage < cfg.score.minCoverage)
    blockers.push(
      `only ${(score.coverage * 100).toFixed(0)}% of the confidence model is measurable ` +
      `(needs ${(cfg.score.minCoverage * 100).toFixed(0)}%) — usually an average or ADX still warming`,
    );
  if (score.total < cfg.score.minToSignal)
    blockers.push(`confidence ${score.total.toFixed(0)} is below the ${cfg.score.minToSignal} floor`);

  /* ----------------------------------------------------------------------- option --- */

  const entryKind = entryKindOf(pullback);
  const option = selectOption({
    chain: i.chain,
    direction,
    entryKind,
    entry,
    target: plan.target.primary.price,
    spotAdjust: i.spotAdjust,
    lotSize: i.lotSize,
    cfg,
  });

  if (option && cfg.option.vetoSignalOnIlliquidOption && option.liquidity.score < cfg.option.minLiquidityScore)
    blockers.push(
      `the best contract on this chain scores ${option.liquidity.score.toFixed(0)}/100 for liquidity ` +
      `(${option.liquidity.grade}, floor ${cfg.option.minLiquidityScore}) — this signal cannot be expressed as an option trade`,
    );

  /* --------------------------------------------------------------------- cooldown --- */

  const firedAt = pullback.confirmation?.at ?? read.lastClosedAt ?? i.nowMs;

  // How long is left to HOLD it, measured from the confirmation bar rather than from the wall clock,
  // so the gate means the same thing in a live scan and in a replay.
  const minutesLeft = SESSION_MINUTES - minuteOfSession(firedAt);
  // Scaled by the timeframe, not fixed. See `PullbackConfig.pullback.minHoldBars` — the short
  // version is that a 15-minute pullback takes about three times as long to reach its target as a
  // 5-minute one, and a single 30-minute floor let more than half of them be closed by the clock.
  const minutesNeeded = Math.max(cfg.pullback.minMinutesLeft, cfg.pullback.minHoldBars * i.timeframe);
  if (minutesLeft < minutesNeeded)
    blockers.push(
      `only ${Math.max(0, minutesLeft)} minutes of session left (needs ${minutesNeeded}) — ` +
      `a ${i.timeframe}m pullback is about a ${cfg.pullback.minHoldBars}-bar hold, and this one would be ` +
      'closed into the auction rather than at a level',
    );

  if (i.lastFiredAt !== null && firedAt - i.lastFiredAt < cfg.pullback.cooldownMin * 60_000)
    blockers.push(
      `already signalled ${Math.round((firedAt - i.lastFiredAt) / 60_000)} minutes ago — ` +
      `the ${cfg.pullback.cooldownMin}-minute cooldown stops one leg firing twice`,
    );

  /* ------------------------------------------------------------------- assembly --- */

  const aligned = alignedTimeframes(i.frames, i.timeframe, direction, cfg.timeframes.context);

  if (pullback.confirmation) reasons.unshift(...pullback.confirmation.reasons);
  if (pullback.touch.nearest)
    reasons.unshift(
      `pulled back ${((pullback.retracement ?? 0) * 100).toFixed(0)}% of a ` +
      `${pullback.impulse ? (Math.abs(pullback.impulse.toPrice - pullback.impulse.fromPrice) / pullback.impulse.atr).toFixed(1) : '?'} ATR leg to the ` +
      `${pullback.touch.nearest === 'vwap' ? 'VWAP' : pullback.touch.nearest === 'ema9' ? '9 EMA' : '20 EMA'}`,
    );
  if (aligned.length) reasons.push(`${aligned.map((tf) => `${tf}m`).join(' and ')} pointing the same way`);
  if (option) reasons.push(`${option.label} at ₹${option.entryCost.toFixed(2)} — ${option.reason}`);

  const movedSincePct = entry > 0 ? +((((i.price - entry) / entry) * 100) * direction).toFixed(3) : 0;

  const signal: PullbackSignal = {
    // Stable across scans for the same confirmation, which is what lets the alert engine dedupe
    // and the outcome tracker follow one trade rather than re-opening it every thirty seconds.
    id: `${i.symbol}:${i.timeframe}:${direction === 1 ? 'L' : 'S'}:${firedAt}`,
    symbol: i.symbol,
    timeframe: i.timeframe,
    direction,
    side: direction === 1 ? 'BUY' : 'SELL',
    entryKind,
    firedAt,
    ageMin: +((i.nowMs - firedAt) / 60_000).toFixed(1),
    entry: +entry.toFixed(2),
    price: +i.price.toFixed(2),
    movedSincePct,
    entryDriftR,
    score,
    stop: plan.stop,
    target: plan.target,
    option,
    trend,
    pullback,
    alignedWith: aligned,
    outcome: {
      state: 'Open',
      maxFavourable: +entry.toFixed(2),
      maxAdverse: +entry.toFixed(2),
      r: null,
      closedAt: null,
    },
    reasons,
    blockers,
  };

  return { signal, fired: blockers.length === 0 };
}

/**
 * Whether a blocked row is worth showing as a watch candidate.
 *
 * The bar is deliberately not "any row with a trend". A watchlist that carries every stock with
 * a stacked EMA is 150 rows and gets ignored, which is worse than not having one — so a watch
 * entry needs a real trend read, a pullback that is at least on its way, and a confidence score
 * that would clear the signal floor if the pullback completed. What it does NOT need is the
 * confirmation candle, which is the entire point: that is the thing being waited for.
 */
export function worthWatching(r: SignalResult, cfg: PullbackConfig): boolean {
  const { signal } = r;
  if (r.fired) return false;
  if (signal.pullback.phase !== 'AtZone' && signal.pullback.phase !== 'PullingBack') return false;
  if (signal.trend.vetoes.length) return false;
  // One missing required condition is a near miss worth watching; two is a different chart.
  if (signal.trend.failed.length > 1) return false;
  return signal.score.total >= cfg.score.minToSignal - 10;
}
