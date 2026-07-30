// Option Clock service — live option-chain OI shaped into the real feed's payloads.
//
// Three endpoints back the page, and they mirror tradefinder's own:
//   get_running_expiry  {script}              -> [[epoch,"wk"],[epoch,"mo"]]
//   live_oi             {script,exp}          -> { "<ts>": { "<option key>": OI, atm } }
//   index_analysis      {script,exp,ts1,ts2}  -> the same, at both ends of a time window
//
// The clock itself is the difference between the two index_analysis snapshots: rising
// CE OI is bears writing calls (resistance), rising PE OI is bulls writing puts
// (support). Snapshots come from the tape in oistore.ts — see there for how a session
// gets recorded and why the 09:15 baseline needs no waiting.

import { optionChain, optionExpiries } from './nse.js';
import { feedKey, latest, nearest, record, recordIfAbsent, slotOf, timeline, type OiSnapshot } from './oistore.js';
import type { Result } from './services.js';
import type { OiSnapshots, PcrPoint, RunningExpiry, Source } from './types.js';

// The index dropdown. Keys are the `script` values the real feed uses; each maps to the
// NSE symbol its option chain lives under.
export const SCRIPTS: Record<string, { symbol: string; label: string }> = {
  'NIFTY 50': { symbol: 'NIFTY', label: 'Nifty50' },
  'NIFTY BANK': { symbol: 'BANKNIFTY', label: 'BankNifty' },
  FINNIFTY: { symbol: 'FINNIFTY', label: 'FinNifty' },
  MIDCPNIFTY: { symbol: 'MIDCPNIFTY', label: 'MidCpNifty' },
};
export const DEFAULT_SCRIPT = 'NIFTY 50';

// Strikes kept either side of ATM. 10 gives the 21-row ladder the real clock draws.
const STRIKE_WINDOW = 10;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// NSE weekly contract codes run 1-9 for Jan-Sep, then O, N, D.
const MONTH_CODE = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'O', 'N', 'D'];

const IST_OFFSET_S = 330 * 60;

/** "04-Aug-2026" -> Date at 00:00 UTC. */
function parseNseDate(s: string): Date {
  const [dd, mon, yyyy] = s.split('-');
  return new Date(Date.UTC(Number(yyyy), MON.indexOf(mon), Number(dd)));
}
/** "04-Aug-2026" -> "04Aug26", the compact form the feed takes as its `exp` parameter. */
export const expParam = (nseDate: string) => nseDate.replace(/-/g, '').replace(/^(\d{2})([A-Za-z]{3})\d{2}(\d{2})$/, '$1$2$3');
/** Epoch (s) of an expiry day at 15:30 IST — how the real feed timestamps an expiry. */
const expiryEpoch = (nseDate: string) => Math.floor(parseNseDate(nseDate).getTime() / 1000) + 15 * 3600 + 30 * 60 - IST_OFFSET_S;

/**
 * NSE contract code for an expiry: weekly contracts read yy + month code + dd
 * (07-Jul-2026 -> "2670 7"), monthly ones yy + MMM (28-Jul-2026 -> "26JUL").
 */
function contractCode(nseDate: string, monthly: boolean): string {
  const d = parseNseDate(nseDate);
  const yy = String(d.getUTCFullYear()).slice(2);
  if (monthly) return yy + MON[d.getUTCMonth()].toUpperCase();
  return yy + MONTH_CODE[d.getUTCMonth()] + String(d.getUTCDate()).padStart(2, '0');
}

const optionKey = (underlying: string, code: string, strike: number, side: 'CE' | 'PE') =>
  `NFO:${underlying}${code}${strike}${side}`;

/** Today's 09:15 IST, in epoch seconds — the session baseline the clock replays from. */
export function sessionOpenEpoch(nowMs = Date.now()): number {
  const ist = new Date(nowMs + IST_OFFSET_S * 1000);
  const midnightUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) / 1000 - IST_OFFSET_S;
  return midnightUtc + 9 * 3600 + 15 * 60;
}
/** Today's 15:30 IST close, in epoch seconds. */
export const sessionCloseEpoch = (nowMs = Date.now()) => sessionOpenEpoch(nowMs) + 6 * 3600 + 15 * 60;

