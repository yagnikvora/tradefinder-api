// Historical daily-volume baseline for a real Relative-Volume (RVOL) R.Factor.
//
// R.Factor = today's cumulative volume  ÷  average daily volume over a trailing
// window. NSE's live feed gives today's volume; the trailing average is NOT in any
// live endpoint, so we backfill it from NSE's daily Bhavcopy CSVs
// (sec_bhavdata_full_DDMMYYYY.csv → TTL_TRD_QNTY per symbol) and cache to disk.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Persisted so restarts don't re-download; lives outside src so a rebuild won't wipe it.
const CACHE_FILE = path.join(__dirname, '..', '.cache', 'volume-history.json');

// Trailing sessions for the average. 20 is the textbook RVOL window, but measured
// against tradefinder's published R.Factor the agreement climbs steadily with a longer
// baseline (Spearman 0.65 at 2 sessions → 0.80 at 20, still rising at the limit of the
// history we held) — their baseline is evidently deeper than a month, so we match it.
const WINDOW = Number(process.env.RVOL_WINDOW) || 50;
const MAX_LOOKBACK = 90;    // calendar days to scan back to collect WINDOW trading days
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// key = yyyy-mm-dd, value = { SYMBOL: [dailyVolume, dailyRangePct] }
// Range travels with volume because Sector Scope's R.Factor tracks a stock's daily
// RANGE against its own norm, not its volume — see avgDailyRanges below.
type DayStats = Record<string, [number, number]>;
interface Cache {
  days: Record<string, DayStats>;
  avg: Record<string, number>;       // trailing mean daily volume (shares)
  avgRange: Record<string, number>;  // trailing mean daily range (% of prev close)
  avgAt: number;
}

let mem: Cache | null = null;
let loading: Promise<void> | null = null;

