// Upstox client — the PCR source for Option Apex.
//
// Auth is one header, `Authorization: Bearer <token>`, and the token this expects is an
// **Analytics Token**: read-only, generated once from the Upstox developer console and
// valid for a year. That matters — the ordinary OAuth access token expires daily at 03:30
// IST, which would take the dials dark every morning on an unattended deployment.
//
// Two endpoints, and which is which is deliberate:
//
//   /v2/option/chain   the ratio and the open-interest totals.  PRIMARY.
//                      Explicitly on Upstox's Analytics-Token list, so it is the one
//                      thing here guaranteed to answer with the token we have.
//
//   /v2/market/pcr     the intraday PCR series, for the trend under the dial.  BONUS.
//                      Not named on that list, so it is called best-effort: if the token
//                      isn't entitled to it the trend is simply absent and the ratio —
//                      which came from the chain — is unaffected.
//
// Nothing here ever invents a ratio. A missing token, an expired one or a refused request
// all surface as an error the page reports.

import type { Result } from './services.js';

const BASE = 'https://api.upstox.com';
const TIMEOUT_MS = Number(process.env.UPSTOX_TIMEOUT_MS) || 8000;

/**
 * Our index keys -> Upstox instrument keys.
 *
 * Read off Upstox's own instruments master
 * (assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz, segment NSE_INDEX)
 * rather than guessed — the names are not the trading symbols, and `NSE_INDEX|BANKNIFTY`
 * is rejected where `NSE_INDEX|Nifty Bank` is accepted.
 */
export const INSTRUMENT_KEY: Record<string, string> = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'NIFTY BANK': 'NSE_INDEX|Nifty Bank',
  FINNIFTY: 'NSE_INDEX|Nifty Fin Service',
  MIDCPNIFTY: 'NSE_INDEX|NIFTY MID SELECT',
};

const token = () => process.env.UPSTOX_ACCESS_TOKEN ?? '';
export const tokenSet = () => !!token();

const IST_OFFSET_S = 330 * 60;

class UpstoxError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(path: string): Promise<T> {
  const bearer = token();
  if (!bearer)
    throw new UpstoxError(
      'UPSTOX_ACCESS_TOKEN is not set — put your Upstox Analytics Token in api/.env', 0,
    );

  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as
    | { status?: string; data?: T; errors?: Array<{ errorCode?: string; message?: string }> }
    | null;

  if (!res.ok) {
    const e = body?.errors?.[0];
    const detail = e ? `: ${e.errorCode ?? ''} ${e.message ?? ''}`.trimEnd() : '';
    // 401 on an Analytics Token means revoked or mistyped rather than the daily expiry the
    // ordinary access token has — saying which turns a blank dial into a one-line fix.
    if (res.status === 401)
      throw new UpstoxError(
        `Upstox rejected the token (401)${detail} — an Analytics Token is revoked when a new one is generated, ` +
        'so check api/.env holds the current one',
        401,
      );
    throw new UpstoxError(`Upstox ${path.split('?')[0]} -> ${res.status}${detail}`, res.status);
  }
  if (body?.data == null) throw new UpstoxError(`Upstox ${path.split('?')[0]} returned no data`, res.status);
  return body.data;
}

/* ------------------------------------------------------------------ option chain --- */

export interface ChainLeg {
  oi: number;
  prevOi: number;
  ltp: number;
  bid: number;
  ask: number;
  volume: number;
  iv: number;
}
export interface ChainRow { strike: number; ce: ChainLeg | null; pe: ChainLeg | null; }

export interface UpstoxChain {
  instrumentKey: string;
  expiry: string;
  spot: number;
  rows: ChainRow[];
  /** Whole-chain put OI ÷ call OI. */
  pcr: number;
  putOi: number;
  callOi: number;
}

interface RawLeg {
  market_data?: { ltp?: number; oi?: number; prev_oi?: number; bid_price?: number; ask_price?: number; volume?: number };
  option_greeks?: { iv?: number };
}
interface RawRow {
  expiry?: string;
  strike_price?: number;
  underlying_spot_price?: number;
  call_options?: RawLeg;
  put_options?: RawLeg;
}

