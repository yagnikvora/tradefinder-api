// Factor 9 — Sector Strength. Two questions, not one.
//
//   Is the sector leading the market?     sectorReturn − niftyReturn
//   Is the stock leading its sector?      stockReturn  − sectorReturn
//
// Both matter and they are not the same. A bank up 1.2% on a day the bank index is up 1.8%
// is a laggard being carried; the same 1.2% with the index flat is a stock doing something
// of its own. The two are combined in the stock's own direction, so a falling stock in a
// falling sector scores as strong BEARISH momentum rather than as weak bullish momentum.
//
// Both readings come free out of the Tier-A batch — the sector indices ride in the same
// quote request as the shares.
//
// A stock with no tradable sector index (the OTHERS bucket, and the broad-market baskets)
// scores this as unavailable. Falling back to the Nifty would just restate the
// relative-strength factor under a second name and double-count it.

import type { MomentumConfig } from '../types.js';
import type { MomentumQuote } from '../data/quotes.js';
import { curve, fmtPct, outcome, signOf, squash, unavailable } from './scoring.js';

export interface SectorReading {
  sector: string;
  indexName: string;
  sectorChangePct: number;
  sectorVsNiftyPct: number;
  stockVsSectorPct: number;
  /** The two halves averaged and signed by the stock's own direction. */
  combinedPct: number;
}

export function computeSector(
  stockChangePct: number,
  sector: string | null,
  indexName: string | null,
  sectorQuote: MomentumQuote | undefined,
  niftyChangePct: number | null,
): SectorReading | null {
  if (!sector || !indexName || !sectorQuote || niftyChangePct === null) return null;

  const sectorChangePct = sectorQuote.changePct;
  const sectorVsNifty = +(sectorChangePct - niftyChangePct).toFixed(3);
  const stockVsSector = +(stockChangePct - sectorChangePct).toFixed(3);

  // Signed into the stock's direction: for a stock that is DOWN, a sector that is also down
  // is confirmation, so the contribution is positive on the bearish side.
  const dir = signOf(stockChangePct, 0.05) || 1;
  const combined = +(dir * 0.5 * (dir * sectorVsNifty + dir * stockVsSector)).toFixed(3);

  return {
    sector,
    indexName,
    sectorChangePct,
    sectorVsNiftyPct: sectorVsNifty,
    stockVsSectorPct: stockVsSector,
    combinedPct: combined,
  };
}

export function sectorFactor(reading: SectorReading | null, cfg: MomentumConfig) {
  const weight = cfg.weights.sectorStrength;
  if (!reading)
    return unavailable('sectorStrength', weight, 'no tradable sector index for this symbol');

  const t = cfg.thresholds.sectorStrength;
  const score = curve(Math.abs(reading.combinedPct), t.knots);
  const bias = squash(reading.combinedPct, t.fullScalePct);
  const outperforming = reading.sectorVsNiftyPct > 0;
  const leading = reading.stockVsSectorPct > 0;

  return outcome({
    key: 'sectorStrength',
    weight,
    score,
    bias,
    metrics: {
      sector: reading.sector,
      sectorIndex: reading.indexName,
      sectorChangePct: reading.sectorChangePct,
      sectorVsNiftyPct: reading.sectorVsNiftyPct,
      stockVsSectorPct: reading.stockVsSectorPct,
      combinedPct: reading.combinedPct,
    },
    reasons: [
      {
        ok: outperforming,
        text: `${reading.sector} ${outperforming ? 'outperforming' : 'underperforming'} the Nifty by ${fmtPct(Math.abs(reading.sectorVsNiftyPct))}`,
      },
      {
        ok: leading,
        text: `Stock ${leading ? 'leading' : 'lagging'} its sector by ${fmtPct(Math.abs(reading.stockVsSectorPct))}`,
      },
    ],
  });
}
