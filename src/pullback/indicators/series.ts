// Bars, and how one timeframe becomes another.
//
// Everything downstream of this file is a pure function of a `Bar[]`, which is what makes the
// live scanner and the backtest run the SAME code: the scanner's bars come from a quote poll
// folded into aggregators, the backtest's come off Upstox's historical endpoint, and neither
// indicator nor strategy can tell the difference. A backtest that shares only its formulas
// with the live engine is testing a second implementation of the strategy, which is the one
// thing a backtest must not do.
//
// TWO PROPERTIES ARE LOAD-BEARING AND BOTH COST SOMETHING TO KEEP:
//
//   BARS ARE ALIGNED TO 09:15, NOT TO THE HOUR. NSE opens at 09:15, so the session's 15-minute
//   bars are 09:15–09:30, 09:30–09:45 and so on. Bucketing on wall-clock time instead — which
//   is what `floor(epoch / 900000)` does — puts the boundaries at 09:15, 09:30, 09:45 by
//   coincidence for 15 and 5 and 1, and at 09:15, 09:18 vs 09:16, 09:19 for 3, so a 3-minute
//   chart drawn here would disagree with every chart in India by one minute. Bucketing on
//   MINUTE OF SESSION makes the alignment exact for every interval by construction.
//
//   A BAR BELONGS TO ONE SESSION. Resampling across a day boundary would merge 15:29 into
//   09:15 and produce one bar with an overnight gap inside it, which prints as a huge range,
//   poisons ATR for the next fourteen bars and shows up as a phantom breakout. Every grouping
//   below is keyed by `${day}#${bucket}` rather than by bucket alone.

import { candleDay, candleMinute } from '../../momentum/session.js';
import type { Candle } from '../../momentum/data/candles.js';

export interface Bar {
  /** Bar OPEN time, epoch ms. The convention everywhere in this module. */
  at: number;
  /** IST calendar day, YYYY-MM-DD. */
  day: string;
  /** Minute of session the bar opens on. 0 = the 09:15 bar. */
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Σ(typical price × volume) for the bar — what a VWAP is accumulated from. */
  turnover: number;
  /**
   * True when this bar was assembled from quote polls rather than from an exchange candle.
   *
   * Carried rather than hidden because it is a real difference in precision: a poll-built bar
   * has an exact close (the last print seen) and an APPROXIMATE high and low, since anything
   * that happened between two polls was never observed. Close-based indicators — every EMA
   * here — are unaffected. ATR and ADX read the high and the low and will run slightly narrow
   * on these, which is why the resync tier exists and why this flag is what tells the UI
   * whether it has run yet.
   */
  synthetic?: boolean;
}

/** Where a timestamp falls, as a stable key. Day-scoped so sessions never merge. */
export const bucketKey = (day: string, minute: number, tf: number): string =>
  `${day}#${Math.floor(minute / tf)}`;

/** The minute-of-session a bucket opens on. */
export const bucketMinute = (minute: number, tf: number): number => Math.floor(minute / tf) * tf;

/** An Upstox 1-minute candle as a Bar. Pre-open and post-close prints are the caller's to drop. */
export function fromCandle(c: Candle): Bar {
  const typical = (c.high + c.low + c.close) / 3;
  return {
    at: Date.parse(c.stamp),
    day: c.day,
    minute: c.minute,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    turnover: typical * c.volume,
  };
}

/**
 * Fold `src` into `tf`-minute bars, oldest first.
 *
 * `src` must be 1-minute bars, oldest first, from one or more complete sessions. Bars outside
 * the regular session (`minute < 0`) are dropped rather than bucketed: the pre-open auction
 * prints at 09:07 with the whole day's indicative volume attached, and letting it into the
 * 09:15 bar makes every volume-expansion test on the first bar of the day pass.
 */