const leg = (r: RawLeg | undefined): ChainLeg | null => {
  const m = r?.market_data;
  if (!m) return null;
  return {
    oi: m.oi ?? 0,
    prevOi: m.prev_oi ?? 0,
    ltp: m.ltp ?? 0,
    bid: m.bid_price ?? 0,
    ask: m.ask_price ?? 0,
    volume: m.volume ?? 0,
    iv: r?.option_greeks?.iv ?? 0,
  };
};

// The chain is one upstream call shared by every caller in the window. Upstox counts
// requests against the token and the page polls, so a reading stands for a while; a closed
// session never changes at all and is held far longer.
const TTL_OPEN = 45e3;
const TTL_CLOSED = 30 * 60e3;
const chainCache = new Map<string, { at: number; v: UpstoxChain }>();

/**
 * The full option chain for one expiry, with the whole-chain ratio.
 *
 * PCR is summed over EVERY strike Upstox returns, not a window around ATM. That is the
 * ratio as normally quoted, and it is the substantive difference from deriving it off the
 * recorded ladder, which only ever held the strikes near the money.
 */
export async function optionChain(
  script: string, expiry: string, marketOpen = false,
): Promise<Result<UpstoxChain>> {
  const key = INSTRUMENT_KEY[script];
  if (!key) throw new Error(`no Upstox instrument key mapped for "${script}"`);

  const cacheKey = `${script}|${expiry}`;
  const hit = chainCache.get(cacheKey);
  if (hit && Date.now() - hit.at < (marketOpen ? TTL_OPEN : TTL_CLOSED))
    return { source: 'upstox', data: hit.v };

  const raw = await call<RawRow[]>(
    `/v2/option/chain?instrument_key=${encodeURIComponent(key)}&expiry_date=${encodeURIComponent(expiry)}`,
  );
  if (!Array.isArray(raw) || !raw.length)
    throw new Error(`Upstox served an empty option chain for ${script} ${expiry}`);

  const rows: ChainRow[] = raw
    .filter((r) => typeof r.strike_price === 'number')
    .map((r) => ({ strike: r.strike_price!, ce: leg(r.call_options), pe: leg(r.put_options) }))
    .sort((a, b) => a.strike - b.strike);

  let callOi = 0, putOi = 0;
  for (const r of rows) { callOi += r.ce?.oi ?? 0; putOi += r.pe?.oi ?? 0; }
  if (callOi <= 0) throw new Error(`Upstox chain for ${script} ${expiry} carries no call open interest`);

  const data: UpstoxChain = {
    instrumentKey: key,
    expiry: raw[0].expiry ?? expiry,
    spot: raw.find((r) => r.underlying_spot_price)?.underlying_spot_price ?? 0,
    rows,
    pcr: +(putOi / callOi).toFixed(3),
    putOi,
    callOi,
  };
  chainCache.set(cacheKey, { at: Date.now(), v: data });
  return { source: 'upstox', data };
}

/* --------------------------------------------------------------------- contracts --- */

export interface Contract {
  instrumentKey: string;
  expiry: string;        // YYYY-MM-DD
  weekly: boolean;
  strike: number;
  side: 'CE' | 'PE';
  lotSize: number;
}

interface RawContract {
  instrument_key?: string; expiry?: string; weekly?: boolean;
  strike_price?: number; instrument_type?: string; lot_size?: number;
}

// The contract master for an underlying changes when a new expiry is introduced, i.e.
// weekly at most. Held for a day; it is ~1500 rows and every ladder call needs it.
const DAY_MS = 24 * 60 * 60e3;
const contractCache = new Map<string, { at: number; v: Contract[] }>();

/**
 * Every listed option contract for an underlying — expiries, strikes and lot size.
 *
 * This is what makes the expiry list and the lot size Upstox's rather than ours. The lot
 * size especially: it was previously a hand-maintained table here, and a hand-maintained
 * table is wrong the day after NSE revises one, silently scaling every rupee figure on
 * the page.
 */
