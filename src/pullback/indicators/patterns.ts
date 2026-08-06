// The confirmation candle.
//
// This is the smallest file in the module and the one that decides the entry price, so it is
// worth being explicit about what it is and is not doing.
//
// A candlestick pattern in isolation has no edge worth trading — a hammer appears several times
// a session on any liquid stock and means nothing on its own. What it is used for here is
// narrower and defensible: given that a stock is ALREADY in a measured trend, has ALREADY
// retraced into the EMA band, and volume has ALREADY expanded, the candle is the timestamp.
// It says the retracement stopped on THIS bar rather than at some point in the next hour, and
// that timestamp is what turns a zone into an entry with a stop under it.
//
// So every test below is deliberately strict about the BODY and permissive about the wick. A
// doji at the 20 EMA is the market failing to decide, and treating it as a turn is how a
// pullback scanner ends up buying the middle of the retracement.

import type { Bar } from './series.js';
import type { CandlePattern } from '../types.js';

const body = (b: Bar): number => Math.abs(b.close - b.open);
const range = (b: Bar): number => Math.max(1e-9, b.high - b.low);
const upperWick = (b: Bar): number => b.high - Math.max(b.open, b.close);
const lowerWick = (b: Bar): number => Math.min(b.open, b.close) - b.low;

/** Body as a share of the bar's range, 0…1. The doji filter's one input. */
export const bodyRatio = (b: Bar): number => body(b) / range(b);

export const isBullish = (b: Bar): boolean => b.close > b.open;
export const isBearish = (b: Bar): boolean => b.close < b.open;

export interface PatternOptions {
  /** Body ÷ range floor for anything to count as directional at all. */
  minBodyRatio: number;
  /** Wick ÷ body multiple for a hammer / shooting star. Wilder's convention is 2. */
  wickMultiple: number;
  /** Body ÷ range above this is a "strong" candle with no other structure needed. */
  strongBodyRatio: number;
}

export const DEFAULT_PATTERN_OPTIONS: PatternOptions = {
  minBodyRatio: 0.45,
  wickMultiple: 2,
  strongBodyRatio: 0.7,
};

/**
 * Classify the bar at `i` as a reversal candle in `direction`, or `none`.
 *
 * Ordered strongest-evidence-first and returns the FIRST match, so a bar that is both an
 * engulfing and a strong body reports the engulfing — the more specific claim, and the one a
 * reader can check against their own chart.
 *
 * `direction` is +1 looking for a bullish turn, −1 for bearish. Passing the direction in
 * rather than inferring it is the same decision `structure.ts` makes and for the same reason:
 * the caller already knows which way the trend goes, and a pattern reader that chose its own
 * would cheerfully confirm a bearish reversal inside a bullish pullback.
 */
export function classify(
  bars: Bar[],
  i: number,
  direction: 1 | -1,
  opts: PatternOptions = DEFAULT_PATTERN_OPTIONS,
): CandlePattern {
  if (i < 1 || i >= bars.length) return 'none';
  const b = bars[i];
  const p = bars[i - 1];
  const br = bodyRatio(b);

  if (direction === 1) {
    // Engulfing: this bar's body covers the previous one's, and the previous one was against
    // us. The classic form also requires the open below the prior close; that is relaxed to
    // "body covers body" because Indian intraday bars gap inside the session constantly and
    // the strict form finds almost nothing on a 3-minute chart.
    if (isBullish(b) && isBearish(p) && b.close >= p.open && b.open <= p.close && br >= opts.minBodyRatio)
      return 'bullishEngulfing';

    // Hammer: a long lower wick rejecting the level, with the close in the upper part of the
    // bar. The body may be small — that is the point of the pattern — so `minBodyRatio` is
    // deliberately not applied here.
    if (lowerWick(b) >= opts.wickMultiple * Math.max(body(b), range(b) * 0.05) && upperWick(b) <= body(b) && b.close > b.low + range(b) * 0.6)
      return 'hammer';

    // Piercing: opened below the prior low-ish and closed back through the midpoint of the
    // prior bar's body. Weaker than engulfing and stronger than a strong body alone.
    if (isBullish(b) && isBearish(p) && b.open < p.close && b.close > (p.open + p.close) / 2 && br >= opts.minBodyRatio)
      return 'piercing';

    if (isBullish(b) && br >= opts.strongBodyRatio) return 'strongBody';

    // Inside-bar break: the previous bar coiled inside the one before it, and this one left
    // that range upward. Not a reversal candle in the textbook sense, and included because a
    // pullback that ends in compression rather than in a wick is common on the 15-minute
    // chart and produces no other pattern at all.
    if (i >= 2 && bars[i - 1].high <= bars[i - 2].high && bars[i - 1].low >= bars[i - 2].low && b.close > bars[i - 1].high)
      return 'insideBarBreak';

    return 'none';
  }

  if (isBearish(b) && isBullish(p) && b.close <= p.open && b.open >= p.close && br >= opts.minBodyRatio)
    return 'bearishEngulfing';

  if (upperWick(b) >= opts.wickMultiple * Math.max(body(b), range(b) * 0.05) && lowerWick(b) <= body(b) && b.close < b.high - range(b) * 0.6)
    return 'shootingStar';

  if (isBearish(b) && isBullish(p) && b.open > p.close && b.close < (p.open + p.close) / 2 && br >= opts.minBodyRatio)
    return 'darkCloud';

  if (isBearish(b) && br >= opts.strongBodyRatio) return 'strongBody';

  if (i >= 2 && bars[i - 1].high <= bars[i - 2].high && bars[i - 1].low >= bars[i - 2].low && b.close < bars[i - 1].low)
    return 'insideBarBreak';

  return 'none';
}

/**
 * How much evidence each pattern carries, 0…1.
 *
 * Feeds the confirmation half of the score rather than gating: a hammer is a weaker turn than
 * an engulfing bar and both are turns, and expressing that as a weight keeps one threshold
 * from having to pretend they are the same event.
 */
export const PATTERN_STRENGTH: Record<CandlePattern, number> = {
  bullishEngulfing: 1,
  bearishEngulfing: 1,
  piercing: 0.8,
  darkCloud: 0.8,
  hammer: 0.75,
  shootingStar: 0.75,
  strongBody: 0.65,
  insideBarBreak: 0.6,
  none: 0,
};
