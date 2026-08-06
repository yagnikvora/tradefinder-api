// One reading of every scanned instrument, in three requests.
//
// Upstox takes 500 instrument keys per quote call and answers in ~100ms. The pullback universe
// is ~211 stock series + 4 index futures + 4 index spots + Nifty + VIX ≈ 221 keys, which fits
// in two calls at the 200-key chunk this app uses everywhere. At a 30-second scan that is ~120
// requests per 30 minutes against a 2000 ceiling: 6% of the budget for the ENTIRE live tier.
//
// WHY THIS DOES NOT REUSE `momentum/data/quotes.ts`. It very nearly could — the field mapping
// is the same and the traps are the same. It does not, for two reasons that are about the
// module boundary rather than about the code: the momentum snapshot has no index futures and
// no index spots (its universe is stocks), and `momentum/index.ts` is documented as the only
// file the rest of the API may import from that module. Reaching into its data layer would
// make this module's correctness depend on another module's internals, and the shared piece
// that genuinely IS app-level infrastructure — the authenticated client, the instrument
// master, the session arithmetic, the disk store — is imported rather than copied.
//
// THE FIELD THAT DOES THE MOST WORK is `average_price`, which is the SESSION VWAP and not a
// mid. `momentum/data/quotes.ts` verified it against candle-derived VWAP to within 0.003%, and
// that verification is what makes the VWAP half of the pullback zone free.

import { call } from '../../upstox.js';
import { istDay, minuteOfSession } from '../../momentum/session.js';
import type { Universe } from './universe.js';

/** 200 keeps the URL comfortably short and still costs two calls for this universe. */
const CHUNK = 200;

/**
 * One instrument's live state.
 *
 * Leaner than `MomentumQuote` on purpose: this module reads price, the session accumulators,
 * and the top of the book. It has no use for open-interest day highs or order counts, and
 * carrying fields nothing reads is how a type stops describing what it is for.
 */
export interface Tick {
  symbol: string;
  instrumentKey: string;
  ltp: number;
  prevClose: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  /** Session-cumulative traded quantity. Bar volumes are deltas of this. */
  volume: number;
  /** Session VWAP — Upstox's `average_price`. 0 before the first trade. */
  vwap: number;
  /** Session-cumulative rupee turnover, `vwap × volume`. Bar turnovers are deltas of this. */
  turnover: number;
  turnoverCr: number;
  openInterest: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  /** Bid-ask as a share of the mid, in basis points. Null when the book is one-sided. */
  spreadBps: number | null;
  /** ₹ crore resting across the top five levels, both sides. */
  depthCr: number;
  /** Whether a two-sided book was present. Outside market hours this is false for everything. */
  hasBook: boolean;
  at: number;
}

interface RawQuote {
  instrument_token?: string;
  last_price?: number;
  net_change?: number;
  volume?: number | null;
  average_price?: number | null;
  oi?: number | null;
  timestamp?: string;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  depth?: {
    buy?: Array<{ price?: number; quantity?: number }>;
    sell?: Array<{ price?: number; quantity?: number }>;
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function normalise(symbol: string, key: string, q: RawQuote, nowMs: number): Tick | null {
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
  // order on one side, and treating that as a tradable spread reads as infinitely tight —
  // which would silently disarm the bid-ask veto at exactly the times it should be loudest.
  const hasBook = bid > 0 && ask > 0 && ask >= bid;
  const mid = hasBook ? (bid + ask) / 2 : 0;

  let depthValue = 0;
  for (const lvl of [...buy, ...sell]) depthValue += num(lvl.price) * num(lvl.quantity);

  return {
    symbol,
    instrumentKey: key,
    ltp,
    prevClose,
    changePct: prevClose > 0 ? +((netChange / prevClose) * 100).toFixed(3) : 0,
    // Before the first print `ohlc.open` is 0; the previous close is where the instrument
    // still is, and is the only honest stand-in for "it has not opened".
    open: num(q.ohlc?.open) || prevClose,
    high: num(q.ohlc?.high) || ltp,
    low: num(q.ohlc?.low) || ltp,
    volume,
    vwap,
    turnover: vwap * volume,
    turnoverCr: +((vwap * volume) / 1e7).toFixed(3),
    openInterest: num(q.oi),
    bid,
    ask,
    bidQty: num(buy[0]?.quantity),
    askQty: num(sell[0]?.quantity),
    spreadBps: hasBook && mid > 0 ? +(((ask - bid) / mid) * 10_000).toFixed(1) : null,
    depthCr: +(depthValue / 1e7).toFixed(4),
    hasBook,
    at: q.timestamp ? Date.parse(q.timestamp) : nowMs,
  };
}

export interface Snapshot {
  at: number;
  day: string;
  minute: number;
  /** Symbol -> the series instrument's tick. This is what the bars are built from. */
  series: Map<string, Tick>;
  /** Symbol -> the index level, for indices only. Carried so the basis is visible. */
  spot: Map<string, Tick>;
  nifty: Tick | null;
  vix: Tick | null;
}

/**
 * One reading of everything.
 *
 * Responses are mapped home by `instrument_token`, which echoes the key that was requested.
 * NEVER by `symbol`: an index answers with the literal string "NA", so keying on it drops
 * every index while looking like it worked — the trap `equity.ts` and `momentum/data/quotes.ts`
 * both document, and the one that would silently remove all four index rows from this board.
 */
export async function snapshot(uni: Universe, nowMs = Date.now()): Promise<Snapshot> {
  const route = new Map<string, { bucket: 'series' | 'spot' | 'nifty' | 'vix'; name: string }>();

  for (const m of uni.members) {
    route.set(m.seriesKey, { bucket: 'series', name: m.symbol });
    if (m.spotKey && !route.has(m.spotKey)) route.set(m.spotKey, { bucket: 'spot', name: m.symbol });
  }
  if (!route.has(uni.niftyKey)) route.set(uni.niftyKey, { bucket: 'nifty', name: 'NIFTY' });
  if (uni.vixKey && !route.has(uni.vixKey)) route.set(uni.vixKey, { bucket: 'vix', name: 'INDIA VIX' });

  const snap: Snapshot = {
    at: nowMs,
    day: istDay(nowMs),
    minute: minuteOfSession(nowMs),
    series: new Map(),
    spot: new Map(),
    nifty: null,
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
      const t = normalise(dest.name, key, raw, nowMs);
      if (!t) continue;
      switch (dest.bucket) {
        case 'series': snap.series.set(dest.name, t); break;
        case 'spot': snap.spot.set(dest.name, t); break;
        case 'nifty': snap.nifty = t; break;
        case 'vix': snap.vix = t; break;
      }
    }
  }

  // A half-priced universe renders as a plausible but wrong board, which is the failure mode
  // every quote path in this app guards against. Refuse it so the caller re-serves the last
  // good scan instead of publishing a board built on a third of the market.
  if (snap.series.size < uni.members.length * 0.7)
    throw new Error(`partial universe: Upstox priced ${snap.series.size}/${uni.members.length} series instruments`);

  // The Nifty row is a member of the universe in its own right, so its tick lands in `series`
  // rather than in the headline slot. Fill the headline from there when that happened.
  if (!snap.nifty) snap.nifty = snap.spot.get('NIFTY') ?? snap.series.get('NIFTY') ?? null;

  return snap;
}
