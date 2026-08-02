// Factor 10 — Market Breadth. The tape the stock is trading into.
//
// Computed ONCE per cycle for the whole market, then applied per row: a stock going with
// the tape keeps the full breadth score, one fighting it keeps the configured
// counter-trend fraction. Not zero — the best momentum names do lead a turn — but it should
// not rank alongside one being pushed by everything around it.
//
// THE ONE SUBSTITUTION IN THIS MODULE IS HERE, and it is deliberate.
//
// The brief asks for "Nifty above VWAP". An index has no VWAP: Upstox answers `volume: null`
// on `NSE_INDEX|Nifty 50`, and its 1-minute candles carry volume 0 for every bar of the
// session — verified, the sum across 375 bars on 2026-07-31 is exactly zero. There is no
// traded quantity to weight by, so the quantity does not exist. Inventing one from
// constituent turnover would be a number that looks like a VWAP and is not.
//
// The near-month NIFTY FUTURE does have volume (2.34M) and does publish `average_price`
// (24445.32 against a 24430 last), so its VWAP is real and is what the panel reads. That is
// a substitution and is labelled as one in the payload — `vwapSource` carries the contract.
//
// Two breadth measures that need no substitution are computed alongside it and carry more
// weight: the advance/decline line across the F&O universe, and the share of that universe
// trading above its OWN VWAP, which is per-stock and therefore exact.

import type { MarketContext, MomentumConfig } from '../types.js';
import type { QuoteSnapshot } from '../data/quotes.js';
import { clamp, curve, outcome, signOf, unavailable } from './scoring.js';

export interface BreadthReading {
  advances: number;
  declines: number;
  unchanged: number;
  advanceDeclineRatio: number | null;
  /** −1…+1 from the advance/decline split alone. */
  adBias: number;
  pctAboveVwap: number | null;
  sectorsPositive: number;
  sectorsTracked: number;
  niftyChangePct: number | null;
  niftyAboveVwap: boolean | null;
  niftyVwapSource: string;
  vixLevel: number | null;
  vixChangePct: number | null;
  /** The composite, −1…+1. Positive is a bullish tape. */
  bias: number;
}

/** Percentage moves smaller than this count as unchanged rather than as an advance. */
const FLAT_PCT = 0.05;

export function computeBreadth(snap: QuoteSnapshot): BreadthReading {
  let advances = 0;
  let declines = 0;
  let unchanged = 0;
  let aboveVwap = 0;
  let vwapKnown = 0;

  for (const q of snap.equity.values()) {
    const s = signOf(q.changePct, FLAT_PCT);
    if (s > 0) advances++;
    else if (s < 0) declines++;
    else unchanged++;

    if (q.vwap > 0) {
      vwapKnown++;
      if (q.ltp > q.vwap) aboveVwap++;
    }
  }

  const breadthTotal = advances + declines;
  const adBias = breadthTotal > 0 ? (advances - declines) / breadthTotal : 0;

  let sectorsPositive = 0;
  for (const q of snap.sectors.values()) if (q.changePct > 0) sectorsPositive++;
  const sectorsTracked = snap.sectors.size;

  const fut = snap.niftyFuture;
  const niftyAboveVwap = fut && fut.vwap > 0 ? fut.ltp > fut.vwap : null;

  const pctAboveVwap = vwapKnown > 0 ? +((aboveVwap / vwapKnown) * 100).toFixed(1) : null;

  // Composite. The A/D line and the above-VWAP share are the two exact measures, so they
  // carry most of it; the sector count and the futures VWAP are corroboration.
  const parts: Array<{ v: number; w: number }> = [{ v: adBias, w: 0.4 }];
  if (pctAboveVwap !== null) parts.push({ v: (pctAboveVwap - 50) / 50, w: 0.35 });
  if (sectorsTracked > 0) parts.push({ v: (sectorsPositive / sectorsTracked - 0.5) * 2, w: 0.15 });
  if (niftyAboveVwap !== null) parts.push({ v: niftyAboveVwap ? 1 : -1, w: 0.1 });

  const wSum = parts.reduce((a, p) => a + p.w, 0);
  const bias = wSum > 0 ? +clamp(parts.reduce((a, p) => a + p.v * p.w, 0) / wSum, -1, 1).toFixed(3) : 0;

  return {
    advances,
    declines,
    unchanged,
    advanceDeclineRatio: declines > 0 ? +(advances / declines).toFixed(2) : advances > 0 ? null : 0,
    adBias: +adBias.toFixed(3),
    pctAboveVwap,
    sectorsPositive,
    sectorsTracked,
    niftyChangePct: snap.nifty?.changePct ?? null,
    niftyAboveVwap,
    // Named so a reader can see this is the future, not the index. See the header.
    niftyVwapSource: fut ? `${fut.symbol} (${fut.instrumentKey}) — the index itself publishes no volume` : 'unavailable',
    vixLevel: snap.vix?.ltp ?? null,
    vixChangePct: snap.vix?.changePct ?? null,
    bias,
  };
}

