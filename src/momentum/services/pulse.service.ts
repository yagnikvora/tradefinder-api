// Factor 12 — Momentum Pulse. The only thing in this module measured over MINUTES.
//
// WHY THIS EXISTS
//
// The other eleven factors are all cumulative-since-09:15. Relative volume divides the day's
// volume by the day's normal volume; relative strength is the change from the previous
// close; ATR expansion needs the range to have formed; trend structure needs the high to
// have been taken out. Each is a good measurement, and every one of them is at its LARGEST
// once the move is over. A board built only from those ranks a stock highest at the moment
// it has least left to give, which is precisely when an option bought on it has already paid
// for the move through delta and through the implied-volatility bid that came with it.
//
// This factor asks a different question: not "how big has today been" but "is the stock
// moving RIGHT NOW, and did it only just start". Four readings answer it, and all four come
// out of the ring `session-state.ts` already keeps from the ordinary quote poll. No upstream
// request is made here, which is what makes it affordable on every one of the 208 stocks
// rather than on a shortlist — and being universe-wide is the point, because the stock about
// to move is by definition not yet the one at the top of the score.
//
//   BURST      volume in the last three minutes against what this stock normally trades in
//              three minutes AT THIS TIME OF DAY. The baseline's cumulative volume profile
//              already holds the second half of that, so an interval RVOL is a subtraction:
//              `profile[now] − profile[now − 3]`. Unlike day RVOL it spikes as the move
//              starts and decays afterwards, which is the entire difference between an
//              ignition detector and a post-mortem.
//
//   VELOCITY   percent moved per minute, divided by ATR. In ATR units because 0.4% in three
//              minutes is violent in HDFCBANK and noise in a midcap that ranges 4% a day; a
//              percentage threshold would return the same dozen high-beta names every
//              session regardless of what was happening in them.
//
//   EFFICIENCY |net move| ÷ Σ|leg moves| over the window. This is the "has it gone
//              one-directional" reading. A stock that travels 0.8% net through 0.9% of total
//              movement is trending and its option will track; one that travels 0.8% net
//              through 3% of movement is being fought over, and the same option gets sold
//              back through the spread twice on the way.
//
//   LEG        how long the current directional swing has been running, from an ATR-scaled
//              zigzag. Age is what separates "up 3% and four minutes into a leg" from "up 3%
//              since 09:40 and flat since" — two rows the cumulative factors cannot tell
//              apart and which are opposite trades.
//
// WHAT THIS CANNOT SEE. The poll is every fifteen seconds, so anything that starts and
// finishes inside one interval is invisible, and the price path between two readings is
// assumed to be a straight line for the efficiency calculation. That biases efficiency
// UPWARD — real intra-interval chop is not counted — so the reading is an optimistic bound,
// not a tick-accurate one. Correcting it needs a websocket feed, not a different formula.

import type { MomentumConfig } from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import type { MomentumQuote } from '../data/quotes.js';
import {
  readingAt, readingsSince, type SymbolSessionState, type VwapReading,
} from '../data/session-state.js';
import { curve, fmtPct, fmtX, mix, outcome, squash, unavailable, type MixComponent } from './scoring.js';

/** A pre-breakout base: where price sat before the window being measured. */
export interface BaseReading {
  high: number;
  low: number;
  /** The base's height as a fraction of one ATR. */
  rangeAtr: number | null;
  /** True when that height is under `pulse.compressionAtr` — a coil worth breaking. */
  compressed: boolean;
  /** Which side price has left it on, if either. */
  breaking: 'up' | 'down' | null;
  minutes: number;
}

export interface PulseReading {
  ready: boolean;
  /** Minutes the fast window actually spans — not the configured target. */
  windowMin: number;

  movePct: number | null;
  /** Signed. Fraction of one ATR travelled per minute over the fast window. */
  velocityAtrPerMin: number | null;
  burstRvol: number | null;
  efficiency: number | null;
  acceleration: number | null;

  base: BaseReading | null;

  legDirection: 1 | -1 | null;
  legAgeMin: number | null;
  legMovePct: number | null;
  legMoveAtr: number | null;
  pullback: number | null;
  minutesSinceExtreme: number | null;

  /** Minutes since the session high (or low) was last extended. Null when unmeasurable. */
  minutesSinceDayHigh: number | null;
  minutesSinceDayLow: number | null;

  /** Today's true range ÷ ATR — how much of a normal day is already spent. */
  atrUsed: number | null;
  /** |price − VWAP| ÷ ATR, signed. How stretched an entry here would be. */
  vwapAtr: number | null;

  /** ATR in rupees and percent, carried so callers do not re-derive them. */
  atr: number | null;
  atrPct: number | null;

  note?: string;
}