export async function contracts(script: string): Promise<Contract[]> {
  const key = INSTRUMENT_KEY[script];
  if (!key) throw new Error(`no Upstox instrument key mapped for "${script}"`);

  const hit = contractCache.get(script);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.v;

  const raw = await call<RawContract[]>(`/v2/option/contract?instrument_key=${encodeURIComponent(key)}`);
  const out: Contract[] = (raw ?? [])
    .filter((c) => c.instrument_key && c.expiry && (c.instrument_type === 'CE' || c.instrument_type === 'PE'))
    .map((c) => ({
      instrumentKey: c.instrument_key!,
      expiry: c.expiry!.slice(0, 10),
      weekly: !!c.weekly,
      strike: c.strike_price ?? 0,
      side: c.instrument_type as 'CE' | 'PE',
      lotSize: c.lot_size ?? 0,
    }));
  if (!out.length) throw new Error(`Upstox listed no option contracts for ${script}`);
  contractCache.set(script, { at: Date.now(), v: out });
  return out;
}

/** Listed expiries for an underlying, nearest first, each flagged weekly or monthly. */
export async function expiries(script: string): Promise<Array<{ date: string; weekly: boolean }>> {
  const byDate = new Map<string, boolean>();
  for (const c of await contracts(script)) if (!byDate.has(c.expiry)) byDate.set(c.expiry, c.weekly);
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, weekly]) => ({ date, weekly }));
}

/** Contract size for an underlying, straight from Upstox rather than a table we maintain. */
export async function lotSize(script: string, expiry?: string): Promise<number> {
  const all = await contracts(script);
  const scoped = expiry ? all.filter((c) => c.expiry === expiry) : all;
  const lot = (scoped[0] ?? all[0])?.lotSize;
  if (!lot) throw new Error(`Upstox reported no lot size for ${script}`);
  return lot;
}

/* --------------------------------------------------------------- candles & ladder --- */

/** [epoch seconds, open, high, low, close, volume, open interest]. */
export type UpstoxCandle = [number, number, number, number, number, number, number];

const isoToEpoch = (s: string) => Math.floor(new Date(s).getTime() / 1000);

/**
 * Candles for one instrument on one IST trading day, OLDEST FIRST.
 *
 * Upstox returns them newest-first, which is the opposite of every other series in this
 * app and exactly the kind of thing that produces a silently reversed chart, so they are
 * flipped here once rather than at each call site.
 *
 * Element 7 is open interest, which is the whole reason Option Clock can stop recording:
 * the OI ladder as it stood at 11:03 is served retroactively, for any past session.
 */
export async function candles(
  instrumentKey: string, day: string, unit: 'minutes' | 'days' = 'minutes', interval = 5,
): Promise<UpstoxCandle[]> {
  const enc = encodeURIComponent(instrumentKey);
  const raw = await call<{ candles?: Array<[string, ...number[]]> }>(
    `/v3/historical-candle/${enc}/${unit}/${interval}/${day}/${day}`,
  );
  const rows = raw?.candles ?? [];
  return rows
    .map((c) => [isoToEpoch(c[0] as unknown as string), c[1], c[2], c[3], c[4], c[5] ?? 0, c[6] ?? 0] as UpstoxCandle)
    .sort((a, b) => a[0] - b[0]);
}

/** Daily candles across a date range — the official close, and the one before it. */
export async function dailyCandles(instrumentKey: string, from: string, to: string): Promise<UpstoxCandle[]> {
  const enc = encodeURIComponent(instrumentKey);
  const raw = await call<{ candles?: Array<[string, ...number[]]> }>(
    `/v3/historical-candle/${enc}/days/1/${to}/${from}`,
  );
  return (raw?.candles ?? [])
    .map((c) => [isoToEpoch(c[0] as unknown as string), c[1], c[2], c[3], c[4], c[5] ?? 0, c[6] ?? 0] as UpstoxCandle)
    .sort((a, b) => a[0] - b[0]);
}

