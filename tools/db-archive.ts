// npm run db:archive — fill the 1-minute candle archive, and keep it filled.
//
// This is the job that turns "I can backtest the last twenty days" into "I can backtest the
// last two years". Upstox serves at most ~30 calendar days of 1-minute candles per request
// against a 2000-per-30-minute ceiling, so deep history is not something you fetch when you
// want it — it is something you accumulate and never throw away.
//
// EVERYTHING HERE IS INCREMENTAL. The archive is asked which sessions it already holds before
// a single request is made, and only the gaps are fetched. Running this daily costs one request
// per symbol; running it twice in a row costs nothing at all. That is what makes it safe to put
// on a scheduler and what stops a re-run from spending the live scanner's budget.
//
// Usage:
//   npm run db:archive -- --import-cache      lift api/.cache/research/*.json into the archive
//   npm run db:archive -- --days 365          fetch any missing sessions, whole universe
//   npm run db:archive -- --days 365 --symbols 40
//   npm run db:archive -- --stats             what is held, and what it costs on disk

import '../src/env.js';

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDb, dbEnabled } from '../src/db/pool.js';
import { archivedDays, bySession, stats, storedSize, writeDays } from '../src/db/candle.archive.js';
import { historical } from '../src/momentum/data/candles.js';
import { isoDaysBefore, istDay, SESSION_MINUTES } from '../src/momentum/session.js';
import { configRepository } from '../src/pullback/config/config.repository.js';
import { universe } from '../src/pullback/data/universe.js';
import { fromCandle, type Bar } from '../src/pullback/indicators/series.js';
import { tokenSet } from '../src/upstox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH_CACHE = path.join(here, '..', '.cache', 'research');

/** The widest 1-minute window Upstox will serve in one request. */
const MAX_RANGE_DAYS = 28;

const has = (flag: string) => process.argv.includes(`--${flag}`);
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const fmtBytes = (n: number): string =>
  n < 1e6 ? `${(n / 1e3).toFixed(0)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(2)} GB`;

async function report(): Promise<void> {
  const s = await stats();
  console.log('\ncandle_archive');
  console.log(`  symbols   : ${s.symbols}`);
  console.log(`  sessions  : ${s.sessions}${s.from ? `  (${s.from} -> ${s.to})` : ''}`);
  console.log(`  rows      : ${s.rows.toLocaleString()}`);
  console.log(`  bars      : ${s.bars.toLocaleString()}`);
  console.log(`  packed    : ${fmtBytes(s.bytes)} before compression`);
  console.log(`  on disk   : ${await storedSize()} (after TOAST compression, incl. indexes)`);
}

/* ------------------------------------------------------------------- import cache --- */

/**
 * Lift `api/.cache/research/*.json` into the archive.
 *
 * Worth doing first and worth doing before anything else: that directory is 159 MB of 1-minute
 * history already paid for in Upstox requests, and its filenames encode the date RANGE it was
 * fetched for — so the moment a sweep is run with a different `--days` the whole lot is orphaned
 * and re-fetched. Imported here it is keyed by symbol and session instead, which is the key it
 * should always have had, and a changed date range then costs only the sessions genuinely missing.
 */
async function importCache(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await readdir(RESEARCH_CACHE)).filter((f) => f.endsWith('.json'));
  } catch {
    console.log('no api/.cache/research directory — nothing to import');
    return;
  }
  if (!files.length) { console.log('api/.cache/research is empty — nothing to import'); return; }

  console.log(`importing ${files.length} cached files...`);
  let symbols = 0;
  let sessions = 0;

  for (const file of files) {
    // SYMBOL_from_to.json — the symbol is everything before the first date, and a symbol can
    // itself contain an underscore (BAJAJ-AUTO does not, but the convention is not guaranteed),
    // so the split is anchored on the date pattern rather than on the first separator.
    const m = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
    if (!m) { console.log(`  skipped ${file} — unrecognised name`); continue; }
    const symbol = m[1];

    try {
      const bars = JSON.parse(await readFile(path.join(RESEARCH_CACHE, file), 'utf8')) as Bar[];
      if (!Array.isArray(bars) || !bars.length) { console.log(`  ${symbol}: empty, skipped`); continue; }
      const written = await writeDays(symbol, bySession(bars));
      symbols++;
      sessions += written;
      console.log(`  ${symbol.padEnd(14)} ${String(written).padStart(4)} sessions`);
    } catch (e) {
      console.error(`  ${symbol}: ${(e as Error).message}`);
    }
  }
  console.log(`imported ${sessions} sessions across ${symbols} symbols`);
}

