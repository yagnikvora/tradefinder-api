// Equity quotes from Upstox — the feed behind Market Pulse, Sector Scope and Index Mover.
//
// This replaced a direct NSE client. NSE needed a browser-like cookie handshake, tarpitted
// on bursts, took three index calls plus a merge to assemble the universe, and needed a
// coverage guard because it would silently answer with half of it. Upstox takes up to 500
// instruments in ONE request, so the entire app's universe — every F&O stock, every sector
// basket member, every index constituent, plus the index levels — is a single call.
//
// Two fields NSE gave outright have to be derived here, and both were checked against NSE
// for the same instant before the switch (8/8 symbols, exact):
//
//   previousClose = last_price − net_change      (NSE previousClose, to the paisa)
//   turnover      = average_price × volume       (NSE totalTradedValue, 0.00% drift)
//
// `ohlc` is the CURRENT session's open/high/low/close, not the previous day's — confirmed
// against NSE's own index numbers for 31-Jul-2026 (open 24361.45, high 24429.4, low
// 24299.7, close 24383.6, all exact). Worth stating because broker APIs differ on this and
// reading `ohlc.close` as the previous close would quietly break every percentage.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { INDEX_QUOTE_KEY, INDEX_MEMBERS } from './indices.js';
import { SECTOR_BASKETS } from './sectors.js';
import { call } from './upstox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MASTER_CACHE = path.join(__dirname, '..', '.cache', 'instruments.json');

/** Upstox's published instrument master. A static asset, not the rate-limited API. */
const MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

/** Upstox takes at most 500 instrument keys per quote request. */
const MAX_KEYS = 500;

const DAY_MS = 24 * 60 * 60e3;

export interface EquityQuote {
  Symbol: string;
  ltp: number;
  prevClose: number;
  pChange: number;
  open: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  /** ₹ crore, matching what NSE reported as totalTradedValue. */
  turnover: number;
}

/* ------------------------------------------------------------- instrument master --- */

interface Master {
  /** NSE_EQ trading symbol -> instrument key. */
  equity: Record<string, string>;
  /** Stock symbols that have equity derivatives — the option-tradable universe. */
  fno: string[];
  at: number;
}

let master: Master | null = null;
let loadingMaster: Promise<Master> | null = null;

interface RawInstrument {
  segment?: string; trading_symbol?: string; instrument_key?: string;
  instrument_type?: string; underlying_type?: string; underlying_symbol?: string;
}

async function fetchMaster(): Promise<Master> {
  const res = await fetch(MASTER_URL, { signal: AbortSignal.timeout(60e3) });
  if (!res.ok) throw new Error(`Upstox instrument master -> ${res.status}`);
  const rows = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8')) as RawInstrument[];

  // `instrument_type === 'EQ'` is load-bearing, not tidiness. The NSE_EQ segment also
  // carries that issuer's listed debt under the SAME trading symbol — CHOLAFIN appears
  // twice, as INE121A01024 (EQ, the share) and INE121A08PJ0 (D1, a bond) — so keying on
  // trading_symbol alone lets whichever row comes last win. It picked the bond, which has
  // no quote and so vanished from the board; had the bond been priced, its price would have
  // been drawn as the stock's, which is the kind of wrong nobody would spot.
  const equity: Record<string, string> = {};
  for (const r of rows)
    if (r.segment === 'NSE_EQ' && r.instrument_type === 'EQ' && r.trading_symbol && r.instrument_key)
      equity[r.trading_symbol] = r.instrument_key;

  // The F&O universe read off the futures contracts rather than a maintained list: a stock
  // has options exactly when it has equity derivatives listed. This is what NSE's
  // /api/master-quote used to answer.
  const fno = [...new Set(
    rows
      .filter((r) => r.segment === 'NSE_FO' && r.instrument_type === 'FUT' && r.underlying_type === 'EQUITY')
      .map((r) => r.underlying_symbol)
      .filter((s): s is string => !!s),
  )].sort();

  if (Object.keys(equity).length < 1000) throw new Error(`instrument master looks short: ${Object.keys(equity).length} equities`);
  if (fno.length < 100) throw new Error(`instrument master listed only ${fno.length} F&O underlyings`);
  return { equity, fno, at: Date.now() };
}