/** Today's candles so far. Separate endpoint — the historical one doesn't cover today. */
export async function intradayCandles(
  instrumentKey: string, unit: 'minutes' | 'days' = 'minutes', interval = 5,
): Promise<UpstoxCandle[]> {
  const enc = encodeURIComponent(instrumentKey);
  const raw = await call<{ candles?: Array<[string, ...number[]]> }>(
    `/v3/historical-candle/intraday/${enc}/${unit}/${interval}`,
  );
  const rows = raw?.candles ?? [];
  return rows
    .map((c) => [isoToEpoch(c[0] as unknown as string), c[1], c[2], c[3], c[4], c[5] ?? 0, c[6] ?? 0] as UpstoxCandle)
    .sort((a, b) => a[0] - b[0]);
}

/**
 * A session's candles for an instrument, whichever endpoint covers the day asked for.
 *
 * Today is only on the intraday endpoint and past days only on the historical one, and
 * asking the wrong one answers 200 with an empty array — which reads as "nothing traded"
 * rather than "wrong endpoint". Picking here means no caller can get that wrong.
 */
export async function sessionCandles(
  instrumentKey: string, day: string, today: string, unit: 'minutes' | 'days' = 'minutes', interval = 5,
): Promise<UpstoxCandle[]> {
  if (day !== today) return candles(instrumentKey, day, unit, interval);
  const live = await intradayCandles(instrumentKey, unit, interval);
  // Before the first candle of the day lands the intraday endpoint is legitimately empty.
  return live;
}

// Upstox caps concurrent requests per token; a full ladder is ~42 of them. Eight at a
// time measured ~21ms per contract with no rejections, and keeps well clear of the limit.
const LADDER_BATCH = 8;

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

/** Open interest for one strike's two legs, through the session. */
export interface LadderStrike {
  strike: number;
  /** epoch -> open interest, in UNITS (Upstox's convention, not NSE's contracts). */
  ce: Map<number, number>;
  pe: Map<number, number>;
  /** Last traded price per candle, for the money-flux valuation. */
  cePrice: Map<number, number>;
  pePrice: Map<number, number>;
}

export interface Ladder {
  day: string;
  expiry: string;
  /**
   * Contract size, for reference only. NOT a multiplier for the open interest below:
   * Upstox quotes OI in UNITS, not contracts (verified against NSE for the same strike —
   * Upstox reads the lot size larger), so OI × price is already rupees.
   */
  lotSize: number;
  /** Every candle timestamp seen across the ladder, oldest first. */
  times: number[];
  strikes: LadderStrike[];
}

/**
 * The OI ladder through a whole session — the thing that used to require a recorder.
 *
 * One call per contract, so a ±10-strike ladder is 42 requests; batched, that measured
 * under a second. A past session never changes, so it is cached hard.
 */
const ladderCache = new Map<string, { at: number; v: Ladder }>();

export async function ladder(
  script: string, expiry: string, day: string, today: string,
  atm: number, window = 10, interval = 5,
): Promise<Ladder> {
  const all = await contracts(script);
  const forExpiry = all.filter((c) => c.expiry === expiry);
  if (!forExpiry.length) throw new Error(`Upstox lists no contracts for ${script} expiring ${expiry}`);

  const strikes = [...new Set(forExpiry.map((c) => c.strike))].sort((a, b) => a - b);
  const step = Math.min(...strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0));
  const wanted = strikes.filter((s) => Math.abs(s - atm) <= window * step);

  const cacheKey = `${script}|${expiry}|${day}|${wanted[0]}-${wanted[wanted.length - 1]}|${interval}`;
  const hit = ladderCache.get(cacheKey);
  // A finished session is immutable; today's is still being written.
  if (hit && Date.now() - hit.at < (day === today ? 45e3 : 6 * 60 * 60e3)) return hit.v;

  const legs = forExpiry.filter((c) => wanted.includes(c.strike));
  const series = new Map<string, UpstoxCandle[]>();
  await inBatches(legs, LADDER_BATCH, async (c) => {
    // One dead contract must not lose the whole ladder — it reads as an empty leg.
    try { series.set(c.instrumentKey, await sessionCandles(c.instrumentKey, day, today, 'minutes', interval)); }
    catch { series.set(c.instrumentKey, []); }
  });

  const times = new Set<number>();
  const rows: LadderStrike[] = wanted.map((strike) => {
    const row: LadderStrike = { strike, ce: new Map(), pe: new Map(), cePrice: new Map(), pePrice: new Map() };
    for (const c of legs.filter((l) => l.strike === strike)) {
      const oi = c.side === 'CE' ? row.ce : row.pe;
      const px = c.side === 'CE' ? row.cePrice : row.pePrice;
      for (const k of series.get(c.instrumentKey) ?? []) {
        oi.set(k[0], k[6]);
        px.set(k[0], k[4]);
        times.add(k[0]);
      }
    }
    return row;
  });

  const v: Ladder = {
    day, expiry,
    lotSize: legs[0]?.lotSize || (await lotSize(script, expiry)),
    times: [...times].sort((a, b) => a - b),
    strikes: rows,
  };
  ladderCache.set(cacheKey, { at: Date.now(), v });
  return v;
}

