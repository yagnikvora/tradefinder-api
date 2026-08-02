// Factor 8 — ATR Expansion. Is today's range unusual for this stock?
//
//   expansion = today's projected true range ÷ Wilder ATR(14)
//
// Two things make this honest rather than decorative.
//
// TRUE range, not high−low. A stock that closed at 100 and opened at 108 has already moved
// 8% before it trades a tick; a high−low reading calls that session quiet. For a scanner
// looking for stocks that are moving, that is exactly backwards.
//
// PROJECTED, because at 10:00 the day's range is two per cent of the way through the
// session but far more than two per cent formed. Range fills roughly with the square root
// of elapsed time — the open is the widest stretch — so a linear scaling would report every
// stock as expanding violently in the first half hour. `services.ts` already reasons this
// way for R.Factor; the same curve is used here so the two agree.

import type { MomentumConfig } from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import type { MomentumQuote } from '../data/quotes.js';
import { curve, outcome, unavailable } from './scoring.js';

export interface AtrReading {
  atr: number | null;
  atrPct: number | null;
  todayRange: number;
  todayTrueRange: number;
  projectedRange: number | null;
  expansion: number | null;
  period: number;
}

/** max(H−L, |H−prevClose|, |L−prevClose|) — Wilder's true range for one bar. */
export const trueRange = (high: number, low: number, prevClose: number): number =>
  Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));

export function computeAtr(
  quote: MomentumQuote,
  baseline: SymbolBaseline | undefined,
  sessionFraction: number,
  cfg: MomentumConfig,
): AtrReading {
  const period = cfg.thresholds.atrExpansion.period;
  const atr = baseline?.atr ?? null;
  const tr = trueRange(quote.high, quote.low, quote.prevClose);

  if (!atr || atr <= 0)
    return {
      atr: null, atrPct: baseline?.atrPct ?? null, todayRange: +(quote.high - quote.low).toFixed(2),
      todayTrueRange: +tr.toFixed(2), projectedRange: null, expansion: null, period,
    };

  // Below ~2% elapsed the sqrt scaling divides by a number near zero and turns a one-tick
  // range into a tenfold expansion. Before that, the range so far is used unscaled.
  const elapsed = sessionFraction;
  const projected = elapsed > 0.02 ? tr / Math.sqrt(elapsed) : tr;

  return {
    atr: +atr.toFixed(2),
    atrPct: baseline?.atrPct ?? null,
    todayRange: +(quote.high - quote.low).toFixed(2),
    todayTrueRange: +tr.toFixed(2),
    projectedRange: +projected.toFixed(2),
    expansion: +(projected / atr).toFixed(2),
    period,
  };
}

export function atrFactor(reading: AtrReading, cfg: MomentumConfig) {
  const weight = cfg.weights.atrExpansion;
  if (reading.expansion === null)
    return unavailable('atrExpansion', weight, 'no ATR baseline for this symbol yet');

  const t = cfg.thresholds.atrExpansion;
  const score = curve(reading.expansion, t.knots);
  const expanding = reading.expansion >= 1.2;

  return outcome({
    key: 'atrExpansion',
    weight,
    score,
    // Volatility expansion says a move is underway, not which way it points.
    bias: 0,
    metrics: {
      expansion: reading.expansion,
      atr: reading.atr,
      atrPct: reading.atrPct,
      todayTrueRange: reading.todayTrueRange,
      projectedRange: reading.projectedRange,
      period: reading.period,
    },
    reasons: [
      {
        ok: expanding,
        text: expanding
          ? `ATR expansion ${reading.expansion.toFixed(2)}x — range running wide of its ${reading.period}-day norm`
          : `ATR ${reading.expansion.toFixed(2)}x — range is inside the ${reading.period}-day norm`,
      },
    ],
  });
}
