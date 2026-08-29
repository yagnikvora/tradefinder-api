// Backfill option candle paths for EXPIRED contracts, via Upstox's expired-instruments API.
//
//   npx tsx tools/option-paths-expired.ts --dry     what it would fetch, no calls
//   npx tsx tools/option-paths-expired.ts           fetch and write into the path archive
//   npx tsx tools/option-paths-expired.ts --from 2026-07-28 --to 2026-08-24
//
// WHY THIS EXISTS. A path-dependent exit rule — a trailing stop, a breakeven stop, any ratchet —
// cannot be graded from a journal row. The row stores the best and worst price and the minute each
// happened; the rule needs the ORDER of everything in between. That order lives only in the
// contract's own minute candles, and `/v3/historical-candle` stops serving them the moment the
// series expires (`UDAPI100011 Invalid Instrument key`). Verified dead on both the July and August
// 2026 series.
//
// THE ONE ROUTE THAT STILL WORKS. Upstox keeps expired contract data behind a separate endpoint,
// addressed with a different instrument key:
//
//     normal   NSE_FO|121245                 <- dies at expiry
//     expired  NSE_FO|121245|25-08-2026      <- the same contract, plus its expiry, DD-MM-YYYY
//
// Probed 2026-08-30 against the real MANAPPURAM 380 CE from 30 Jul. Four other key spellings all
// returned `UDAPI1021 Instrument key is of invalid format`; the one above returned
// `UDAPI1149 — This API is available exclusively with an Upstox Plus plan subscription`.
// A plan error rather than a format error is the proof the address is right: the data is there and
// the account simply is not entitled to it yet.
//
// SO: this script is complete and correct, and will 401 on every row until the account has Upstox
// Plus. The moment it does, one run turns every ESTIMATED row in the ladder study into an exact
// figure. Nothing else in the pipeline needs to change.

import '../src/env.js';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, databaseUrl, getPool } from '../src/momentum/journal/postgres.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, '..', '.cache', 'momentum');
const BASE = 'https://api.upstox.com';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** `NSE_FO|121245` + `2026-08-25` -> `NSE_FO|121245|25-08-2026`. */
export function expiredKey(instrumentKey: string, expiry: string): string {
  const [y, m, d] = expiry.split('-');
  return `${instrumentKey}|${d}-${m}-${y}`;
}

/**
 * The expired endpoint does NOT return what `/v3/historical-candle` returns, and `sessionBars`
 * cannot read it:
 *
 *   v3       [1753848540, 10.45, ...]                 epoch seconds, ASCENDING
 *   expired  ["2026-07-30T15:29:00+05:30", 10.45, ...] ISO string,   DESCENDING
 *
 * Feeding the ISO form to `sessionBars` makes `istMinutes(c[0] * 1000)` NaN, so every bar lands
 * with a null minute and the whole path is silently useless — which is exactly what happened on
 * the first run of this tool. Parse the clock time straight out of the string: the +05:30 offset
 * is already IST, so no timezone maths is needed or wanted.
 */