/* -------------------------------------------------------------------- pcr series --- */

/** One reading of the ratio through the day. */
export interface PcrReading { ts: number; time: string; pcr: number; spot: number }

/** "09:15" on a given IST day -> epoch seconds. */
function istAt(day: string, hhmm: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mi) / 1000 - IST_OFFSET_S;
}

const seriesCache = new Map<string, { at: number; v: PcrReading[] }>();

/**
 * The day's PCR as a series, so the dial has a history behind it.
 *
 * Best-effort by design: `/v2/market/pcr` is not on Upstox's published Analytics-Token
 * list, so a 401/403/404 here means "this token isn't entitled to it", which is a missing
 * nicety and not a failure. Returns an empty series in that case and lets the caller draw
 * the dial without a trend, rather than failing a panel whose headline number came from
 * the option chain and is perfectly fine.
 */
export async function pcrSeries(
  script: string, expiry: string, day: string, bucketMinutes = 15, marketOpen = false,
): Promise<{ readings: PcrReading[]; bucketMinutes: number; unavailable?: string }> {
  const key = INSTRUMENT_KEY[script];
  const bucket = Math.max(1, Math.round(bucketMinutes));
  if (!key || !tokenSet()) return { readings: [], bucketMinutes: bucket };

  const cacheKey = `${script}|${expiry}|${day}|${bucket}`;
  const hit = seriesCache.get(cacheKey);
  if (hit && Date.now() - hit.at < (marketOpen ? TTL_OPEN : TTL_CLOSED))
    return { readings: hit.v, bucketMinutes: bucket };

  try {
    const d = await call<{ insights?: Array<{ pcr?: number; spot_price?: number; time?: string }> }>(
      `/v2/market/pcr?instrument_key=${encodeURIComponent(key)}` +
      `&expiry=${encodeURIComponent(expiry)}&date=${encodeURIComponent(day)}&bucket_interval=${bucket}`,
    );
    const readings: PcrReading[] = (d.insights ?? [])
      .filter((r): r is { pcr: number; spot_price: number; time: string } =>
        typeof r.pcr === 'number' && typeof r.time === 'string')
      .map((r) => ({ ts: istAt(day, r.time), time: r.time, pcr: +r.pcr.toFixed(3), spot: r.spot_price ?? 0 }))
      .sort((a, b) => a.ts - b.ts);
    seriesCache.set(cacheKey, { at: Date.now(), v: readings });
    return { readings, bucketMinutes: bucket };
  } catch (e) {
    const err = e as UpstoxError;
    // Cache the "not entitled" answer too — otherwise every poll re-asks an endpoint that
    // has already said no, and burns a request against the token each time.
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      seriesCache.set(cacheKey, { at: Date.now(), v: [] });
      return { readings: [], bucketMinutes: bucket, unavailable: err.message };
    }
    return { readings: [], bucketMinutes: bucket, unavailable: String(err.message) };
  }
}
