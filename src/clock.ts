// Option Clock — served from Upstox.
//
// This page used to be the one thing in the app that needed a recorder. It compares open
// interest at two points in a session, and NSE only ever answers "right now", so the
// chain had to be taped every five minutes through the day and a slot nobody captured was
// gone for good. That is why the PCR trend had "not recorded yet" rows in it.
//
// Upstox removes the problem rather than working around it: its historical candle API
// carries OPEN INTEREST as the seventh element of every candle, per option contract, for
// any past session. So the ladder as it stood at 11:03 is simply fetched. No tape, no
// gaps, no dependency on something having been running at the time — and any of the last
// several months is available, not just what we happened to record.
//
// The payloads are unchanged (`OiSnapshots`, `PcrPoint`, `RunningExpiry`), so the page
// itself needed no rewrite: only where the numbers come from changed.

import type { Result } from './services.js';
import type { OiSnapshots, PcrPoint, RunningExpiry } from './types.js';
import * as upstox from './upstox.js';

/**
 * The index dropdown. Keys are the `script` values the real feed uses; each carries the
 * NSE symbol its contracts are named after, which is what the NFO: keys below spell.
 */
export const SCRIPTS: Record<string, { symbol: string; label: string }> = {
  'NIFTY 50': { symbol: 'NIFTY', label: 'Nifty50' },
  'NIFTY BANK': { symbol: 'BANKNIFTY', label: 'BankNifty' },
  FINNIFTY: { symbol: 'FINNIFTY', label: 'FinNifty' },
  MIDCPNIFTY: { symbol: 'MIDCPNIFTY', label: 'MidCpNifty' },
};
export const DEFAULT_SCRIPT = 'NIFTY 50';

const IST_OFFSET_S = 330 * 60;
const SESSION_S = 6 * 3600 + 15 * 60; // 09:15 to 15:30 IST

/** Epoch (s) of 09:15 IST on a given IST calendar day, "YYYY-MM-DD". */
export function dayOpenEpoch(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000 - IST_OFFSET_S + 9 * 3600 + 15 * 60;
}
const dayCloseEpoch = (day: string) => dayOpenEpoch(day) + SESSION_S;

/**
 * A day's slot times for a step: 09:15, 09:25, … 15:25, then 15:30.
 *
 * The close is appended rather than stepped to, because 09:15 to 15:30 is not a whole
 * number of ten-minute steps and the last reading of the day is the one most worth a row.
 */
export function sessionGrid(step: number, day: string): number[] {
  const open = dayOpenEpoch(day), close = dayCloseEpoch(day);
  const out: number[] = [];
  for (let t = open; t < close; t += step) out.push(t);
  out.push(close);
  return out;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_CODE = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'O', 'N', 'D'];

/** Strikes kept either side of ATM — 10 gives the 21-row ladder the clock draws. */
const STRIKE_WINDOW = 10;
/** The tape's old resolution, kept so the trend's shape is familiar. */
const CANDLE_MIN = 5;

/** The IST calendar day of an epoch. */
const dayOf = (epochS: number) => new Date((epochS + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);
export const todayIST = (nowMs = Date.now()) => dayOf(Math.floor(nowMs / 1000));

const script2 = (script: string) => SCRIPTS[script] ?? SCRIPTS[script?.toUpperCase?.()];

function resolveScript(script: string) {
  const entry = script2(script);
  if (!entry) throw new Error(`unknown script "${script}"`);
  return entry;
}

/* ------------------------------------------------------------------- expiries --- */

/** "2026-08-04" -> epoch (s) of that day at 15:30 IST, how the feed stamps an expiry. */
const expiryEpoch = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000 - IST_OFFSET_S + 15 * 3600 + 30 * 60;
};

