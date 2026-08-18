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
import { feedTick, feedUsable, subscribeKeys } from './feed/client.js';
// The candle breaker lives under momentum/ because that is where it was first needed, but it
// is a leaf module with no imports of its own and the budget it guards is per-ENDPOINT, not
// per-feature. Two callers share `/v3/historical-candle`: this file's `dailyBars` and the
// momentum baseline. Until both went through the same breaker they could not see each other,
// and the R.Factor rebuild below would quietly spend the whole 30-minute budget that the
// morning ATR build then needed. See the note on `dailyBars`.
// Imported from `throttle.js` rather than `candles.js` — candles.ts reaches session.ts, which
// re-exports from services.ts, which imports THIS file. throttle.ts imports nothing at all, so
// taking the constant from there keeps the graph acyclic.
import {
  acquire, assertNotThrottled, CANDLE_ENDPOINT, noteRefusal, noteSuccess,
} from './momentum/data/throttle.js';

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

/** One listed futures contract on a stock or index underlying. */
export interface FuturesContract {
  instrumentKey: string;
  tradingSymbol: string;
  /** Expiry as epoch ms, which is how the master carries it for FUT rows. */
  expiry: number;
  lotSize: number;
}

interface Master {
  /** NSE_EQ trading symbol -> instrument key. */
  equity: Record<string, string>;
  /** Stock symbols that have equity derivatives — the option-tradable universe. */
  fno: string[];
  /**
   * Underlying symbol -> its listed futures, NEAREST EXPIRY FIRST.
   *
   * Read off the same master rather than fetched separately, because the momentum scanner
   * needs open interest and OI lives on the FUTURE, not the share: an NSE_EQ quote answers
   * `oi: 0` by definition. Index underlyings (NIFTY, BANKNIFTY) are carried too — the index
   * itself publishes no volume, so its future is the only place an index VWAP exists.
   */
  futures: Record<string, FuturesContract[]>;
  /** NSE_INDEX trading symbol, UPPERCASED -> instrument key. Sector strength reads this. */
  indices: Record<string, string>;
  at: number;
  /**
   * Disk-cache format. Bump when the shape above changes: a v1 file has no `futures`, and
   * reading it back would look like "this account has no derivatives" rather than "this
   * cache predates the field", which is the kind of empty that gets debugged for an hour.
   */
  v?: number;
}

const MASTER_VERSION = 2;

let master: Master | null = null;
let loadingMaster: Promise<Master> | null = null;

interface RawInstrument {
  segment?: string; trading_symbol?: string; instrument_key?: string;
  instrument_type?: string; underlying_type?: string; underlying_symbol?: string;
  expiry?: number; lot_size?: number; name?: string;
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

  // Futures, grouped by underlying and sorted nearest-expiry-first. The near month is the
  // liquid one and the only contract worth reading open interest off; the far months are
  // kept so a caller can roll on expiry day rather than reading a dying contract.
  const futures: Record<string, FuturesContract[]> = {};
  for (const r of rows) {
    if (r.segment !== 'NSE_FO' || r.instrument_type !== 'FUT') continue;
    if (!r.instrument_key || !r.underlying_symbol) continue;
    (futures[r.underlying_symbol] ??= []).push({
      instrumentKey: r.instrument_key,
      tradingSymbol: r.trading_symbol ?? '',
      expiry: r.expiry ?? 0,
      lotSize: r.lot_size ?? 0,
    });
  }
  for (const list of Object.values(futures)) list.sort((a, b) => a.expiry - b.expiry);

  // Every NSE index Upstox prices, keyed by its uppercased trading symbol. The scanner maps
  // a stock's sector onto one of these; hand-listing them would go stale the next time NSE
  // launches an index.
  const indices: Record<string, string> = {};
  for (const r of rows)
    if (r.segment === 'NSE_INDEX' && r.instrument_key)
      indices[(r.trading_symbol ?? r.name ?? '').toUpperCase()] = r.instrument_key;