function bhavUrl(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${dd}${mm}${yyyy}.csv`;
}
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

// Parse a sec_bhavdata_full CSV (EQ/BE series only) into [volume, rangePct] per symbol.
// Columns: 0 SYMBOL, 1 SERIES, 3 PREV_CLOSE, 5 HIGH_PRICE, 6 LOW_PRICE, 10 TTL_TRD_QNTY.
function parseBhav(csv: string): DayStats {
  const out: DayStats = {};
  const lines = csv.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 11) continue;
    const symbol = (c[0] || '').trim();
    const series = (c[1] || '').trim();
    const vol = Number((c[10] || '').trim());
    const prev = Number((c[3] || '').trim());
    const hi = Number((c[5] || '').trim());
    const lo = Number((c[6] || '').trim());
    if (symbol && (series === 'EQ' || series === 'BE') && Number.isFinite(vol) && vol > 0) {
      const range = Number.isFinite(hi) && Number.isFinite(lo) && prev > 0 ? ((hi - lo) / prev) * 100 : 0;
      out[symbol] = [vol, range];
    }
  }
  return out;
}

async function fetchBhav(d: Date): Promise<DayStats | null> {
  try {
    const res = await fetch(bhavUrl(d), {
      headers: { 'User-Agent': UA, Accept: 'text/csv,*/*', Referer: 'https://www.nseindia.com/' },
    });
    if (!res.ok) return null; // weekend/holiday/not-yet-published → 404
    const csv = await res.text();
    if (!/^SYMBOL/i.test(csv.trim())) return null;
    const day = parseBhav(csv);
    return Object.keys(day).length > 100 ? day : null;
  } catch {
    return null;
  }
}

async function loadCache(): Promise<Cache> {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    const c = JSON.parse(raw) as Cache;
    // Older caches stored a bare volume per symbol instead of [volume, range].
    // Discard those rather than half-read them — a re-backfill is cheap and this
    // keeps one shape in memory instead of two.
    const sample = Object.values(c?.days ?? {})[0];
    const entry = sample && Object.values(sample)[0];
    if (c?.days && (entry === undefined || Array.isArray(entry))) {
      c.avgRange ??= {};
      return c;
    }
  } catch { /* no cache yet */ }
  return { days: {}, avg: {}, avgRange: {}, avgAt: 0 };
}

async function saveCache(c: Cache): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(c), 'utf8');
}

// Recompute the per-symbol trailing averages over the newest WINDOW days we hold.
function recomputeAverages(c: Cache): void {
  const keys = Object.keys(c.days).sort().slice(-WINDOW); // newest WINDOW dates
  const vSum: Record<string, number> = {}, vCnt: Record<string, number> = {};
  const rSum: Record<string, number> = {}, rCnt: Record<string, number> = {};
  for (const k of keys) {
    const day = c.days[k];
    for (const sym in day) {
      const [v, r] = day[sym];
      vSum[sym] = (vSum[sym] || 0) + v;
      vCnt[sym] = (vCnt[sym] || 0) + 1;
      if (r > 0) { rSum[sym] = (rSum[sym] || 0) + r; rCnt[sym] = (rCnt[sym] || 0) + 1; }
    }
  }
  const avg: Record<string, number> = {}, avgRange: Record<string, number> = {};
  // need a few days before an average means anything
  for (const sym in vSum) if (vCnt[sym] >= 3) avg[sym] = vSum[sym] / vCnt[sym];
  for (const sym in rSum) if (rCnt[sym] >= 3) avgRange[sym] = rSum[sym] / rCnt[sym];
  c.avg = avg;
  c.avgRange = avgRange;
  c.avgAt = Date.now();
}

// Backfill any missing trading days within the lookback window (skips days already cached).
async function ensureHistory(now: Date): Promise<void> {
  if (!mem) mem = await loadCache();
  const c = mem;

  let haveInWindow = Object.keys(c.days).filter((k) => {
    const age = (now.getTime() - new Date(k + 'T00:00:00Z').getTime()) / 86400e3;
    return age >= 0 && age <= MAX_LOOKBACK;
  }).length;

  let fetched = false;
  // Walk back from yesterday; today's bhavcopy isn't published until after close.
  for (let back = 1; back <= MAX_LOOKBACK && haveInWindow < WINDOW; back++) {
    const d = new Date(now.getTime() - back * 86400e3);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;      // skip weekends
    const key = dayKey(d);
    if (c.days[key]) { haveInWindow++; continue; } // already cached
    const day = await fetchBhav(d);
    if (day) { c.days[key] = day; haveInWindow++; fetched = true; }
    // else: holiday / missing — just move on
  }

  // Prune anything older than the lookback so the file stays small.
  for (const k of Object.keys(c.days)) {
    const age = (now.getTime() - new Date(k + 'T00:00:00Z').getTime()) / 86400e3;
    if (age > MAX_LOOKBACK + 5) delete c.days[k];
  }

  if (fetched || !c.avgAt) {
    recomputeAverages(c);
    await saveCache(c);
  }
}

/**
 * Map of SYMBOL → trailing-average daily volume (shares). Backfills from Bhavcopy on
 * first call, then refreshes at most once/day. Returns {} if NSE archives are unreachable.
 */
export async function avgDailyVolumes(now: Date = new Date()): Promise<Record<string, number>> {
  if (mem && mem.avgAt && Date.now() - mem.avgAt < 12 * 60 * 60 * 1000) return mem.avg;
  if (!loading) loading = ensureHistory(now).finally(() => { loading = null; });
  try { await loading; } catch { /* keep whatever we have */ }
  return mem?.avg ?? {};
}

/**
 * Map of SYMBOL → trailing-average daily range, as a % of previous close.
 *
 * This is the baseline behind Sector Scope's R.Factor. Measured against tradefinder's
 * published R.Factor over 37 symbols, a stock's daily RANGE predicts their number far
 * better than its relative volume does (Spearman 0.80 vs 0.66; Pearson 0.80 vs 0.45) —
 * so R.Factor is a volatility multiple, not a volume one. Their companion feed tagging
 * each symbol `volt: high|low` points the same way.
 */
export async function avgDailyRanges(now: Date = new Date()): Promise<Record<string, number>> {
  if (mem && mem.avgAt && Date.now() - mem.avgAt < 12 * 60 * 60 * 1000) return mem.avgRange;
  if (!loading) loading = ensureHistory(now).finally(() => { loading = null; });
  try { await loading; } catch { /* keep whatever we have */ }
  return mem?.avgRange ?? {};
}

/** How many trading days of history are currently cached (for diagnostics). */
// NOTE: historyDepth and avgDailyVolumes are reached through a dynamic import() in
// index.ts (/health/volume), so a grep for a static import of them finds nothing. They are
// used — don't delete them on the strength of a dead-code sweep.
export async function historyDepth(): Promise<number> {
  if (!mem) mem = await loadCache();
  return Object.keys(mem.days).length;
}