/** "2026-08-04" -> "04Aug26", the compact form the feed takes as its `exp` parameter. */
const isoToExpParam = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}${MON[m - 1]}${String(y).slice(2)}`;
};

/** "04Aug26" (or "2026-08-04") -> the ISO expiry Upstox takes. */
function matchExpiry(list: Array<{ date: string; weekly: boolean }>, exp?: string): string {
  if (!exp) return list[0].date;
  const hit = list.find((e) => e.date === exp || isoToExpParam(e.date).toLowerCase() === exp.toLowerCase());
  if (!hit) throw new Error(`expiry ${exp} is not listed for this index`);
  return hit.date;
}

/** Expiries listed today, nearest first. Only future ones — a past expiry has no chain. */
async function listedExpiries(script: string) {
  const today = todayIST();
  const all = await upstox.expiries(resolveScript(script) && script);
  const live = all.filter((e) => e.date >= today);
  if (!live.length) throw new Error(`Upstox lists no unexpired contracts for ${script}`);
  return live;
}

/**
 * The two the page offers: the nearest weekly, and the month's last expiry.
 *
 * Upstox flags each contract weekly or monthly itself, so this no longer has to infer
 * which is which from the shape of the date list.
 */
export async function runningExpiry(script = DEFAULT_SCRIPT): Promise<Result<RunningExpiry[]>> {
  const list = await listedExpiries(script);
  const wk = list[0];
  const monthly = list.find((e) => !e.weekly && e.date !== wk.date);
  const out: RunningExpiry[] = [[expiryEpoch(wk.date), wk.weekly ? 'wk' : 'mo']];
  if (monthly) out.push([expiryEpoch(monthly.date), 'mo']);
  return { source: 'upstox', data: out };
}

/** The compact expiry the page passes around, resolved against what Upstox lists. */
export async function resolveExp(script: string, exp?: string): Promise<string> {
  return matchExpiry(await listedExpiries(script), exp);
}

/* ------------------------------------------------------------------ the ladder --- */

/** NSE-style contract key, kept because the page parses the ladder back out of these. */
function optionKey(symbol: string, isoExpiry: string, weekly: boolean, strike: number, side: 'CE' | 'PE') {
  const [y, m, d] = isoExpiry.split('-').map(Number);
  const yy = String(y).slice(2);
  const code = weekly ? yy + MONTH_CODE[m - 1] + String(d).padStart(2, '0') : yy + MON[m - 1].toUpperCase();
  return `NFO:${symbol}${code}${strike}${side}`;
}

/** Where the index closed on a day — what the ATM strike is centred on. */
async function spotOn(script: string, day: string, today: string): Promise<number> {
  const key = upstox.INSTRUMENT_KEY[script];
  const bars = await upstox.sessionCandles(key, day, today, 'minutes', 30);
  if (bars.length) return bars[bars.length - 1][4];
  // Before the first candle of a live session there is nothing intraday yet; the chain
  // still reports a spot.
  const chain = await upstox.optionChain(script, (await listedExpiries(script))[0].date);
  return chain.data.spot;
}

// The newest day that actually traded. Cheap and asked for on every call, so it is held
// briefly rather than re-derived; it only changes at an open or a close.
let defaultDayCache: { at: number; script: string; day: string } | null = null;

async function defaultDay(script: string): Promise<string> {
  if (defaultDayCache && defaultDayCache.script === script && Date.now() - defaultDayCache.at < 60e3)
    return defaultDayCache.day;
  const { data } = await availableDays(script);
  defaultDayCache = { at: Date.now(), script, day: data[0] };
  return data[0];
}

interface Session {
  ladder: upstox.Ladder;
  atm: number;
  weekly: boolean;
  symbol: string;
  isoExpiry: string;
}

// A page load asks three endpoints for the same session; they share one fetch.
const sessionCache = new Map<string, { at: number; p: Promise<Session> }>();

async function session(script: string, exp?: string, day?: string): Promise<Session> {
  const today = todayIST();
  // NOT today when today hasn't traded. The wall clock says Saturday while the last
  // session was Friday, and defaulting to the calendar asks Upstox for candles that do
  // not exist — which is exactly how this page used to open blank every weekend.
  const on = day || (await defaultDay(script));
  const key = `${script}|${exp ?? ''}|${on}`;
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < (on === today ? 30e3 : 60 * 60e3)) return hit.p;

  const p = (async (): Promise<Session> => {
    const list = await listedExpiries(script);
    const isoExpiry = matchExpiry(list, exp);
    const weekly = list.find((e) => e.date === isoExpiry)?.weekly ?? true;
    const atmSpot = await spotOn(script, on, today);
    const { symbol } = resolveScript(script);
    const strikeStep = atmSpot > 40000 ? 100 : atmSpot > 20000 ? 50 : 25;
    const atm = Math.round(atmSpot / strikeStep) * strikeStep;
    const ladder = await upstox.ladder(script, isoExpiry, on, today, atm, STRIKE_WINDOW, CANDLE_MIN);
    if (!ladder.times.length) throw new Error(`Upstox served no option candles for ${script} on ${on}`);
    return { ladder, atm, weekly, symbol, isoExpiry };
  })();

  sessionCache.set(key, { at: Date.now(), p });
  p.catch(() => sessionCache.delete(key));
  return p;
}

/** The ladder as it stood at (or last before) `ts`, in the feed's snapshot shape. */
function snapshotAt(s: Session, ts: number): { ts: number; snap: Record<string, number> } {
  // The last candle at or before the moment asked for; the earliest if `ts` predates the
  // session, so asking for 09:15 on a day whose first candle is 09:20 answers with 09:20
  // rather than nothing.
  let at = s.ladder.times[0];
  for (const t of s.ladder.times) if (t <= ts) at = t; else break;

  const snap: Record<string, number> = { atm: s.atm };
  for (const row of s.ladder.strikes) {
    // Carry the last reading at or before `at`: a strike that didn't trade in this exact
    // candle still has the open interest it was left holding.
    const pick = (m: Map<number, number>) => {
      let v: number | undefined;
      for (const t of s.ladder.times) { if (t > at) break; if (m.has(t)) v = m.get(t); }
      return v;
    };
    const ce = pick(row.ce), pe = pick(row.pe);
    if (ce != null) snap[optionKey(s.symbol, s.isoExpiry, s.weekly, row.strike, 'CE')] = ce;
    if (pe != null) snap[optionKey(s.symbol, s.isoExpiry, s.weekly, row.strike, 'PE')] = pe;
  }
  return { ts: at, snap };
}

/* -------------------------------------------------------------------- endpoints --- */

/**
 * The session's OI ladder, candle by candle.
 *
 * Exported because Money Flux is computed from exactly the same thing — the candles carry
 * a close price alongside the open interest, which is both halves of its formula. One
 * fetch serves both pages.
 */
export async function sessionLadder(
  script = DEFAULT_SCRIPT, exp?: string, day?: string,
): Promise<upstox.Ladder> {
  return (await session(script, exp, day)).ladder;
}

/** The candle resolution the ladder is built at, in seconds. */
export const LADDER_SLOT_S = CANDLE_MIN * 60;

/** The newest ladder of the session. */
export async function liveOi(script = DEFAULT_SCRIPT, exp?: string, day?: string): Promise<Result<OiSnapshots>> {
  const s = await session(script, exp, day);
  const { ts, snap } = snapshotAt(s, s.ladder.times[s.ladder.times.length - 1]);
  return { source: 'upstox', data: { [String(ts)]: snap } };
}

/** The ladder at both ends of a window — what the clock diffs. */
export async function indexAnalysis(
  script = DEFAULT_SCRIPT, exp: string | undefined, ts1: number, ts2: number, day?: string,
): Promise<Result<OiSnapshots>> {
  const s = await session(script, exp, day);
  const lo = Math.min(ts1, ts2), hi = Math.max(ts1, ts2);
  const from = snapshotAt(s, lo), to = snapshotAt(s, hi);
  return { source: 'upstox', data: { [String(from.ts)]: from.snap, [String(to.ts)]: to.snap } };
}

/**
 * PCR at every step through the session.
 *
 * Every slot of the grid is answerable now, because the ladder for the whole day is in
 * hand — the "not recorded yet" rows only existed because the reading had to be captured
 * live. A slot before the session's first candle is still left out; nothing traded then.
 */
export async function pcrSeries(
  script = DEFAULT_SCRIPT, exp?: string, step = 600, day?: string,
): Promise<Result<PcrPoint[]>> {
  const s = await session(script, exp, day);
  // The session's own day, not the calendar's. They disagree whenever today hasn't
  // traded, and a grid laid out for Saturday matches no candle from Friday — which
  // filtered every row out and reported the day as having no option data at all.
  const on = s.ladder.day;
  const first = s.ladder.times[0];
  const last = s.ladder.times[s.ladder.times.length - 1];

  const out: PcrPoint[] = [];
  for (const slot of sessionGrid(step, on)) {
    if (slot < first) continue;          // before the first candle — nothing traded
    if (slot > last + step) continue;    // beyond the session so far
    const { ts, snap } = snapshotAt(s, slot);
    let bulls = 0, bears = 0;
    for (const [k, v] of Object.entries(snap)) {
      if (k === 'atm') continue;
      if (k.endsWith('CE')) bears += v; else if (k.endsWith('PE')) bulls += v;
    }
    if (bears <= 0) continue;
    // Stamped with the slot rather than the candle behind it, so the table's rows land on
    // the grid the page lays out.
    out.push([slot, +(bulls / bears).toFixed(2), Math.round(bulls), Math.round(bears)]);
    void ts;
  }
  if (!out.length) throw new Error(`no option data for ${on}`);
  return { source: 'upstox', data: out };
}

/**
 * The days the picker offers.
 *
 * Upstox serves any past session, so this is simply the last few weekdays — no longer
 * "whatever we managed to record". Today is included only once it has traded, which is
 * what stops the page opening on a Saturday with nothing to show.
 */
export async function availableDays(script = DEFAULT_SCRIPT, exp?: string): Promise<Result<string[]>> {
  void exp;
  const days: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; days.length < 10 && i < 30; i++) {
    const d = dayOf(now - i * 86400);
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue; // trading holidays just come back empty
    days.push(d);
  }

  // Drop today when it has not traded yet — a weekday before 09:15, or a holiday. The old
  // version always offered today and so opened on a day with no data every weekend.
  const today = todayIST();
  if (days[0] === today) {
    try {
      const bars = await upstox.intradayCandles(upstox.INSTRUMENT_KEY[script], 'minutes', 30);
      if (!bars.length) days.shift();
    } catch { days.shift(); }
  }
  if (!days.length) throw new Error('no trading days available');
  return { source: 'upstox', data: days };
}