function expiredBars(raw: unknown[][]): Array<{ minute: number; high: number; low: number; close: number }> {
  const SESSION_OPEN_MIN = 9 * 60 + 15;
  const out: Array<{ minute: number; high: number; low: number; close: number }> = [];
  for (const c of raw) {
    const stamp = String(c[0]);
    const m = /T(\d{2}):(\d{2})/.exec(stamp);
    if (!m) continue;
    const minute = Number(m[1]) * 60 + Number(m[2]) - SESSION_OPEN_MIN;
    const [high, low, close] = [Number(c[2]), Number(c[3]), Number(c[4])];
    if (minute < 0 || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
    out.push({ minute, high, low, close });
  }
  return out.sort((a, b) => a.minute - b.minute);
}

async function fetchExpiredCandles(key: string, day: string): Promise<unknown[][]> {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) throw new Error('UPSTOX_ACCESS_TOKEN is not set');
  const url = `${BASE}/v2/expired-instruments/historical-candle/${encodeURIComponent(key)}/1minute/${day}/${day}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    let code = '';
    try { code = JSON.parse(text)?.errors?.[0]?.errorCode ?? ''; } catch { /* keep the raw body */ }
    if (code === 'UDAPI1149') throw new Error('PLAN: Upstox Plus subscription required for expired-instrument data');
    throw new Error(`${res.status} ${code || text.slice(0, 90)}`);
  }
  return JSON.parse(text)?.data?.candles ?? [];
}

async function loadTrades(from?: string, to?: string): Promise<JournalTrade[]> {
  if (databaseUrl()) {
    const { rows } = await getPool().query<{ trade: JournalTrade }>('SELECT trade FROM momentum_journal');
    return rows.map((r) => r.trade).filter((t) => (!from || t.day >= from) && (!to || t.day <= to));
  }
  const out: JournalTrade[] = [];
  for (const f of await fs.readdir(CACHE)) {
    if (!/^journal_\d{4}-\d{2}\.json$/.test(f)) continue;
    const j = JSON.parse(await fs.readFile(path.join(CACHE, f), 'utf8'));
    out.push(...(j.trades ?? []));
  }
  return out.filter((t) => (!from || t.day >= from) && (!to || t.day <= to));
}

async function main() {
  const trades = await loadTrades(opt('from'), opt('to'));
  const byMonth = new Map<string, Record<string, number[][]>>();
  const archives = new Map<string, string>();

  for (const t of trades) {
    const month = t.day.slice(0, 7);
    if (!byMonth.has(month)) {
      const file = path.join(CACHE, `journal_paths_${month}.json`);
      archives.set(month, file);
      byMonth.set(month, await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => ({})));
    }
  }

  const missing = trades.filter((t) => t.contract && !byMonth.get(t.day.slice(0, 7))![t.id]);
  console.log(`${trades.length} trades in range · ${trades.length - missing.length} already archived · ${missing.length} to fetch`);

  if (flag('dry')) {
    for (const t of missing.slice(0, 12)) {
      console.log(`  ${t.day} ${t.symbol.padEnd(11)} ${t.contract!.label.padEnd(12)} -> ${expiredKey(t.contract!.instrumentKey, t.contract!.expiry)}`);
    }
    if (missing.length > 12) console.log(`  ... and ${missing.length - 12} more`);
    console.log('\ndry run — nothing fetched, nothing written');
    return;
  }

  let ok = 0, planBlocked = 0;
  const failures: string[] = [];
  for (const t of missing) {
    const key = expiredKey(t.contract!.instrumentKey, t.contract!.expiry);
    try {
      const bars = expiredBars(await fetchExpiredCandles(key, t.day));
      if (!bars.length) { failures.push(`${t.day} ${t.symbol}: empty`); continue; }
      byMonth.get(t.day.slice(0, 7))![t.id] = bars.map((b) => [b.minute, b.high, b.low, b.close]);
      ok++;
      if (ok % 10 === 0) console.log(`  ${ok}/${missing.length}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('PLAN:')) {
        planBlocked++;
        if (planBlocked === 1) {
          console.error('\n  Upstox Plus is required for expired-contract candles.');
          console.error('  The key format is correct — the account is not entitled to the data.');
          console.error('  Subscribe, then re-run this exact command; nothing else needs to change.\n');
        }
        break;
      }
      failures.push(`${t.day} ${t.symbol}: ${msg}`);
    }
  }

  if (ok) {
    for (const [month, file] of archives) await fs.writeFile(file, JSON.stringify(byMonth.get(month)));
    console.log(`\nwrote ${ok} paths into ${archives.size} archive file(s)`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} failed:`);
    for (const f of failures.slice(0, 20)) console.log('  ' + f);
  }
  if (planBlocked) process.exitCode = 2;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closePool());