const EMPTY: PulseReading = {
  ready: false, windowMin: 0, movePct: null, velocityAtrPerMin: null, burstRvol: null,
  efficiency: null, acceleration: null, base: null, legDirection: null, legAgeMin: null,
  legMovePct: null, legMoveAtr: null, pullback: null, minutesSinceExtreme: null,
  minutesSinceDayHigh: null, minutesSinceDayLow: null, atrUsed: null, vwapAtr: null,
  atr: null, atrPct: null,
};

const minutesBetween = (from: number, to: number): number => (to - from) / 60_000;
const round = (v: number, d = 4): number => +v.toFixed(d);

/**
 * Directional persistence over a series of prices.
 *
 * `|last − first| ÷ Σ|consecutive differences|`. One when every step went the same way, and
 * toward zero as the path doubles back on itself. Undefined when nothing moved at all, which
 * is a flat stock rather than a perfectly efficient one — hence null, not 1.
 */
export function efficiencyOf(prices: number[]): number | null {
  if (prices.length < 3) return null;
  let travelled = 0;
  for (let i = 1; i < prices.length; i++) travelled += Math.abs(prices[i] - prices[i - 1]);
  if (travelled <= 0) return null;
  return round(Math.abs(prices[prices.length - 1] - prices[0]) / travelled, 3);
}

/**
 * Interval relative volume — the reading the whole early-signal idea rests on.
 *
 * The denominator is what this stock normally traded BETWEEN THOSE TWO MINUTES of a session,
 * read straight out of the cumulative profile the baseline already built. Comparing against a
 * flat per-minute average instead would report a burst at 09:20 and at 15:20 on every stock
 * on the board, because those minutes are genuinely busier — the same mistake day RVOL avoids
 * by using a profile, applied to a three-minute window.
 */
export function intervalRvol(
  baseline: SymbolBaseline | undefined,
  fromMinute: number,
  toMinute: number,
  actualVolume: number,
): number | null {
  const profile = baseline?.profile;
  if (!profile?.length || actualVolume <= 0) return null;
  if (!(toMinute > fromMinute)) return null;

  const hi = Math.min(toMinute, profile.length - 1);
  const lo = Math.max(0, Math.min(fromMinute, profile.length - 1));
  const expected = profile[hi] - profile[lo];
  // A window in which this stock normally trades nothing has no benchmark. Dividing would
  // report Infinity, which sorts to the top of the board and means nothing there.
  if (!(expected > 0)) return null;

  return round(actualVolume / expected, 2);
}

/** Minutes since `pick` last increased across the ring. Null when it never did. */
function minutesSinceExtended(readings: VwapReading[], pick: (r: VwapReading) => number, up: boolean, nowMs: number): number | null {
  if (readings.length < 2) return null;
  for (let i = readings.length - 1; i > 0; i--) {
    const moved = up ? pick(readings[i]) > pick(readings[i - 1]) : pick(readings[i]) < pick(readings[i - 1]);
    if (moved) return round(minutesBetween(readings[i].at, nowMs), 1);
  }
  // Never extended within the ring: the extreme is at least as old as the ring is long.
  return round(minutesBetween(readings[0].at, nowMs), 1);
}