/** "30-Jul-2026 15:30:00" (IST) -> epoch seconds. Falls back to now if NSE omits it. */
function stampEpoch(timestamp: string | undefined, nowMs: number): number {
  const m = timestamp?.match(/^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return Math.floor(nowMs / 1000);
  const [, dd, mon, yyyy, hh, mi, ss] = m;
  return Date.UTC(+yyyy, MON.indexOf(mon), +dd, +hh, +mi, +ss) / 1000 - IST_OFFSET_S;
}

// Expiry lists change on expiry day and not otherwise, but every clock call needs one
// before it can ask for a chain — so they're held for half an hour rather than fetched
// two or three times per page load.
const expiryCache = new Map<string, { at: number; list: string[] }>();
const EXPIRY_TTL = 30 * 60e3;

async function expiriesFor(symbol: string): Promise<string[]> {
  const hit = expiryCache.get(symbol);
  if (hit && Date.now() - hit.at < EXPIRY_TTL) return hit.list;
  const list = await optionExpiries(symbol);
  expiryCache.set(symbol, { at: Date.now(), list });
  return list;
}

// Feeds looked at recently. The PCR trend is a time series, so the session has to be
// recorded whether or not anyone happens to have the page open — see recordActive().
const active = new Map<string, { script: string; exp?: string; at: number }>();
const ACTIVE_TTL = 30 * 60e3;
const MAX_ACTIVE = 4;

const touch = (script: string, exp?: string) =>
  active.set(`${script}|${exp ?? ''}`, { script, exp, at: Date.now() });

/**
 * Extend the tape for every feed someone has looked at lately, falling back to the
 * default index so there is always a session being recorded. Called on a timer during
 * market hours; failures are ignored because the next tick is only minutes away.
 */
export async function recordActive(): Promise<void> {
  const fresh = [...active.values()].filter((f) => Date.now() - f.at < ACTIVE_TTL);
  const feeds = fresh.length ? fresh.slice(0, MAX_ACTIVE) : [{ script: DEFAULT_SCRIPT, exp: undefined, at: 0 }];
  for (const f of feeds) {
    try { await fetchLiveOi(f.script, f.exp); } catch { /* next tick */ }
  }
}

/**
 * Record every index the page offers, nearest expiry — what the standalone recorder
 * runs. It has no idea what anyone is looking at, so it keeps them all complete.
 *
 * Sequential on purpose: four requests fired together is the sort of burst NSE tarpits,
 * and there is no hurry inside a five-minute tick.
 */
export async function recordAll(): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [], failed: string[] = [];
  for (const script of Object.keys(SCRIPTS)) {
    try { await fetchLiveOi(script); ok.push(script); }
    catch { failed.push(script); }
  }
  return { ok, failed };
}

function resolveScript(script: string) {
  const entry = SCRIPTS[script] ?? SCRIPTS[script?.toUpperCase?.()];
  if (!entry) throw new Error(`unknown script "${script}"`);
  return entry;
}

/** Match a compact "04Aug26" against NSE's "04-Aug-2026" list. */
function resolveExpiry(list: string[], exp?: string): string {
  if (!exp) return list[0];
  const hit = list.find((d) => expParam(d).toLowerCase() === exp.toLowerCase() || d.toLowerCase() === exp.toLowerCase());
  if (!hit) throw new Error(`expiry ${exp} not listed for this index`);
  return hit;
}

/**
 * The two expiries the page offers: the nearest weekly and the month's last expiry.
 * Both are stamped at their 15:30 close, exactly as the real endpoint returns them.
 */
export async function runningExpiry(script = DEFAULT_SCRIPT): Promise<Result<RunningExpiry[]>> {
  const { symbol } = resolveScript(script);
  const list = await expiriesFor(symbol);
  const wk = list[0];
  const wkMonth = parseNseDate(wk).getUTCMonth();
  const sameMonth = list.filter((d) => parseNseDate(d).getUTCMonth() === wkMonth);
  // When the nearest weekly IS the monthly, the month has nothing further to offer —
  // roll to the next month's last expiry so the dropdown still has two entries.
  let mo = sameMonth[sameMonth.length - 1];
  if (mo === wk) {
    const later = list.filter((d) => parseNseDate(d).getUTCMonth() !== wkMonth);
    const nextMonth = later.length ? parseNseDate(later[0]).getUTCMonth() : -1;
    mo = later.filter((d) => parseNseDate(d).getUTCMonth() === nextMonth).pop() ?? wk;
  }
  const out: RunningExpiry[] = [[expiryEpoch(wk), 'wk']];
  if (mo !== wk) out.push([expiryEpoch(mo), 'mo']);
  return { source: 'nse', data: out };
}

