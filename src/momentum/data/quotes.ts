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
//
// THE LIVE FEED NOW SERVES THIS TIER, AND REST IS THE FALLBACK.
//
// Every field above is on the Market Data Feed V3, verified against the REST answer before
// the switch was made (`tools/ws-spike.ts`): `atp` is `average_price` to the last paisa,
// `vtt` is `volume`, the `1d` OHLC candle is `ohlc`, and LTPC carries the previous close.
// A reading that is already in memory when the scan starts is the entire point — the timing
// layer could never report a trigger sooner than the poll that detected it, and the poll was
// fifteen seconds wide.
//
// TWO FIELDS DO NOT SURVIVE THE CROSSING, and both were checked before they were given up:
//
//   order counts    the feed's depth `Quote` is bidQ/bidP/askQ/askP and nothing else. So
//                   `bidOrders`/`askOrders` are 0 on a feed-sourced reading and the liquidity
//                   factor's `orderImbalance` reports `null` — which it already did for every
//                   seeded symbol, and which `mix()` reweights around. It is the one genuine
//                   loss in the migration.
//
//   oi_day_high/low no feed equivalent, so they are ACCUMULATED instead: the feed streams
//                   `oi` continuously and the store watches its extremes. Finer-grained than
//                   the REST snapshot was, with the caveat that the range spans from connect
//                   rather than from 09:15.
//
// The fallback is not decoration. `feedUsable` demands an open socket, fresh packets and
// near-total coverage; anything less and the cycle is served by the three REST calls exactly
// as before. A degraded feed that kept answering would be far worse than a slow one, because
// a stock that stopped ticking reads as a stock that stopped moving.

import { call } from '../../upstox.js';
import { feedTick, feedUsable, subscribeKeys, type FeedTick } from '../../feed/client.js';
import { marketOpen } from '../session.js';
import { universe } from './universe.js';

/** Upstox takes 500 keys; 200 keeps the URL comfortably short and still costs 3 calls. */
const CHUNK = 200;

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

/**
 * The same reading, built from a streamed tick instead of a REST row.
 *
 * Deliberately a separate function rather than a shim that fakes a `RawQuote`: the two
 * sources differ in exactly three places — order counts, the OI day range, and the timestamp
 * — and a shim would have hidden all three behind plausible zeros. Here they are visible.
 */
export function fromTick(name: string, key: string, t: FeedTick): MomentumQuote | null {
  const ltp = t.ltp;
  if (ltp <= 0) return null;

  const prevClose = t.cp;
  const netChange = +(ltp - prevClose).toFixed(2);

  const buy = t.depth.filter((l) => l.bidP > 0);
  const sell = t.depth.filter((l) => l.askP > 0);
  const bid = buy[0]?.bidP ?? 0;
  const ask = sell[0]?.askP ?? 0;
  const hasBook = bid > 0 && ask > 0 && ask >= bid;

  let depthValue = 0;
  for (const l of t.depth) depthValue += l.bidP * l.bidQ + l.askP * l.askQ;

  return {
    symbol: name,
    instrumentKey: key,
    ltp,
    prevClose,
    netChange,
    changePct: prevClose > 0 ? +((netChange / prevClose) * 100).toFixed(3) : 0,
    open: t.dayOpen || prevClose,
    high: t.dayHigh || ltp,
    low: t.dayLow || ltp,
    volume: t.vtt,
    vwap: t.atp,
    turnoverCr: +((t.atp * t.vtt) / 1e7).toFixed(3),
    openInterest: t.oi,
    oiDayHigh: t.oiHigh,
    oiDayLow: t.oiLow,
    totalBuyQty: t.tbq,
    totalSellQty: t.tsq,
    bid,
    ask,
    bidQty: buy[0]?.bidQ ?? 0,
    askQty: sell[0]?.askQ ?? 0,
    // Not on the feed at any depth level. Zero here means "unmeasurable", and
    // `liquidity.service.ts` already reports `orderImbalance: null` when both are zero.
    bidOrders: 0,
    askOrders: 0,
    depthCr: +(depthValue / 1e7).toFixed(4),
    hasBook,
    // Upstox's own stamp when the packet carried one, else when we received it.
    at: t.feedTs || t.at,
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
  /** Where this reading came from. Surfaced on `/momentum/status`. */
  source: 'feed' | 'rest';
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
    source: 'rest',
  };

  const keys = [...route.keys()];

  const file = (key: string, q: MomentumQuote | null) => {
    const dest = route.get(key);
    if (!dest || !q) return;
    switch (dest.bucket) {
      case 'equity': snap.equity.set(dest.name, q); break;
      case 'futures': snap.futures.set(dest.name, q); break;
      case 'sector': snap.sectors.set(dest.name, q); break;
      case 'nifty': snap.nifty = q; break;
      case 'niftyFut': snap.niftyFuture = q; break;
      case 'vix': snap.vix = q; break;
    }
  };

  // Asked for every cycle, not once at startup. The call is a no-op for anything already
  // subscribed, so an expiry roll — a new futures contract entering the universe — is picked
  // up here without anything having to notice that the roll happened.
  subscribeKeys(keys);

  if (feedUsable(keys, marketOpen(nowMs), nowMs)) {
    for (const key of keys) {
      const t = feedTick(key);
      const dest = route.get(key);
      if (t && dest) file(key, fromTick(dest.name, key, t));
    }
    snap.source = 'feed';
  } else {
    for (let i = 0; i < keys.length; i += CHUNK) {
      const slice = keys.slice(i, i + CHUNK);
      const data = await call<Record<string, RawQuote>>(
        `/v2/market-quote/quotes?instrument_key=${encodeURIComponent(slice.join(','))}`,
      );
      for (const raw of Object.values(data ?? {})) {
        // Mapped home by `instrument_token`, which echoes the key that was requested. Never
        // by `symbol`: an index answers with the literal string "NA".
        const key = String(raw.instrument_token ?? '');
        file(key, normalise(route.get(key)?.name ?? '', key, raw));
      }
    }
  }

  // A half-priced universe renders as a plausible but wrong board — the same failure mode
  // `equity.ts` guards. Refuse it so the caller re-serves the last good one.
  if (snap.equity.size < uni.members.length * 0.7)
    throw new Error(
      `partial universe: Upstox priced ${snap.equity.size}/${uni.members.length} shares (via ${snap.source})`,
    );

  return snap;
}
