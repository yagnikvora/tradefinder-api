// Tier A — the whole scanner's live state in one round trip.
//
// This is the piece that makes a 30-second full-universe refresh affordable. Upstox takes
// 500 instrument keys per quote request and answers in ~100ms, and the full momentum
// universe is 208 shares + 208 futures + ~14 sector indices + Nifty + Nifty futures + VIX
// ≈ 434 keys. Chunked at 200 that is three calls per cycle, 360 per 30 minutes against a
// 2000 ceiling — 18% of the budget for every quote-tier factor on every stock.
//
// Two fields do far more work here than their names suggest:
//
//   average_price   is the SESSION VWAP, not a mid or a day average. Verified against
//                   candle-derived VWAP for RELIANCE, SBIN and TATASTEEL on 2026-07-31:
//                   0.002%, 0.003% and 0.002% drift. So the VWAP factor costs no request at
//                   all, and the running series it needs is just successive readings.
//
//   depth           is five levels a side with price, quantity AND order count. That is the
//                   whole liquidity factor — spread, book depth and order-count imbalance —
//                   again for no extra call.
//
// Outside market hours the book is empty (`depth` all zeros, `total_buy_quantity` 0). That
// is a real state, not an error: `hasBook` says so and the liquidity factor reweights
// around it rather than scoring every stock as illiquid at 4pm.

import { call } from '../../upstox.js';
import { universe } from './universe.js';

/** Upstox takes 500 keys; 200 keeps the URL comfortably short and still costs 3 calls. */
const CHUNK = 200;

export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface MomentumQuote {
  symbol: string;
  instrumentKey: string;
  ltp: number;
  prevClose: number;
  netChange: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  /** Session VWAP — Upstox's `average_price`. 0 before the first trade. */
  vwap: number;
  /** ₹ crore traded today, `vwap × volume`. Matches NSE's totalTradedValue. */
  turnoverCr: number;
  openInterest: number;
  oiDayHigh: number;
  oiDayLow: number;
  totalBuyQty: number;
  totalSellQty: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  bidOrders: number;
  askOrders: number;
  /** ₹ crore resting across the top five levels, both sides. */
  depthCr: number;
  /** Whether a two-sided book was actually present in this reading. */
  hasBook: boolean;
  /** Upstox's own stamp for the reading, epoch ms. */
  at: number;
}

interface RawDepth {
  buy?: Array<{ price?: number; quantity?: number; orders?: number }>;
  sell?: Array<{ price?: number; quantity?: number; orders?: number }>;
}