/**
 * The breadth factor for one row.
 *
 * `stockBias` is the stock's own direction as the other factors read it, so this is the
 * only factor whose score depends on the row it is being computed for.
 */
export function breadthFactor(reading: BreadthReading, stockDirection: number, cfg: MomentumConfig) {
  const weight = cfg.weights.marketBreadth;
  const t = cfg.thresholds.marketBreadth;

  if (reading.advances + reading.declines === 0)
    return unavailable('marketBreadth', weight, 'no quotes to measure breadth from');

  const magnitude = curve(Math.abs(reading.bias), t.knots);
  const withTape = signOf(stockDirection, 0.05) === signOf(reading.bias, 0.05) && signOf(reading.bias, 0.05) !== 0;
  const score = withTape || signOf(reading.bias, 0.05) === 0 ? magnitude : magnitude * t.counterTrendFactor;

  const bullish = reading.bias > 0;

  return outcome({
    key: 'marketBreadth',
    weight,
    score,
    bias: reading.bias,
    metrics: {
      advances: reading.advances,
      declines: reading.declines,
      unchanged: reading.unchanged,
      advanceDeclineRatio: reading.advanceDeclineRatio,
      pctAboveVwap: reading.pctAboveVwap,
      sectorsPositive: reading.sectorsPositive,
      sectorsTracked: reading.sectorsTracked,
      niftyChangePct: reading.niftyChangePct,
      niftyAboveVwap: reading.niftyAboveVwap,
      niftyVwapSource: reading.niftyVwapSource,
      indiaVix: reading.vixLevel,
      indiaVixChangePct: reading.vixChangePct,
      breadthBias: reading.bias,
      alignedWithTape: withTape,
    },
    reasons: [
      {
        ok: withTape,
        text: `Market breadth ${bullish ? 'positive' : 'negative'} (${reading.advances}A / ${reading.declines}D${
          reading.pctAboveVwap !== null ? `, ${reading.pctAboveVwap}% above own VWAP` : ''
        })${withTape ? '' : ' — this stock is against the tape'}`,
      },
    ],
  });
}

/** The market panel the board carries in its header. */
export function marketContext(
  snap: QuoteSnapshot,
  reading: BreadthReading,
  open: boolean,
  sessionFraction: number,
  minuteOfSession: number,
): MarketContext {
  return {
    asOf: snap.at,
    marketOpen: open,
    sessionFraction: +sessionFraction.toFixed(4),
    minuteOfSession,
    nifty: snap.nifty
      ? {
          level: snap.nifty.ltp,
          changePct: snap.nifty.changePct,
          aboveVwap: reading.niftyAboveVwap,
          vwapSource: reading.niftyVwapSource,
        }
      : null,
    indiaVix: snap.vix ? { level: snap.vix.ltp, changePct: snap.vix.changePct } : null,
    breadth: {
      advances: reading.advances,
      declines: reading.declines,
      unchanged: reading.unchanged,
      advanceDeclineRatio: reading.advanceDeclineRatio,
      pctAboveVwap: reading.pctAboveVwap,
      sectorsPositive: reading.sectorsPositive,
      sectorsTracked: reading.sectorsTracked,
      bias: reading.bias,
    },
  };
}
