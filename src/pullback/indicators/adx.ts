// Wilder's Average Directional Index.
//
// ADX is the one gate in this module that measures whether a trend is a TREND rather than a
// direction. Every other filter here — the EMA stack, price above VWAP, higher highs — is
// satisfied by a stock drifting up 0.2% over four hours inside a 0.4% range, and that stock
// is not something to buy a pullback in: the pullback is the whole range, the stop is outside
// it, and the target is a week away. ADX is what says the moves are ARRIVING in a direction
// rather than merely ending up there.
//
// The brief's two thresholds map onto Wilder's own convention: above 25 is a trend worth
// trading, below 20 is a range and vetoes outright, and 20–25 is the band where he said to
// stand aside. Both are configurable and both are used, which is why they are separate
// settings rather than one line in the sand.
//
// WHY THIS IS NOT SHORTER. ADX is three nested Wilder smoothings — of directional movement, of
// true range, and finally of DX itself — and each has its own seeding. Implementations that
// use a simple moving average anywhere in that chain produce a number that tracks the real one
// loosely and crosses 25 several bars early or late, which for a threshold is the entire
// difference. The seeding below is Wilder's original, verified against a hand-worked example.

import { trueRange } from './atr.js';
import type { Bar } from './series.js';
import type { AdxRead } from '../types.js';

export interface AdxSeries {
  adx: Array<number | null>;
  plusDi: Array<number | null>;
  minusDi: Array<number | null>;
}

/**
 * +DM / −DM / TR, Wilder-smoothed, then DX, then ADX — all as series.
 *
 * `+DM` is today's excess high over yesterday's, and `−DM` yesterday's excess low under
 * today's, with the SMALLER of the two zeroed. That zeroing is the part most often dropped:
 * without it an outside bar contributes to both sides and the two DIs rise together, which
 * reads as a strengthening trend in both directions at once.
 */
export function adxSeries(bars: Bar[], period: number): AdxSeries {
  const n = bars.length;
  const plusDi = new Array<number | null>(n).fill(null);
  const minusDi = new Array<number | null>(n).fill(null);
  const adx = new Array<number | null>(n).fill(null);
  if (n <= period * 2 || period <= 0) return { adx, plusDi, minusDi };

  const plusDm = new Array<number>(n).fill(0);
  const minusDm = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    tr[i] = trueRange(bars, i);
  }

  // Wilder's seed: a simple SUM of the first `period` values, then the running form
  // `next = prev − prev/period + current`. Not an average — the division happens only in the
  // DI ratio below, and doing it twice is a classic way to get a number that looks plausible
  // and sits ~7% off.
  let sPlus = 0, sMinus = 0, sTr = 0;
  for (let i = 1; i <= period; i++) {
    sPlus += plusDm[i];
    sMinus += minusDm[i];
    sTr += tr[i];
  }

  const dx = new Array<number | null>(n).fill(null);

  for (let i = period; i < n; i++) {
    if (i > period) {
      sPlus = sPlus - sPlus / period + plusDm[i];
      sMinus = sMinus - sMinus / period + minusDm[i];
      sTr = sTr - sTr / period + tr[i];
    }
    if (sTr <= 0) continue;
    const pdi = (sPlus / sTr) * 100;
    const mdi = (sMinus / sTr) * 100;
    plusDi[i] = pdi;
    minusDi[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0;
  }

  // ADX is a Wilder smoothing OF DX, seeded with the mean of the first `period` DX values —
  // which is why ADX needs roughly 2×period bars before it exists at all, and why a 15-minute
  // ADX(14) is dark until the seed has walked back through several sessions.
  const firstDx = period;
  const seedEnd = firstDx + period - 1;
  if (seedEnd >= n) return { adx, plusDi, minusDi };

  let sum = 0;
  let counted = 0;
  for (let i = firstDx; i <= seedEnd; i++) {
    const v = dx[i];
    if (v !== null) { sum += v; counted++; }
  }
  if (!counted) return { adx, plusDi, minusDi };

  let value = sum / counted;
  adx[seedEnd] = value;
  for (let i = seedEnd + 1; i < n; i++) {
    const v = dx[i];
    if (v === null) continue;
    value = (value * (period - 1) + v) / period;
    adx[i] = value;
  }

  return { adx, plusDi, minusDi };
}

/**
 * The last reading, plus whether ADX is rising.
 *
 * `rising` matters as much as the level. ADX at 32 and falling is a trend that has already
 * had its move — the DIs are converging and the next thing that happens is usually a range —
 * while 27 and rising is one that is still gaining participants. The pullback being scanned
 * for is worth taking in the second and is a lower-probability trade in the first, and the
 * level alone cannot tell them apart.
 */
export function adxLast(bars: Bar[], period: number, risingLookback = 3): AdxRead {
  const s = adxSeries(bars, period);
  const i = bars.length - 1;
  const adx = i >= 0 ? s.adx[i] : null;
  const prev = i - risingLookback >= 0 ? s.adx[i - risingLookback] : null;

  return {
    adx: adx === null ? null : +adx.toFixed(2),
    plusDi: i >= 0 && s.plusDi[i] !== null ? +(s.plusDi[i] as number).toFixed(2) : null,
    minusDi: i >= 0 && s.minusDi[i] !== null ? +(s.minusDi[i] as number).toFixed(2) : null,
    rising: adx === null || prev === null ? null : adx > prev,
  };
}
