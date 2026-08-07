// Wilder's ATR, on intraday bars.
//
// `momentum/data/baseline.ts` already computes an ATR and it is the wrong one for this module:
// it is a DAILY ATR, over daily bars, and it answers "how far does this stock normally travel
// in a session". Everything here needs "how far does this stock normally travel in a 5-minute
// bar", which is a different number by a factor of roughly √75 and is what every distance in
// this module is denominated in — the flat-EMA threshold, the pullback depth, the stop buffer,
// the zone width. Reusing the daily figure would make every one of those about seventy-five
// times too loose, and the symptom would be a scanner that never vetoes anything.
//
// THE GAP IS INCLUDED, AND HERE THAT IS RIGHT. True range takes `|high − prevClose|` into
// account, so the 09:15 bar of a gapping stock carries the gap. On a daily ATR that is a
// distortion the momentum module deliberately excludes from its extension budget; on an
// intraday ATR it is the correct reading, because a stock that gapped 3% genuinely is moving
// in larger increments today and every stop drawn off this should be wider for it.

import type { Bar } from './series.js';

/** True range for bar `i`. The first bar has no previous close, so it is high − low. */
export function trueRange(bars: Bar[], i: number): number {
  const b = bars[i];
  if (i === 0) return b.high - b.low;
  const prevClose = bars[i - 1].close;
  return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
}

/**
 * Wilder ATR as a series, aligned to `bars` index-for-index.
 *
 * Null until index `period`, where it is seeded with the simple mean of the first `period`
 * true ranges, then smoothed by Wilder's recursion. That recursion is NOT a rolling mean —
 * `atr = (atr·(n−1) + tr) / n` has a much longer memory than an n-bar SMA of TR, and the two
 * differ by enough to move a stop by a meaningful fraction of a percent.
 */
export function atrSeries(bars: Bar[], period: number): Array<number | null> {
  const out = new Array<number | null>(bars.length).fill(null);
  if (bars.length <= period || period <= 0) return out;

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(bars, i);
  let atr = sum / period;
  out[period] = atr;

  for (let i = period + 1; i < bars.length; i++) {
    atr = (atr * (period - 1) + trueRange(bars, i)) / period;
    out[i] = atr;
  }
  return out;
}