/**
 * The instrument master, cached in memory for a day and on disk across restarts.
 *
 * On disk because it is a ~2 MB gzip download and a cold start would otherwise pay for it
 * before the first page could render. Stale-but-usable beats blocking: if the download
 * fails and a cached copy exists, the cached copy is served whatever its age, because an
 * instrument key does not change once assigned.
 */
export async function instruments(): Promise<Master> {
  if (master && Date.now() - master.at < DAY_MS) return master;
  if (loadingMaster) return loadingMaster;

  loadingMaster = (async () => {
    const disk = await fs.readFile(MASTER_CACHE, 'utf8').then((t) => JSON.parse(t) as Master).catch(() => null);
    if (disk && Date.now() - disk.at < DAY_MS) { master = disk; return disk; }
    try {
      const fresh = await fetchMaster();
      await fs.mkdir(path.dirname(MASTER_CACHE), { recursive: true }).catch(() => {});
      await fs.writeFile(MASTER_CACHE, JSON.stringify(fresh), 'utf8').catch(() => {});
      master = fresh;
      return fresh;
    } catch (e) {
      if (disk) { master = disk; return disk; } // any age beats nothing
      throw e;
    }
  })().finally(() => { loadingMaster = null; });

  return loadingMaster;
}

/** Stock symbols with equity derivatives — Market Pulse's universe. */
export const fnoSymbols = async (): Promise<string[]> => (await instruments()).fno;

/* ---------------------------------------------------------------------- quotes --- */

interface RawQuote {
  symbol?: string;
  /** Echoes back the instrument key that was requested — the only reliable way home. */
  instrument_token?: string;
  last_price?: number;
  net_change?: number;
  volume?: number;
  average_price?: number;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
}

function normalise(symbol: string, q: RawQuote): EquityQuote | null {
  const ltp = q.last_price;
  if (!ltp || !Number.isFinite(ltp)) return null;
  const net = q.net_change ?? 0;
  const prevClose = +(ltp - net).toFixed(2);
  const volume = q.volume ?? 0;
  const avg = q.average_price ?? 0;
  return {
    Symbol: symbol,
    ltp,
    prevClose,
    pChange: prevClose > 0 ? +((net / prevClose) * 100).toFixed(2) : 0,
    // Before the first trade of the day `ohlc.open` is 0; the previous close is the honest
    // stand-in, since that is where the stock still is.
    open: q.ohlc?.open || prevClose,
    dayHigh: q.ohlc?.high || ltp,
    dayLow: q.ohlc?.low || ltp,
    volume,
    turnover: +((avg * volume) / 1e7).toFixed(2), // ₹ -> ₹Cr
  };
}

/**
 * Every symbol any page needs, as one set.
 *
 * Deliberately the union rather than per-page lists: it comes to roughly 300 instruments,
 * under Upstox's 500-per-request cap, so the whole app is served by a single call and a
 * single cache entry instead of three overlapping fetches.
 */
async function universe(): Promise<string[]> {
  const { fno } = await instruments();
  return [...new Set([
    ...fno,
    ...Object.values(SECTOR_BASKETS).flat(),
    ...Object.values(INDEX_MEMBERS).flat(),
  ])];
}

const TTL_OPEN = 15e3;
const TTL_CLOSED = 10 * 60e3;
let quoteCache: { at: number; v: Map<string, EquityQuote> } | null = null;
let loadingQuotes: Promise<Map<string, EquityQuote>> | null = null;