/* ------------------------------------------------------------------------- fetch --- */

/**
 * Fetch whatever the archive is missing for one symbol.
 *
 * A spent quota is WAITED OUT rather than skipped. This is a batch job with nobody waiting on
 * it, and skipping is what produces a half-covered symbol — which is worse than a missing one,
 * because it replays as a real sample with silent holes in it.
 */
async function fetchSymbol(symbol: string, key: string, from: string, to: string): Promise<number> {
  const held = await archivedDays(symbol, from, to);

  let cursor = from;
  let written = 0;
  while (cursor <= to) {
    const endOfWindow = isoDaysBefore(-MAX_RANGE_DAYS, cursor);
    const end = endOfWindow > to ? to : endOfWindow;

    // Skip a window only when EVERY weekday in it is already archived. Weekends and holidays
    // never appear in the archive and must not be mistaken for gaps, or every run would re-fetch
    // the same windows forever chasing days the exchange never traded.
    if (!windowNeedsFetch(cursor, end, held)) {
      cursor = isoDaysBefore(-(MAX_RANGE_DAYS + 1), cursor);
      continue;
    }

    let done = false;
    for (let attempt = 0; attempt < 12 && !done; attempt++) {
      try {
        const candles = await historical(key, 'minutes', 1, cursor, end);
        const bars = candles
          .filter((c) => c.minute >= 0 && c.minute <= SESSION_MINUTES)
          .map(fromCandle);
        written += await writeDays(symbol, bySession(bars));
        done = true;
      } catch (e) {
        const msg = String((e as Error).message);
        if (!(msg.includes('429') || msg.includes('rate limited'))) {
          console.error(`  ${symbol} ${cursor}: ${msg}`);
          done = true;
        } else {
          process.stdout.write(`  ${symbol} throttled, waiting 60s (attempt ${attempt + 1}/12)      \r`);
          await new Promise((r) => setTimeout(r, 60_000));
        }
      }
    }
    cursor = isoDaysBefore(-(MAX_RANGE_DAYS + 1), cursor);
  }
  return written;
}

/** True when the window contains a weekday the archive does not already hold. */
function windowNeedsFetch(from: string, to: string, held: Set<string>): boolean {
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    const date = new Date(d);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue; // the exchange was shut; absence is not a gap
    if (!held.has(date.toISOString().slice(0, 10))) return true;
  }
  return false;
}

async function fetchAll(days: number, limit: number): Promise<void> {
  if (!tokenSet()) {
    console.error('UPSTOX_ACCESS_TOKEN is not set — cannot fetch. --import-cache still works.');
    process.exitCode = 1;
    return;
  }
  const today = istDay();
  const to = isoDaysBefore(1, today); // yesterday: today is still forming and would archive partial
  const from = isoDaysBefore(days, today);

  const cfg = await configRepository.get();
  const uni = await universe(cfg.universe);
  const members = uni.members.slice(0, limit);

  console.log(`archiving ${members.length} symbols, ${from} -> ${to}`);
  console.log('(incremental — only sessions the archive is missing are requested)\n');

  let total = 0;
  for (const [i, m] of members.entries()) {
    const n = await fetchSymbol(m.symbol, m.seriesKey, from, to);
    total += n;
    const tag = n ? `${String(n).padStart(4)} new sessions` : '   up to date';
    console.log(`  [${String(i + 1).padStart(3)}/${members.length}] ${m.symbol.padEnd(14)} ${tag}`);
  }
  console.log(`\n${total} sessions added`);
}

/* -------------------------------------------------------------------------- main --- */

async function main(): Promise<void> {
  if (!dbEnabled()) {
    console.error('DATABASE_URL is not set. Put your connection string in api/.env — see api/.env.example.');
    process.exitCode = 1;
    return;
  }

  if (has('stats')) { await report(); return; }
  if (has('import-cache')) { await importCache(); await report(); return; }

  await fetchAll(Number(arg('days', '365')), Number(arg('symbols', '250')));
  await report();
}

main()
  .catch((e: Error) => { console.error(`archive failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => void closeDb());
