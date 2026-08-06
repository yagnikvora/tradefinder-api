// Swing structure — higher highs and higher lows, as a sequence rather than as two booleans.
//
// The brief asks for "Higher High" and "Higher Low" in the trend conditions. Taken literally
// that is a one-line comparison against the previous bar, and it is close to meaningless: on a
// 5-minute chart a stock in a hard downtrend makes a higher high roughly every fourth bar. The
// reading that means what the brief intends is about SWINGS — the last two confirmed swing
// highs stepping up, and the last two confirmed swing lows stepping up with them.
//
// SWINGS ARE FOUND WITH FRACTALS AND THAT COSTS A LAG. A bar is a swing high when `strength`
// bars either side are lower, which means the most recent `strength` bars can never be swing
// points yet — the confirmation has not happened. That lag is real and is not papered over: a
// pullback low is by construction unconfirmed at the moment the entry is taken, so the stop
// logic in `risk.service.ts` uses the running low of the retracement, and only the structure
// TEST uses these confirmed pivots. Conflating the two would either put the stop at a level
// that does not exist yet or test structure against a swing that is still forming.
//
// `strength` of 2 is used throughout: two bars either side. Three is the other common choice
// and is noticeably slower on a 3-minute chart — it finds four or five swings a session where
// two finds ten — which for a scanner looking for the third pullback of a trend day is the
// difference between seeing it and describing it afterwards.

import type { Bar } from './series.js';
import type { Pivot, StructureRead } from '../types.js';

/**
 * Confirmed fractal pivots, oldest first.
 *
 * A bar can be both a swing high and a swing low in a very quiet stretch (all neighbours
 * inside it); both are emitted, because suppressing one would silently bias the structure read
 * toward whichever was checked first.
 */
export function pivots(bars: Bar[], strength = 2): Pivot[] {
  const out: Pivot[] = [];
  if (bars.length < strength * 2 + 1) return out;

  for (let i = strength; i < bars.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, at: bars[i].at, price: bars[i].high, kind: 'high' });
    if (isLow) out.push({ index: i, at: bars[i].at, price: bars[i].low, kind: 'low' });
  }
  return out;
}

/**
 * How many consecutive swing steps have gone the same way.
 *
 * Counted over the alternating high/low sequence, so a clean staircase of HH, HL, HH, HL
 * scores 4 and a stock that made one higher high after three lower ones scores 1. This is the
 * reading the score's structure component is built on, and it is the reason a single spike
 * cannot buy a stock a full structure score.
 */
function countSteps(highs: Pivot[], lows: Pivot[], direction: 1 | -1): number {
  let steps = 0;
  for (let i = highs.length - 1; i > 0; i--) {
    const better = direction === 1 ? highs[i].price > highs[i - 1].price : highs[i].price < highs[i - 1].price;
    if (!better) break;
    steps++;
  }
  for (let i = lows.length - 1; i > 0; i--) {
    const better = direction === 1 ? lows[i].price > lows[i - 1].price : lows[i].price < lows[i - 1].price;
    if (!better) break;
    steps++;
  }
  return steps;
}

/**
 * Read the structure.
 *
 * `direction` is the trend being TESTED, not one this function infers. That is deliberate: the
 * caller already knows which way the EMA stack points, and a structure reader that picked its
 * own direction would happily report a textbook downtrend structure on a stock the rest of the
 * model has decided is bullish — two contradictory readings on the same row, with nothing to
 * say which is the answer.
 */
export function readStructure(bars: Bar[], direction: 1 | -1, strength = 2): StructureRead {
  const empty: StructureRead = {
    higherHigh: false, higherLow: false, lowerHigh: false, lowerLow: false, steps: 0,
    lastSwingHigh: null, lastSwingLow: null, priorSwingHigh: null, priorSwingLow: null,
  };

  if (bars.length < strength * 2 + 3)
    return { ...empty, note: `only ${bars.length} bars — a swing needs ${strength * 2 + 1} to confirm` };

  const p = pivots(bars, strength);
  const highs = p.filter((x) => x.kind === 'high');
  const lows = p.filter((x) => x.kind === 'low');

  if (highs.length < 2 || lows.length < 2)
    return {
      ...empty,
      lastSwingHigh: highs[highs.length - 1] ?? null,
      lastSwingLow: lows[lows.length - 1] ?? null,
      note: 'fewer than two confirmed swings each side — structure is not yet a sequence',
    };

  const lastHigh = highs[highs.length - 1];
  const priorHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const priorLow = lows[lows.length - 2];

  return {
    higherHigh: lastHigh.price > priorHigh.price,
    higherLow: lastLow.price > priorLow.price,
    lowerHigh: lastHigh.price < priorHigh.price,
    lowerLow: lastLow.price < priorLow.price,
    steps: countSteps(highs, lows, direction),
    lastSwingHigh: lastHigh,
    lastSwingLow: lastLow,
    priorSwingHigh: priorHigh,
    priorSwingLow: priorLow,
  };
}

/**
 * The extreme of the last `lookback` bars — the running high or low a stop hides behind.
 *
 * Used instead of a confirmed pivot for the stop, for the reason in the header: at the moment
 * a pullback confirms, its low is `strength` bars from being a confirmed swing and putting the
 * stop at the last CONFIRMED swing would put it a full leg away.
 */
export function runningExtreme(bars: Bar[], lookback: number, kind: 'high' | 'low'): { price: number; at: number } | null {
  const slice = bars.slice(-Math.max(1, lookback));
  if (!slice.length) return null;
  let best = slice[0];
  for (const b of slice) {
    if (kind === 'high' ? b.high > best.high : b.low < best.low) best = b;
  }
  return { price: kind === 'high' ? best.high : best.low, at: best.at };
}

/**
 * Total range of the last `n` bars as a multiple of ATR — the consolidation detector.
 *
 * The brief's "price inside consolidation" veto. Expressed as the whole window's high-to-low
 * span rather than as a mean bar range, because those say different things: a stock alternating
 * ±1 ATR bars has a large mean range and no net span, and it is exactly the tape that shreds a
 * pullback entry. The span is what says "nothing is being decided here".
 */
export function rangeAtr(bars: Bar[], n: number, atr: number | null): number | null {
  if (!atr || !(atr > 0)) return null;
  const slice = bars.slice(-Math.max(2, n));
  if (slice.length < 2) return null;
  let hi = slice[0].high;
  let lo = slice[0].low;
  for (const b of slice) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  return +((hi - lo) / atr).toFixed(3);
}