/**
 * Live quotes for the whole universe, keyed by symbol, plus the index levels.
 *
 * Index levels ride along under their `NSE_INDEX|…` names so Index Mover's headline needs
 * no extra request. Upstox answers a batch even when some keys are unknown, so a symbol it
 * cannot price is simply absent rather than failing the call.
 */
export async function allQuotes(marketOpen = false): Promise<Map<string, EquityQuote>> {
  const hit = quoteCache;
  if (hit && Date.now() - hit.at < (marketOpen ? TTL_OPEN : TTL_CLOSED)) return hit.v;
  if (loadingQuotes) return loadingQuotes;

  loadingQuotes = (async () => {
    const { equity } = await instruments();
    const symbols = await universe();

    // symbol -> key for the stocks, plus the index levels under their own names.
    const wanted = new Map<string, string>();
    for (const s of symbols) { const k = equity[s]; if (k) wanted.set(s, k); }
    for (const [name, key] of Object.entries(INDEX_QUOTE_KEY)) wanted.set(name, key);

    const byKey = new Map<string, string>([...wanted].map(([sym, key]) => [key, sym]));
    const keys = [...wanted.values()];

    const out = new Map<string, EquityQuote>();
    for (let i = 0; i < keys.length; i += MAX_KEYS) {
      const slice = keys.slice(i, i + MAX_KEYS);
      const data = await call<Record<string, RawQuote>>(
        `/v2/market-quote/quotes?instrument_key=${encodeURIComponent(slice.join(','))}`,
      );
      for (const q of Object.values(data ?? {})) {
        // Mapped by instrument_token, which echoes the key that was requested. NOT by
        // `symbol`: an index answers with symbol "NA", so keying on it silently dropped
        // every index level while looking like it had worked.
        const sym = byKey.get(String(q.instrument_token));
        if (!sym) continue;
        const row = normalise(sym, q);
        if (row) out.set(sym, row);
      }
    }

    // A partial universe renders as a plausible but wrong board — the same failure the old
    // NSE guard existed for. Refuse it so the caller can serve the last good snapshot.
    if (out.size < wanted.size * 0.7)
      throw new Error(`partial universe: Upstox priced ${out.size}/${wanted.size} instruments`);

    quoteCache = { at: Date.now(), v: out };
    return out;
  })().finally(() => { loadingQuotes = null; });

  return loadingQuotes;
}

/** Quotes for a named subset, in the order asked for, skipping anything unpriced. */
export async function quotesFor(symbols: string[], marketOpen = false): Promise<EquityQuote[]> {
  const all = await allQuotes(marketOpen);
  return symbols.map((s) => all.get(s)).filter((q): q is EquityQuote => !!q);
}

/* ------------------------------------------------------------- daily candles --- */

/** [epoch, open, high, low, close, volume] for one instrument, oldest first. */
export type DailyBar = [number, number, number, number, number, number];

/**
 * Daily bars for one symbol — the R.Factor baseline's raw material.
 *
 * One request per symbol, where NSE's Bhavcopy gave every symbol for one day per request.
 * That inverts the cost: a 50-session baseline over ~300 symbols is ~300 requests instead
 * of 50, but each is small, it runs once a day behind a disk cache, and 300 sits well
 * inside Upstox's 500-per-minute allowance.
 */
export async function dailyBars(symbol: string, from: string, to: string): Promise<DailyBar[]> {
  const { equity } = await instruments();
  const key = equity[symbol];
  if (!key) return [];
  const raw = await call<{ candles?: Array<[string, ...number[]]> }>(
    `/v3/historical-candle/${encodeURIComponent(key)}/days/1/${to}/${from}`,
  );
  return (raw?.candles ?? [])
    .map((c) => [
      Math.floor(new Date(c[0] as unknown as string).getTime() / 1000),
      c[1], c[2], c[3], c[4], c[5] ?? 0,
    ] as DailyBar)
    .sort((a, b) => a[0] - b[0]);
}

/** The symbols the R.Factor baseline needs history for. */
export const baselineSymbols = universe;
