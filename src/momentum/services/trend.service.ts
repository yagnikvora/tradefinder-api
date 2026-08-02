// Factor 11 — Trend Structure. Higher highs, higher lows, breakouts, opening-range breaks.
//
// A checklist rather than a curve, because these are discrete facts and averaging them into
// a continuous score would lose what makes them useful: "broke the 20-day high AND held
// above the opening range" is a different statement from "scored 55".
//
// Each satisfied structure contributes its configured points; the total is capped at 100.
// Structures are read SIGNED — a lower low and a downside break score the same points and
// push the bias negative — so the factor works identically for short momentum.
//
// The opening range comes from `session-state.ts`, which captures it from the ordinary
// quote poll at 09:30 rather than fetching 208 sets of 1-minute candles for it. When the
// scanner was started after 09:30 on a day nobody was watching, the range is genuinely
// unknowable from the quote feed and that sub-check is skipped rather than invented.

import type { MomentumConfig } from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import type { MomentumQuote } from '../data/quotes.js';
import type { OpeningRange } from '../data/session-state.js';
import { clamp, outcome, unavailable } from './scoring.js';

export interface TrendReading {
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
  breakout: 'up' | 'down' | null;
  orb: 'up' | 'down' | null;
  aboveOpen: boolean;
  priorHigh: number | null;
  priorLow: number | null;
  openingRange: OpeningRange | null;
  lookbackSessions: number;
}

export function computeTrend(
  quote: MomentumQuote,
  baseline: SymbolBaseline | undefined,
  openingRange: OpeningRange | null,
  cfg: MomentumConfig,
): TrendReading {
  const t = cfg.thresholds.trendStructure;
  const priorHigh = baseline?.priorHigh || null;
  const priorLow = baseline?.priorLow || null;

  const higherHigh = !!baseline?.prevHigh && quote.high > baseline.prevHigh;
  const higherLow = !!baseline?.prevLow && quote.low > baseline.prevLow;
  const lowerHigh = !!baseline?.prevHigh && quote.high < baseline.prevHigh;
  const lowerLow = !!baseline?.prevLow && quote.low < baseline.prevLow;

  const breakout: 'up' | 'down' | null =
    priorHigh && quote.ltp > priorHigh ? 'up' : priorLow && quote.ltp < priorLow ? 'down' : null;

  // An incomplete range is not a range: inside the first fifteen minutes price is by
  // definition at the edge of the high/low seen so far, and every stock would read as a
  // breakout.
  const orb: 'up' | 'down' | null =
    openingRange?.complete && openingRange.high > 0
      ? quote.ltp > openingRange.high
        ? 'up'
        : quote.ltp < openingRange.low
          ? 'down'
          : null
      : null;

  return {
    higherHigh, higherLow, lowerHigh, lowerLow, breakout, orb,
    aboveOpen: quote.ltp > quote.open,
    priorHigh, priorLow,
    openingRange,
    lookbackSessions: t.lookbackSessions,
  };
}

export function trendFactor(reading: TrendReading, cfg: MomentumConfig) {
  const weight = cfg.weights.trendStructure;
  const t = cfg.thresholds.trendStructure;
  const p = t.points;

  if (!reading.priorHigh && !reading.priorLow && !reading.openingRange)
    return unavailable('trendStructure', weight, 'no price history or opening range for this symbol yet');

  // Points are accumulated in a SIGNED bucket per side, so a stock making a higher high and
  // a lower low (an outside day) nets toward neutral rather than scoring for both.
  let up = 0;
  let down = 0;
  const reasons = [];

  if (reading.higherHigh) { up += p.higherHigh; reasons.push({ ok: true, text: 'Higher high vs the previous session' }); }
  if (reading.lowerLow) { down += p.higherHigh; reasons.push({ ok: true, text: 'Lower low vs the previous session' }); }
  if (reading.higherLow) { up += p.higherLow; reasons.push({ ok: true, text: 'Higher low — the pullbacks are shallower' }); }
  if (reading.lowerHigh) { down += p.higherLow; reasons.push({ ok: true, text: 'Lower high — the rallies are shorter' }); }

  if (reading.breakout === 'up') { up += p.breakout; reasons.push({ ok: true, text: `Breakout above the ${reading.lookbackSessions}-session high` }); }
  if (reading.breakout === 'down') { down += p.breakout; reasons.push({ ok: true, text: `Breakdown below the ${reading.lookbackSessions}-session low` }); }

  if (reading.orb === 'up') { up += p.openingRangeBreak; reasons.push({ ok: true, text: `Opening-range breakout (${reading.openingRange?.minutes}m)` }); }
  if (reading.orb === 'down') { down += p.openingRangeBreak; reasons.push({ ok: true, text: `Opening-range breakdown (${reading.openingRange?.minutes}m)` }); }

  if (reading.aboveOpen) up += p.aboveOpen; else down += p.aboveOpen;

  const net = up - down;
  const score = clamp(Math.abs(net), 0, 100);
  const maxPossible = p.higherHigh + p.higherLow + p.breakout + p.openingRangeBreak + p.aboveOpen;
  const bias = maxPossible > 0 ? clamp(net / maxPossible, -1, 1) : 0;

  if (!reasons.length)
    reasons.push({ ok: false, text: 'No trend structure — inside the previous session’s range' });

  return outcome({
    key: 'trendStructure',
    weight,
    score,
    bias,
    metrics: {
      higherHigh: reading.higherHigh,
      higherLow: reading.higherLow,
      lowerHigh: reading.lowerHigh,
      lowerLow: reading.lowerLow,
      breakout: reading.breakout,
      openingRangeBreak: reading.orb,
      aboveOpen: reading.aboveOpen,
      priorHigh: reading.priorHigh,
      priorLow: reading.priorLow,
      openingRangeHigh: reading.openingRange?.high ?? null,
      openingRangeLow: reading.openingRange?.low ?? null,
    },
    reasons,
    note: reading.openingRange ? undefined : 'opening range not captured — the scanner was not running at 09:30',
  });
}
