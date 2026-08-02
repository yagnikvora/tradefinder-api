// Factor 2 — Liquidity. Can you actually get the size on that the score implies?
//
// Four sub-scores, mixed by configurable weights:
//
//   average daily value   ₹ crore normally traded. The structural read.
//   bid-ask spread        basis points of the mid. The cost of being wrong quickly.
//   book depth            ₹ crore resting across the top five levels, both sides.
//   option value          ₹ crore of premium traded on the near-month chain today.
//
// The first comes from the baseline, the middle two from the order book in the Tier-A
// quote, and the last from the enrichment pass — so a stock outside the shortlist scores on
// three of four and says so.
//
// OUTSIDE MARKET HOURS THERE IS NO BOOK. Upstox returns five levels of zeros once the
// closing auction is done, and reading that as "spread of 0 bps, depth of ₹0" would score
// every stock in the market as illiquid at 16:00 and perfectly tight at 09:14. `hasBook` on
// the quote decides, and the mix reweights around the absent halves rather than guessing.

import type { LiquidityGrade, MomentumConfig } from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import type { MomentumQuote } from '../data/quotes.js';
import { curve, mix, outcome, unavailable, type MixComponent } from './scoring.js';

export interface LiquidityInput {
  quote: MomentumQuote;
  baseline: SymbolBaseline | undefined;
  /** ₹ crore of option premium traded today. Enrichment tier; undefined until then. */
  optionValueCr?: number | null;
}

export interface LiquidityReading {
  score: number | null;
  grade: LiquidityGrade | null;
  spreadBps: number | null;
  depthCr: number | null;
  avgDailyValueCr: number | null;
  optionValueCr: number | null;
  turnoverCr: number;
  /** Top-of-book order-count skew, −1…+1. Positive means more bids than offers resting. */
  orderImbalance: number | null;
  coverage: number;
  missing: string[];
}

export function gradeLiquidity(score: number, g: MomentumConfig['thresholds']['liquidity']['grade']): LiquidityGrade {
  if (score >= g.excellent) return 'Excellent';
  if (score >= g.good) return 'Good';
  if (score >= g.average) return 'Average';
  return 'Poor';
}

/**
 * The full touch as basis points of the mid. Not the half-spread.
 *
 * BOTH sides must be priced. A one-sided book — which is what the pre-open and the closing
 * auction leave behind — has a positive mid and passes a naive `mid > 0` check, and a bid of
 * 0 against an ask of 100 then computes as a 20,000 bps spread. That is not a wide market,
 * it is the absence of one, and scoring it as merely expensive rather than absent puts a
 * stock nobody is quoting onto a tradable board.
 */
export function spreadBps(bid: number, ask: number): number | null {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return +(((ask - bid) / mid) * 10_000).toFixed(2);
}

export function computeLiquidity(input: LiquidityInput, cfg: MomentumConfig): LiquidityReading {
  const t = cfg.thresholds.liquidity;
  const { quote, baseline } = input;

  const spread = quote.hasBook ? spreadBps(quote.bid, quote.ask) : null;
  const depth = quote.hasBook ? quote.depthCr : null;
  // Fall back to today's traded value when the baseline has not been built: it is a weaker
  // statement (one day, not twenty) but it is a real number for the same quantity.
  const advCr = baseline?.avgDailyValueCr ?? (quote.turnoverCr > 0 ? quote.turnoverCr : null);
  const optionCr = input.optionValueCr ?? null;

  const components: MixComponent[] = [
    { key: 'averageDailyValue', weight: t.mix.averageDailyValue, score: advCr === null ? null : curve(advCr, t.averageDailyValueCr) },
    { key: 'spread', weight: t.mix.spread, score: spread === null ? null : curve(spread, t.spreadBps) },
    { key: 'depth', weight: t.mix.depth, score: depth === null ? null : curve(depth, t.depthCr) },
    { key: 'optionValue', weight: t.mix.optionValue, score: optionCr === null ? null : curve(optionCr, t.optionValueCr) },
  ];

  const m = mix(components);
  const totalOrders = quote.bidOrders + quote.askOrders;

  return {
    score: m.score,
    grade: m.score === null ? null : gradeLiquidity(m.score, t.grade),
    spreadBps: spread,
    depthCr: depth,
    avgDailyValueCr: advCr,
    optionValueCr: optionCr,
    turnoverCr: quote.turnoverCr,
    orderImbalance: totalOrders > 0 ? +((quote.bidOrders - quote.askOrders) / totalOrders).toFixed(3) : null,
    coverage: m.coverage,
    missing: m.missing,
  };
}

export function liquidityFactor(reading: LiquidityReading, cfg: MomentumConfig) {
  const weight = cfg.weights.liquidity;
  if (reading.score === null) return unavailable('liquidity', weight, 'no order book, baseline or traded value');

  const g = cfg.thresholds.liquidity.grade;
  const notes: string[] = [];
  if (reading.missing.includes('spread') || reading.missing.includes('depth'))
    notes.push('order book empty (outside market hours)');
  if (reading.missing.includes('optionValue')) notes.push('option volume needs the enrichment pass');

  return outcome({
    key: 'liquidity',
    weight,
    score: reading.score,
    bias: 0,
    metrics: {
      liquidityScore: reading.score,
      grade: reading.grade,
      spreadBps: reading.spreadBps,
      depthCr: reading.depthCr,
      avgDailyValueCr: reading.avgDailyValueCr,
      optionValueCr: reading.optionValueCr,
      turnoverCr: reading.turnoverCr,
      orderImbalance: reading.orderImbalance,
      coverage: +reading.coverage.toFixed(2),
    },
    reasons: [
      {
        ok: reading.score >= g.good,
        text: `Liquidity ${reading.grade}${reading.spreadBps !== null ? ` — ${reading.spreadBps.toFixed(1)} bps spread` : ''}${
          reading.avgDailyValueCr !== null ? `, ₹${Math.round(reading.avgDailyValueCr)}Cr ADV` : ''
        }`,
      },
    ],
    note: notes.length ? notes.join('; ') : undefined,
  });
}