/**
 * Current OI per strike around ATM, as one snapshot keyed by its timestamp.
 *
 * Every call also feeds the tape: the fresh snapshot goes into its slot, and the 09:15
 * baseline is reconstructed from NSE's own change-in-OI (OI now minus today's change is
 * precisely the OI carried into the session) so a full-day window is answerable from
 * the very first request of the day.
 */
// One page load asks three endpoints for the same chain (the clock, the totals and the
// PCR trend all need it), so the fetch is shared: concurrent callers join the one
// request and a fresh result stands for a slot's worth of time. A rejection is never
// held, so a failure doesn't stick for the whole window.
const liveCache = new Map<string, { at: number; p: Promise<Result<OiSnapshots>> }>();
const LIVE_TTL = 20e3;

export function liveOi(script = DEFAULT_SCRIPT, exp?: string): Promise<Result<OiSnapshots>> {
  const key = `${script}|${exp ?? ''}`;
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.p;
  const p = liveOiFresh(script, exp);
  liveCache.set(key, { at: Date.now(), p });
  p.catch(() => liveCache.delete(key));
  return p;
}

async function liveOiFresh(script: string, exp?: string): Promise<Result<OiSnapshots>> {
  try {
    return await fetchLiveOi(script, exp);
  } catch (e) {
    // NSE drops out often enough that a page load will land on one. Today's tape is real
    // OI read from the chain earlier in the session, so re-serve its newest snapshot
    // rather than failing the whole page over a single refused request.
    const last = await latest(script, exp);
    if (!last) throw e;
    return {
      source: 'stale',
      error: `NSE unreachable, showing OI as of ${new Date((last[0] + IST_OFFSET_S) * 1000).toISOString().slice(11, 16)} IST`,
      data: { [String(last[0])]: last[1] },
    };
  }
}

async function fetchLiveOi(script: string, exp?: string): Promise<Result<OiSnapshots>> {
  touch(script, exp);
  const { symbol } = resolveScript(script);
  const expiries = await expiriesFor(symbol);
  const expiry = resolveExpiry(expiries, exp);
  const monthly = !expiries.some(
    (d) => parseNseDate(d).getUTCMonth() === parseNseDate(expiry).getUTCMonth() && parseNseDate(d) > parseNseDate(expiry),
  );
  const code = contractCode(expiry, monthly);

  const chain = await optionChain(symbol, expiry);
  const rec = chain.records;
  const rows = rec.data.filter((r) => r.strikePrice && (r.CE || r.PE)).sort((a, b) => a.strikePrice - b.strikePrice);
  if (rows.length < 5) throw new Error(`thin chain: ${rows.length} strikes`);

  // Strike step read off the ladder rather than hard-coded — it differs per index and
  // NSE has changed it before.
  const step = Math.min(...rows.slice(1).map((r, i) => r.strikePrice - rows[i].strikePrice).filter((d) => d > 0));
  const atm = Math.round(rec.underlyingValue / step) * step;
  const near = rows.filter((r) => Math.abs(r.strikePrice - atm) <= STRIKE_WINDOW * step);

  const now: OiSnapshot = { atm };
  const open: OiSnapshot = { atm };
  for (const r of near) {
    const ce = r.CE, pe = r.PE;
    if (ce) {
      now[optionKey(symbol, code, r.strikePrice, 'CE')] = ce.openInterest;
      open[optionKey(symbol, code, r.strikePrice, 'CE')] = ce.openInterest - (ce.changeinOpenInterest || 0);
    }
    if (pe) {
      now[optionKey(symbol, code, r.strikePrice, 'PE')] = pe.openInterest;
      open[optionKey(symbol, code, r.strikePrice, 'PE')] = pe.openInterest - (pe.changeinOpenInterest || 0);
    }
  }

  const key = feedKey(script, expParam(expiry));
  const ts = slotOf(stampEpoch(rec.timestamp, Date.now()));
  await recordIfAbsent(key, sessionOpenEpoch(), open);
  await record(key, ts, now);

  return { source: 'nse', data: { [String(ts)]: now } };
}