export function computePulse(
  quote: MomentumQuote,
  sym: SymbolSessionState | undefined,
  baseline: SymbolBaseline | undefined,
  cfg: MomentumConfig,
  nowMs: number,
): PulseReading {
  const t = cfg.thresholds.pulse;
  const atr = baseline?.atr && baseline.atr > 0 ? baseline.atr : null;
  const atrPct = baseline?.atrPct && baseline.atrPct > 0 ? baseline.atrPct : null;

  const fastMs = t.fastWindowMin * 60_000;
  const slowMs = t.slowWindowMin * 60_000;
  const baseMs = t.baseWindowMin * 60_000;

  const fast = readingsSince(sym, fastMs, nowMs);
  const then = readingAt(sym, fastMs, nowMs);

  // Extension and the leg do not need the fast window, so they are computed even on a cold
  // ring: a process that restarted two minutes ago can still say the day is spent.
  const trueRange = Math.max(
    quote.high - quote.low,
    Math.abs(quote.high - quote.prevClose),
    Math.abs(quote.low - quote.prevClose),
  );
  const atrUsed = atr ? round(trueRange / atr, 3) : null;
  const vwapAtr = atr && quote.vwap > 0 ? round((quote.ltp - quote.vwap) / atr, 3) : null;

  const leg = sym?.leg ?? null;
  const legMovePct = leg && leg.startPrice > 0
    ? round(((leg.extremePrice - leg.startPrice) / leg.startPrice) * 100, 3)
    : null;
  const legMoveAtr = leg && atr ? round(Math.abs(leg.extremePrice - leg.startPrice) / atr, 3) : null;
  const legSpan = leg ? Math.abs(leg.extremePrice - leg.startPrice) : 0;
  const pullback = leg && legSpan > 0
    ? round(Math.min(1, Math.abs(leg.extremePrice - quote.ltp) / legSpan), 3)
    : null;

  const shell: PulseReading = {
    ...EMPTY,
    atr,
    atrPct,
    atrUsed,
    vwapAtr,
    legDirection: leg?.direction ?? null,
    legAgeMin: leg ? round(minutesBetween(leg.startAt, nowMs), 1) : null,
    legMovePct,
    legMoveAtr,
    pullback,
    minutesSinceExtreme: leg ? round(minutesBetween(leg.extremeAt, nowMs), 1) : null,
  };

  // A ring whose newest entry is old is not a reading of NOW, and every window measured
  // against it silently stretches: a three-minute velocity computed from a feed that stopped
  // updating six minutes ago is a nine-minute velocity wearing the label of a three-minute
  // one, and the triggers built on it fire on conditions that stopped being true. Checked
  // before the window itself, because a stalled feed and a cold start are different states
  // and reporting the first as the second hides an outage behind a warm-up message.
  const ringAll = sym?.readings ?? [];
  const newest = ringAll[ringAll.length - 1];
  const staleAfterMs = Math.max(fastMs / 2, 60_000);
  if (newest && nowMs - newest.at > staleAfterMs)
    return {
      ...shell,
      note: `quote feed has not updated for ${minutesBetween(newest.at, nowMs).toFixed(1)} minutes — timing layer paused`,
    };

  if (fast.length < t.minReadings || !then || then.ltp <= 0) {
    return {
      ...shell,
      note: `momentum pulse warming up — needs ${t.minReadings} readings across ${t.fastWindowMin} minutes`,
    };
  }

  const windowMin = minutesBetween(then.at, nowMs);
  if (windowMin <= 0) return { ...shell, note: 'no elapsed time between readings yet' };

  // ---- velocity ----
  const movePct = round(((quote.ltp - then.ltp) / then.ltp) * 100, 3);
  const velocityAtrPerMin = atrPct ? round(movePct / atrPct / windowMin, 5) : null;

  // ---- burst ----
  const burstRvol = intervalRvol(baseline, then.minute, fast[fast.length - 1].minute, quote.volume - then.volume);

  // ---- efficiency ----
  const efficiency = efficiencyOf([...fast.map((r) => r.ltp), quote.ltp]);

  // ---- acceleration ----
  // The window before the fast one, so "faster than it was" is a comparison of like with
  // like rather than of a three-minute rate against a ten-minute one.
  const prior = readingAt(sym, fastMs * 2, nowMs);
  const acceleration = prior && prior.ltp > 0 && prior.at < then.at
    ? round(
        movePct / windowMin -
          ((then.ltp - prior.ltp) / prior.ltp) * 100 / Math.max(0.01, minutesBetween(prior.at, then.at)),
        4,
      )
    : null;

  // ---- base ----
  // Everything between the base window and the start of the fast window: where price WAS
  // before the move being measured. Including the fast window would put the breakout inside
  // its own base and no range would ever read as compressed.
  const baseSlice = readingsSince(sym, baseMs, nowMs).filter((r) => r.at <= then.at);
  let base: BaseReading | null = null;
  if (baseSlice.length >= t.minReadings) {
    const high = Math.max(...baseSlice.map((r) => r.ltp));
    const low = Math.min(...baseSlice.map((r) => r.ltp));
    const rangeAtr = atr ? round((high - low) / atr, 3) : null;
    const compressed = rangeAtr !== null && rangeAtr <= t.compressionAtr;
    // A break has to CLEAR the edge, not touch it. Without a buffer, a stock drifting
    // sideways in a two-paise range breaks its own base every other reading — the range is
    // narrow enough to count as compressed precisely because nothing is happening, and one
    // tick out of it would fire an ignition on the quietest stock on the board. The buffer
    // is in ATR so it means the same thing on a ₹200 stock and a ₹4000 one.
    const buffer = atr ? atr * t.breakBufferAtr : (quote.ltp * t.legReversalPctFloor) / 100;
    base = {
      high: round(high, 2),
      low: round(low, 2),
      rangeAtr,
      compressed,
      breaking: quote.ltp > high + buffer ? 'up' : quote.ltp < low - buffer ? 'down' : null,
      minutes: round(minutesBetween(baseSlice[0].at, baseSlice[baseSlice.length - 1].at), 1),
    };
  }

  return {
    ...shell,
    ready: true,
    windowMin: round(windowMin, 2),
    movePct,
    velocityAtrPerMin,
    burstRvol,
    efficiency,
    acceleration,
    base,
    minutesSinceDayHigh: minutesSinceExtended(ringAll, (r) => r.high, true, nowMs),
    minutesSinceDayLow: minutesSinceExtended(ringAll, (r) => r.low, false, nowMs),
    note: atrPct ? undefined : 'no ATR baseline — velocity is unscored and the leg uses a percentage reversal',
  };
}