  if (Object.keys(equity).length < 1000) throw new Error(`instrument master looks short: ${Object.keys(equity).length} equities`);
  if (fno.length < 100) throw new Error(`instrument master listed only ${fno.length} F&O underlyings`);
  if (Object.keys(futures).length < 100) throw new Error(`instrument master listed futures for only ${Object.keys(futures).length} underlyings`);
  return { equity, fno, futures, indices, at: Date.now(), v: MASTER_VERSION };
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
    const raw = await fs.readFile(MASTER_CACHE, 'utf8').then((t) => JSON.parse(t) as Master).catch(() => null);
    // An older-format file is not "stale data", it is data with fields missing — re-download
    // rather than serve it, or every futures lookup silently answers undefined.
    const disk = raw && (raw.v ?? 1) >= MASTER_VERSION ? raw : null;
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

/**
 * The nearest listed future for an underlying, skipping one that expires today.
 *
 * On expiry day the near contract stops carrying the position — open interest collapses
 * into the next month through the session — so reading a build-up off it would report mass
 * "long unwinding" across the whole board. Rolling a day early is the conventional fix.
 */
export async function nearFuture(symbol: string, nowMs = Date.now()): Promise<FuturesContract | null> {
  const list = (await instruments()).futures[symbol] ?? [];
  return list.find((c) => c.expiry > nowMs + 6 * 60 * 60e3) ?? list[0] ?? null;
}

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

    // The live feed serves this the same way it serves the scanner's tier — see
    // `feed/client.ts`. Everything `EquityQuote` needs is on it: LTPC gives the price and the
    // previous close, the `1d` OHLC candle gives open/high/low, `vtt` is the volume and
    // `atp × vtt` is the turnover. Indices report no volume or average price, but REST
    // answered `null` for both on an index too, so nothing changes for them.
    subscribeKeys(keys);
    if (feedUsable(keys, marketOpen)) {
      for (const [sym, key] of wanted) {
        const t = feedTick(key);
        if (!t || t.ltp <= 0) continue;
        const prevClose = t.cp;
        out.set(sym, {
          Symbol: sym,
          ltp: t.ltp,
          prevClose,
          pChange: prevClose > 0 ? +(((t.ltp - prevClose) / prevClose) * 100).toFixed(2) : 0,
          open: t.dayOpen || prevClose,
          dayHigh: t.dayHigh || t.ltp,
          dayLow: t.dayLow || t.ltp,
          volume: t.vtt,
          turnover: +((t.atp * t.vtt) / 1e7).toFixed(2), // ₹ -> ₹Cr
        });
      }
      if (out.size >= wanted.size * 0.7) {
        quoteCache = { at: Date.now(), v: out };
        return out;
      }
      // Under the floor the feed is not serving this board — fall through to REST rather
      // than cache a thin one, which is the same judgement the guard below makes.
      out.clear();
    }

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
 * Run a `/v3/historical-candle` call under the shared endpoint breaker.
 *
 * Deliberately the same shape as `withRetry` in `momentum/data/candles.ts` — three attempts,
 * jittered exponential backoff, only 429 and 5xx retried — because the two are spending the
 * same budget and backing off at different rates would just hand the budget to whichever was
 * greedier. It is duplicated rather than shared for the import-cycle reason noted at the top
 * of this file; the breaker state itself IS shared, which is the part that matters.
 */
async function withCandleRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let wait = 400;
  for (let i = 0; ; i++) {
    // Throws immediately once the breaker is open, without touching the network. This is what
    // stops a 213-symbol R.Factor rebuild from firing 213 doomed requests into a spent quota.
    assertNotThrottled(CANDLE_ENDPOINT);
    // The same governor the momentum candles go through, and it has to be the same one: this
    // endpoint has a single per-user budget, so two callers pacing themselves independently
    // would still add up to double the published rate.
    await acquire(CANDLE_ENDPOINT);
    try {
      const v = await fn();
      noteSuccess(CANDLE_ENDPOINT);
      return v;
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 429) noteRefusal(CANDLE_ENDPOINT);
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, wait + Math.random() * wait));
      wait *= 2;
    }
  }
}

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

  // THIS GOES THROUGH THE BREAKER, and it did not used to. `/v3/historical-candle` has one
  // 2000-per-30-minute budget shared by every caller, and there are two: the R.Factor rebuild
  // in volume.ts (~213 requests, fired whenever the dashboard asks for Market Pulse) and the
  // morning ATR baseline (~416). Without a shared breaker neither could see the other, so the
  // R.Factor rebuild would spend the budget and the ATR build — the polite one, which backs
  // off — lost every time. That is why `.cache/momentum/baseline.json` never once existed.
  //
  // Refusals are recorded so the breaker actually learns from them, and 429/5xx get the same
  // bounded retry the momentum candle helpers use. A 400 or 404 is a permanent answer and is
  // not retried; retrying it only spends more of the budget confirming it.
  const raw = await withCandleRetry(() =>
    call<{ candles?: Array<[string, ...number[]]> }>(
      `/v3/historical-candle/${encodeURIComponent(key)}/days/1/${to}/${from}`,
    ),
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