/**
 * The session's slot times for a given step: 09:15, 09:25, … 15:25, then 15:30.
 *
 * The close is appended rather than reached by stepping, because 09:15 to 15:30 is not
 * a whole number of ten-minute steps and the final reading of the day is the one most
 * worth showing.
 */
export function sessionGrid(step: number, nowMs = Date.now()): number[] {
  const open = sessionOpenEpoch(nowMs), close = sessionCloseEpoch(nowMs);
  const out: number[] = [];
  for (let t = open; t < close; t += step) out.push(t);
  out.push(close);
  return out;
}

/** Total OI on each side of a snapshot. Puts are the bulls, calls the bears. */
function sideTotals(snap: OiSnapshot): { bulls: number; bears: number } {
  let bulls = 0, bears = 0;
  for (const [key, oi] of Object.entries(snap)) {
    if (key === 'atm') continue;
    if (key.endsWith('CE')) bears += oi;
    else if (key.endsWith('PE')) bulls += oi;
  }
  return { bulls, bears };
}

/**
 * PCR through the session on a fixed grid — 09:15, 09:25, 09:35 … 15:30 for a
 * ten-minute step — which is the trend table's row set.
 *
 * Each slot reports the newest real reading standing at that time; nothing is
 * interpolated and nothing is averaged. A reading only stands for a slot if it is less
 * than one step old, so a gap in the tape (the API restarted, NSE was refusing) leaves
 * the slot empty instead of painting the last known PCR flat across the outage.
 *
 * Slots with no reading are simply absent from the series — the page draws the whole
 * session's grid and marks those as pending.
 */
export async function pcrSeries(
  script = DEFAULT_SCRIPT, exp?: string, step = 600,
): Promise<Result<PcrPoint[]>> {
  let source: Source = 'nse';
  let error: string | undefined;
  const expiry = await resolveFeedExpiry(script, exp);

  try {
    const live = await liveOi(script, exp);
    if (live.source !== 'nse') { source = live.source; error = live.error; }
  } catch (e) {
    source = 'stale';
    error = String((e as Error).message);
  }

  const tape = await timeline(feedKey(script, expiry));
  if (!tape.length) throw new Error(error ?? 'no OI recorded for this session yet');

  const out: PcrPoint[] = [];
  for (const slot of sessionGrid(step)) {
    const hit = nearest(tape, slot);
    // Nothing recent enough to speak for this slot — leave it empty rather than carry
    // an older reading forward under a time it doesn't belong to.
    if (!hit || slot - hit[0] >= step) continue;
    const { bulls, bears } = sideTotals(hit[1]);
    if (bears > 0) out.push([slot, +(bulls / bears).toFixed(2), Math.round(bulls), Math.round(bears)]);
  }
  return { source, error, data: out };
}

/** The tape key's expiry, falling back to whatever the caller named when NSE is down. */
async function resolveFeedExpiry(script: string, exp?: string): Promise<string> {
  const list = await expiriesFor(resolveScript(script).symbol).catch(() => [] as string[]);
  return list.length ? expParam(resolveExpiry(list, exp)) : (exp ?? '');
}

/**
 * OI at both ends of a time window — what the clock diffs to show how the session's
 * positioning was built. Answered from the recorded tape after refreshing it, so the
 * numbers are always real OI readings rather than anything interpolated.
 */
export async function indexAnalysis(
  script = DEFAULT_SCRIPT, exp: string | undefined, ts1: number, ts2: number,
): Promise<Result<OiSnapshots>> {
  let source: Source = 'nse';
  let error: string | undefined;
  const expiry = await resolveFeedExpiry(script, exp);

  try {
    // Extends the tape to now; if it could only answer from the tape itself, this
    // window is no fresher than that and says so.
    const live = await liveOi(script, exp);
    if (live.source !== 'nse') { source = live.source; error = live.error; }
  } catch (e) {
    // The tape may still cover the window from earlier in the session — real readings,
    // just not extended to this minute. Only a tape that can't answer is a failure.
    source = 'stale';
    error = String((e as Error).message);
  }

  const tape = await timeline(feedKey(script, expiry));
  if (!tape.length) throw new Error(error ?? 'no OI recorded for this session yet');

  const lo = Math.min(ts1, ts2), hi = Math.max(ts1, ts2);
  const from = nearest(tape, lo)!;
  const to = nearest(tape, hi)!;
  const data: OiSnapshots = { [String(from[0])]: from[1] };
  data[String(to[0])] = to[1];
  return { source, error, data };
}
