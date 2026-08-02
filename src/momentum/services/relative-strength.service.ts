// Factor 3 — Relative Strength. The stock's move, net of the market's.
//
//   Nifty +0.5%, stock +2.0%  ->  RS = +1.5pp
//
// That is the brief's definition and it is what the board shows. The score, though, is
// computed on the BETA-ADJUSTED version by default, because the raw figure systematically
// flatters high-beta names: on a +1% day a 1.6-beta stock is expected to be up 1.6% before
// anything stock-specific has happened, and calling that +0.6pp of "strength" ranks the
// index's own leverage as a signal.
//
//   alpha = stockReturn − beta × indexReturn
//
// Beta comes from the daily baseline (OLS over ~400 sessions). When it is missing the raw
// spread is used and the factor says so, rather than dropping a whole ten-weight factor
// over a regression that did not converge.

import type { MomentumConfig } from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import { curve, fmtPct, outcome, squash, unavailable } from './scoring.js';

export interface RelativeStrengthReading {
  /** Plain stock% − index%, in percentage points. Always present. */
  relativeStrengthPct: number;
  /** Beta-adjusted alpha, when beta is known. */
  alphaPct: number | null;
  beta: number | null;
  stockChangePct: number;
  indexChangePct: number;
  /** Whichever of the two the score was actually computed on. */
  usedPct: number;
  usedBeta: boolean;
}

export function computeRelativeStrength(
  stockChangePct: number,
  indexChangePct: number,
  baseline: SymbolBaseline | undefined,
  cfg: MomentumConfig,
): RelativeStrengthReading {
  const beta = baseline?.beta ?? null;
  const rs = +(stockChangePct - indexChangePct).toFixed(3);
  const alpha = beta === null ? null : +(stockChangePct - beta * indexChangePct).toFixed(3);
  const useBeta = cfg.thresholds.relativeStrength.useBeta && alpha !== null;

  return {
    relativeStrengthPct: rs,
    alphaPct: alpha,
    beta,
    stockChangePct,
    indexChangePct,
    usedPct: useBeta ? (alpha as number) : rs,
    usedBeta: useBeta,
  };
}

export function relativeStrengthFactor(
  reading: RelativeStrengthReading | null,
  cfg: MomentumConfig,
) {
  const weight = cfg.weights.relativeStrength;
  if (!reading) return unavailable('relativeStrength', weight, 'no Nifty quote to measure against');

  const t = cfg.thresholds.relativeStrength;
  const score = curve(Math.abs(reading.usedPct), t.knots);
  const bias = squash(reading.usedPct, t.fullScalePct);

  return outcome({
    key: 'relativeStrength',
    weight,
    score,
    bias,
    metrics: {
      relativeStrengthPct: reading.relativeStrengthPct,
      alphaPct: reading.alphaPct,
      beta: reading.beta,
      stockChangePct: reading.stockChangePct,
      niftyChangePct: reading.indexChangePct,
      basis: reading.usedBeta ? 'beta-adjusted alpha' : 'raw spread vs Nifty',
    },
    reasons: [
      {
        ok: Math.abs(reading.usedPct) >= t.knots[1]?.at,
        text: `Relative strength ${fmtPct(reading.relativeStrengthPct)} vs Nifty ${fmtPct(reading.indexChangePct)}${
          reading.usedBeta ? ` (β ${reading.beta?.toFixed(2)}, alpha ${fmtPct(reading.alphaPct ?? 0)})` : ''
        }`,
      },
    ],
    note: t.useBeta && !reading.usedBeta ? 'beta unavailable — scored on the raw spread' : undefined,
  });
}
