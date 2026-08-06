// Exponential moving averages, and the only reading of them that matters — the slope.
//
// SEEDING IS NOT A DETAIL. There are two conventions for starting an EMA and they disagree
// for a surprisingly long time:
//
//   ema[0] = price[0]          converges, but is dominated by ONE bar for the first ~period
//                              bars. On a 200 EMA that is 200 bars of a number that is mostly
//                              a single opening print.
//   ema[period-1] = SMA(...)   the textbook seed, and what TradingView, Upstox charts and
//                              every Indian charting platform use.
//
// The second is used here, because the whole module is a comparison against what the trader is
// looking at. An EMA that is right eventually but wrong for the first hour of every session is
// wrong exactly when the opening drive is being scanned.
//
// AND THE VALUE BEFORE THE SEED IS `null`, NOT THE PRICE. A 200 EMA on a 15-minute chart needs
// 200 bars — eight sessions — and before it has them there is no 200 EMA. Returning the price
// instead would make "price above the 200 EMA" true for every symbol on the first morning
// after a deploy, which is a fabricated regime filter passing on 215 stocks at once.

import type { Bar } from './series.js';

/**
 * The whole EMA series for `period`, aligned to `values` index-for-index.
 *
 * `out[i]` is null until index `period − 1`, where it is the simple mean of the first
 * `period` values, and from there follows the standard recursion. Returning the SERIES rather
 * than the last value is what lets the slope below be measured over any lookback without
 * recomputing, and what lets the backtest walk bar by bar in one pass.
 */
export function emaSeries(values: number[], period: number): Array<number | null> {
  const out = new Array<number | null>(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** The EMA of the closes, as a series. The form every caller here actually wants. */
export const emaOfCloses = (bars: Bar[], period: number): Array<number | null> =>
  emaSeries(bars.map((b) => b.close), period);

/** Advance one EMA by one value. The incremental form, for the backtest's inner loop. */
export const emaStep = (prev: number, value: number, period: number): number => {
  const k = 2 / (period + 1);
  return value * k + prev * (1 - k);
};

/**
 * How fast a series is moving, in ATR PER BAR.
 *
 * A least-squares fit over `lookback` bars rather than (last − first) ÷ lookback. Two-point
 * slopes on an EMA are dominated by whichever end happened to land on a spike, and the flat-EMA
 * veto is a threshold — so the noise on the estimator turns directly into the veto firing and
 * clearing on alternate cycles for stocks sitting near the line.
 *
 * The ATR normalisation is what makes one threshold work across the universe. A 9 EMA rising
 * ₹0.40 a bar is a stampede in NHPC and a rounding error in MARUTI; the same move expressed as
 * 0.18 ATR per bar is the same statement about both.
 */
export function slopeAtrPerBar(
  series: Array<number | null>,
  atr: number | null,
  lookback: number,
): number | null {
  if (!atr || !(atr > 0)) return null;

  const tail: number[] = [];
  for (let i = series.length - 1; i >= 0 && tail.length < lookback; i--) {
    const v = series[i];
    if (v === null) break; // a null inside the window means the average is not warm here
    tail.push(v);
  }
  if (tail.length < Math.min(3, lookback)) return null;
  tail.reverse();

  const n = tail.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += tail[i];
    sxx += i * i;
    sxy += i * tail[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return +(((n * sxy - sx * sy) / denom) / atr).toFixed(5);
}

/**
 * A running session-anchored VWAP as a series, one value per bar.
 *
 * Anchored to the SESSION, so it resets at every day boundary — that is what "VWAP" means on
 * an intraday chart and it is why this cannot be a rolling window. A continuous VWAP across
 * sessions drifts toward a multi-day average and stops being the line the whole desk is
 * watching, which is the only property that makes VWAP worth having in a pullback zone.
 *
 * Accumulated from the bar's own `turnover` (Σ typical price × volume) rather than from
 * `close × volume`: on a 15-minute bar those differ by most of the bar's range, and the error
 * compounds across the session in whichever direction the day is trending — so a VWAP built
 * from closes sits systematically BELOW a rising day's true VWAP, and the pullback zone it
 * defines is one that price never reaches.
 */
export function vwapSeries(bars: Bar[]): Array<number | null> {
  const out = new Array<number | null>(bars.length).fill(null);
  let day = '';
  let vol = 0;
  let turn = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.day !== day) {
      day = b.day;
      vol = 0;
      turn = 0;
    }
    vol += b.volume;
    turn += b.turnover;
    out[i] = vol > 0 ? turn / vol : null;
  }
  return out;
}