interface RawQuote {
  instrument_token?: string;
  symbol?: string;
  last_price?: number;
  net_change?: number;
  volume?: number | null;
  average_price?: number | null;
  oi?: number | null;
  oi_day_high?: number | null;
  oi_day_low?: number | null;
  total_buy_quantity?: number | null;
  total_sell_quantity?: number | null;
  timestamp?: string;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  depth?: RawDepth;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function normalise(name: string, key: string, q: RawQuote): MomentumQuote | null {
  const ltp = num(q.last_price);
  if (ltp <= 0) return null;

  const netChange = num(q.net_change);
  const prevClose = +(ltp - netChange).toFixed(2);
  const volume = num(q.volume);
  const vwap = num(q.average_price);

  const buy = q.depth?.buy ?? [];
  const sell = q.depth?.sell ?? [];
  const bid = num(buy[0]?.price);
  const ask = num(sell[0]?.price);
  // A one-sided book is not a book. Pre-open and the closing auction leave a lone resting
  // order on one side; treating that as a tradable spread reads as infinitely tight.
  const hasBook = bid > 0 && ask > 0 && ask >= bid;

  let depthValue = 0;
  for (const lvl of [...buy, ...sell]) depthValue += num(lvl.price) * num(lvl.quantity);

  return {
    symbol: name,
    instrumentKey: key,
    ltp,
    prevClose,
    netChange,
    changePct: prevClose > 0 ? +((netChange / prevClose) * 100).toFixed(3) : 0,
    // Before the first print `ohlc.open` is 0; the previous close is where the stock still
    // is, and is the only honest stand-in for "it has not opened".
    open: num(q.ohlc?.open) || prevClose,
    high: num(q.ohlc?.high) || ltp,
    low: num(q.ohlc?.low) || ltp,
    volume,
    vwap,
    turnoverCr: +((vwap * volume) / 1e7).toFixed(3),
    openInterest: num(q.oi),
    oiDayHigh: num(q.oi_day_high),
    oiDayLow: num(q.oi_day_low),
    totalBuyQty: num(q.total_buy_quantity),
    totalSellQty: num(q.total_sell_quantity),
    bid,
    ask,
    bidQty: num(buy[0]?.quantity),
    askQty: num(sell[0]?.quantity),
    bidOrders: num(buy[0]?.orders),
    askOrders: num(sell[0]?.orders),
    depthCr: +(depthValue / 1e7).toFixed(4),
    hasBook,
    at: q.timestamp ? Date.parse(q.timestamp) : Date.now(),
  };
}

export interface QuoteSnapshot {
  at: number;
  /** Stock symbol -> its equity quote. */
  equity: Map<string, MomentumQuote>;
  /** Stock symbol -> its near-month futures quote. */
  futures: Map<string, MomentumQuote>;
  /** Sector index display name -> quote. */
  sectors: Map<string, MomentumQuote>;
  nifty: MomentumQuote | null;
  niftyFuture: MomentumQuote | null;
  vix: MomentumQuote | null;
}

/**
 * One reading of everything.
 *
 * Responses are mapped home by `instrument_token`, which echoes the key that was requested.
 * Never by `symbol`: an index answers with the literal string "NA", so keying on it drops
 * every index while looking like it worked — the same trap `equity.ts` documents.
 */
export async function quoteSnapshot(nowMs = Date.now()): Promise<QuoteSnapshot> {
  const uni = await universe(nowMs);

  // key -> where the answer belongs. Built before the request so nothing is looked up twice.
  const route = new Map<string, { bucket: 'equity' | 'futures' | 'sector' | 'nifty' | 'niftyFut' | 'vix'; name: string }>();

  for (const m of uni.members) {
    route.set(m.equityKey, { bucket: 'equity', name: m.symbol });
    if (m.future) route.set(m.future.instrumentKey, { bucket: 'futures', name: m.symbol });
  }
  for (const [name, key] of uni.sectorIndexKeys) route.set(key, { bucket: 'sector', name });
  route.set(uni.niftyKey, { bucket: 'nifty', name: 'NIFTY' });
  if (uni.niftyFuture) route.set(uni.niftyFuture.instrumentKey, { bucket: 'niftyFut', name: 'NIFTY FUT' });
  if (uni.vixKey) route.set(uni.vixKey, { bucket: 'vix', name: 'INDIA VIX' });

  const snap: QuoteSnapshot = {
    at: nowMs,
    equity: new Map(),
    futures: new Map(),
    sectors: new Map(),
    nifty: null,
    niftyFuture: null,
    vix: null,
  };

  const keys = [...route.keys()];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const data = await call<Record<string, RawQuote>>(
      `/v2/market-quote/quotes?instrument_key=${encodeURIComponent(slice.join(','))}`,
    );
    for (const raw of Object.values(data ?? {})) {
      const key = String(raw.instrument_token ?? '');
      const dest = route.get(key);
      if (!dest) continue;
      const q = normalise(dest.name, key, raw);
      if (!q) continue;
      switch (dest.bucket) {
        case 'equity': snap.equity.set(dest.name, q); break;
        case 'futures': snap.futures.set(dest.name, q); break;
        case 'sector': snap.sectors.set(dest.name, q); break;
        case 'nifty': snap.nifty = q; break;
        case 'niftyFut': snap.niftyFuture = q; break;
        case 'vix': snap.vix = q; break;
      }
    }
  }

  // A half-priced universe renders as a plausible but wrong board — the same failure mode
  // `equity.ts` guards. Refuse it so the caller re-serves the last good one.
  if (snap.equity.size < uni.members.length * 0.7)
    throw new Error(`partial universe: Upstox priced ${snap.equity.size}/${uni.members.length} shares`);

  return snap;
}