/* --------------------------------------------------------------------- the factor --- */

export function pulseFactor(reading: PulseReading, cfg: MomentumConfig) {
  const weight = cfg.weights.momentumPulse;
  const t = cfg.thresholds.pulse;

  if (!reading.ready)
    return unavailable('momentumPulse', weight, reading.note ?? 'not enough readings yet');

  const components: MixComponent[] = [
    {
      key: 'burst',
      weight: t.mix.burst,
      score: reading.burstRvol === null ? null : curve(reading.burstRvol, t.burstRvol),
    },
    {
      key: 'velocity',
      weight: t.mix.velocity,
      score: reading.velocityAtrPerMin === null ? null : curve(Math.abs(reading.velocityAtrPerMin), t.velocityAtrPerMin),
    },
    {
      key: 'efficiency',
      weight: t.mix.efficiency,
      score: reading.efficiency === null ? null : curve(reading.efficiency, t.efficiency),
    },
  ];
  const m = mix(components);

  // Direction is the velocity's sign, scaled by how persistent the path was. A move that
  // netted +0.6% through 2% of thrashing is not a 0.6% directional statement, and voting it
  // as one is how a chopping stock ends up ranked as a clean trend.
  const raw = reading.velocityAtrPerMin === null
    ? 0
    : squash(reading.velocityAtrPerMin, t.fullScaleVelocityAtr);
  const bias = reading.efficiency === null ? raw : raw * reading.efficiency;

  const reasons = [];
  const up = (reading.movePct ?? 0) >= 0;

  reasons.push({
    ok: Math.abs(reading.velocityAtrPerMin ?? 0) >= (t.velocityAtrPerMin[1]?.at ?? 0.008),
    text: `${fmtPct(reading.movePct ?? 0)} in the last ${reading.windowMin.toFixed(1)}m${
      reading.velocityAtrPerMin === null ? '' : ` — ${(Math.abs(reading.velocityAtrPerMin) * 100).toFixed(1)}% of an ATR per minute`
    }`,
  });

  if (reading.burstRvol !== null)
    reasons.push({
      ok: reading.burstRvol >= (cfg.signal.minBurstRvol ?? 1.6),
      text: `${fmtX(reading.burstRvol)} its normal volume for these minutes${
        reading.burstRvol >= 2.5 ? ' — size arriving now, not earlier' : ''
      }`,
    });

  if (reading.efficiency !== null)
    reasons.push({
      ok: reading.efficiency >= (t.efficiency[2]?.at ?? 0.65),
      text:
        reading.efficiency >= (t.efficiency[2]?.at ?? 0.65)
          ? `Moving one-directionally — ${(reading.efficiency * 100).toFixed(0)}% of the movement went ${up ? 'up' : 'down'}`
          : `Choppy — only ${(reading.efficiency * 100).toFixed(0)}% of the movement was directional`,
    });

  if (reading.legAgeMin !== null)
    reasons.push({
      ok: reading.legAgeMin <= cfg.signal.maxTriggerAgeMin,
      text: `Current ${reading.legDirection === 1 ? 'up' : 'down'} leg is ${reading.legAgeMin.toFixed(0)}m old${
        reading.legMovePct === null ? '' : ` and ${fmtPct(reading.legMovePct)}`
      }`,
    });

  return outcome({
    key: 'momentumPulse',
    weight,
    score: m.score,
    bias,
    metrics: {
      windowMin: reading.windowMin,
      movePct: reading.movePct,
      velocityAtrPerMin: reading.velocityAtrPerMin,
      burstRvol: reading.burstRvol,
      efficiency: reading.efficiency,
      acceleration: reading.acceleration,
      legAgeMin: reading.legAgeMin,
      legMovePct: reading.legMovePct,
      legMoveAtr: reading.legMoveAtr,
      pullbackFromExtreme: reading.pullback,
      minutesSinceExtreme: reading.minutesSinceExtreme,
      baseHigh: reading.base?.high ?? null,
      baseLow: reading.base?.low ?? null,
      baseRangeAtr: reading.base?.rangeAtr ?? null,
      baseCompressed: reading.base?.compressed ?? null,
      atrUsed: reading.atrUsed,
      vwapAtr: reading.vwapAtr,
    },
    reasons,
    note: m.missing.length ? `no ${m.missing.join(' or ')} reading — scored on what was measurable` : reading.note,
  });
}