export function resample(src: Bar[], tf: number): Bar[] {
  if (tf <= 1) return src.filter((b) => b.minute >= 0);

  const out: Bar[] = [];
  let key = '';
  let cur: Bar | null = null;

  for (const b of src) {
    if (b.minute < 0) continue;
    const k = bucketKey(b.day, b.minute, tf);
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = {
        at: b.at,
        day: b.day,
        minute: bucketMinute(b.minute, tf),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        turnover: b.turnover,
        synthetic: b.synthetic,
      };
      continue;
    }
    const c = cur as Bar;
    c.high = Math.max(c.high, b.high);
    c.low = Math.min(c.low, b.low);
    c.close = b.close;
    c.volume += b.volume;
    c.turnover += b.turnover;
    // One synthetic minute makes the whole bar synthetic: its high and low are now only as
    // good as the polling that produced that minute.
    if (b.synthetic) c.synthetic = true;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Extend a bar with one observation, or start the next one.
 *
 * This is the live path — one call per symbol per quote poll. It returns the bar that was
 * CLOSED by this observation, or null when the observation merely extended the forming one,
 * so the caller knows exactly when an indicator may be advanced. Advancing on every poll
 * instead is what makes a live scanner disagree with the chart: a 15-minute EMA recomputed
 * sixty times inside its own bar shows a trend appearing and vanishing within one candle.
 */
export interface Aggregator {
  tf: number;
  /** The bar being built. Null before the first observation of a session. */
  forming: Bar | null;
  key: string;
}

export const newAggregator = (tf: number): Aggregator => ({ tf, forming: null, key: '' });

export interface Observation {
  at: number;
  day: string;
  minute: number;
  price: number;
  /** Session-cumulative traded quantity. The delta against the last reading is the bar's. */
  cumulativeVolume: number;
  /** Session-cumulative rupee turnover. Same treatment. */
  cumulativeTurnover: number;
  /** Session high and low as of this reading, used to widen a bar the poll may have missed. */
  sessionHigh?: number;
  sessionLow?: number;
}

/**
 * Fold one reading in.
 *
 * The volume attributed to a bar is the DELTA of the session-cumulative figure, which is exact
 * at the poll boundaries and is the only honest way to split a cumulative counter across bars.
 * The first reading of a bar has no delta to take — its predecessor belongs to the previous
 * bar — so the bar opens with zero volume and accrues from the second reading. That
 * under-counts the first fraction of a poll interval, and is stated here rather than papered
 * over with an estimate.
 */
export function observeBar(agg: Aggregator, o: Observation, prev: Observation | null): Bar | null {
  if (o.minute < 0 || !(o.price > 0)) return null;

  const k = bucketKey(o.day, o.minute, agg.tf);
  const dVol = prev && o.cumulativeVolume >= prev.cumulativeVolume ? o.cumulativeVolume - prev.cumulativeVolume : 0;
  const dTurn = prev && o.cumulativeTurnover >= prev.cumulativeTurnover ? o.cumulativeTurnover - prev.cumulativeTurnover : 0;

  if (k !== agg.key || !agg.forming) {
    const closed = agg.forming;
    agg.key = k;
    agg.forming = {
      at: o.at,
      day: o.day,
      minute: bucketMinute(o.minute, agg.tf),
      open: o.price,
      high: o.price,
      low: o.price,
      close: o.price,
      volume: dVol,
      turnover: dTurn,
      synthetic: true,
    };
    return closed;
  }

  const b = agg.forming;
  b.high = Math.max(b.high, o.price);
  b.low = Math.min(b.low, o.price);
  b.close = o.price;
  b.volume += dVol;
  b.turnover += dTurn;
  return null;
}

/**
 * Merge exact exchange bars over poll-built ones for the same buckets.
 *
 * The resync tier's whole job. Anything the exchange has a bar for wins outright — its high
 * and low are the real ones — and anything it does not (the bar still forming) is kept. Bars
 * are keyed on `day` plus `minute` rather than on `at`, because a poll-built bar is stamped
 * with the instant of the first poll INSIDE the bucket and an exchange bar with the bucket's
 * own boundary, so the two are minutes apart while describing the same candle.
 */
export function mergeExact(existing: Bar[], exact: Bar[]): Bar[] {
  if (!exact.length) return existing;
  const byKey = new Map<string, Bar>();
  for (const b of existing) byKey.set(`${b.day}#${b.minute}`, b);
  for (const b of exact) byKey.set(`${b.day}#${b.minute}`, b);
  return [...byKey.values()].sort((a, b) => (a.day === b.day ? a.minute - b.minute : a.day < b.day ? -1 : 1));
}

/** Keep at most `max` bars, dropping the oldest. Mutates, because these arrays are hot. */
export function trim(bars: Bar[], max: number): Bar[] {
  if (bars.length > max) bars.splice(0, bars.length - max);
  return bars;
}

/* --------------------------------------------------------------------- small maths --- */

export const last = <T>(a: T[]): T | null => (a.length ? a[a.length - 1] : null);

export const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * Piecewise-linear interpolation over a knot list — the one scoring primitive this module has.
 *
 * Identical in behaviour to `momentum/services/scoring.ts` and deliberately re-implemented
 * rather than imported: it is six lines, and importing it would tie this module's scoring to
 * another module's internals for no benefit. Readings below the first knot or above the last
 * clamp to that end, so a curve never has to enumerate the tails.
 */
export function curve(knots: Array<{ at: number; score: number }>, value: number): number {
  if (!knots.length) return 0;
  if (value <= knots[0].at) return knots[0].score;
  const end = knots[knots.length - 1];
  if (value >= end.at) return end.score;
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1];
    const b = knots[i];
    if (value <= b.at) {
      const span = b.at - a.at;
      return span === 0 ? b.score : a.score + ((value - a.at) / span) * (b.score - a.score);
    }
  }
  return end.score;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Round for transport. Every number crossing the API boundary goes through one of these. */
export const r2 = (v: number): number => +v.toFixed(2);
export const r3 = (v: number): number => +v.toFixed(3);
export const r4 = (v: number): number => +v.toFixed(4);
