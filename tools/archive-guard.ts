// Daily safety net for the option-path archive. Safe to run any number of times.
//
//   npx tsx tools/archive-guard.ts          repair what can be repaired
//   npx tsx tools/archive-guard.ts --dry    report only, write nothing
//
// Settlement already archives every contract's path before it grades the trade, local disk first
// and Postgres second. That is the right order — disk cannot be unreachable — but it leaves two
// ways for a path to go missing, and both are silent:
//
//   1. THE PUSH NEVER LANDED. The local write succeeded and the Postgres write did not (process
//      stopped, network blip, DATABASE_URL briefly unset). The row looks archived because locally
//      it is, so nothing ever retries. Found 5 such paths on 2026-08-30, from 26 and 28 August.
//
//   2. THE FETCH FAILED AT SETTLEMENT. Upstox refused the candles for a moment, `settleDay` moved
//      on and marked the trade settled with `reason: 'untracked'`, and nothing re-attempts it.
//      The contract then expires and the path is unrecoverable through the normal endpoint.
//
// Neither is hypothetical and neither raises an error, which is exactly why a guard has to look
// for them on a schedule rather than waiting to be told. What is lost here cannot be bought back
// later at any price except an Upstox Plus subscription — see `tools/option-paths-expired.ts`.

import '../src/env.js';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionCandles } from '../src/upstox.js';
import { sessionBars } from '../src/momentum/journal/journal.js';
import { istDay } from '../src/momentum/session.js';
import { closePool, databaseUrl, getPool, savePaths, type OptionPathRow } from '../src/momentum/journal/postgres.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, '..', '.cache', 'momentum');
const DRY = process.argv.includes('--dry');

type Path4 = [number, number, number, number];

async function loadTrades(): Promise<JournalTrade[]> {
  if (databaseUrl()) {
    const { rows } = await getPool().query<{ trade: JournalTrade }>('SELECT trade FROM momentum_journal');
    return rows.map((r) => r.trade);
  }
  const out: JournalTrade[] = [];
  for (const f of await fs.readdir(CACHE)) {
    if (!/^journal_\d{4}-\d{2}\.json$/.test(f)) continue;
    out.push(...(JSON.parse(await fs.readFile(path.join(CACHE, f), 'utf8')).trades ?? []));
  }
  return out;
}

async function loadLocalPaths(): Promise<Map<string, Path4[]>> {
  const map = new Map<string, Path4[]>();
  for (const f of await fs.readdir(CACHE)) {
    if (!/^journal_paths_\d{4}-\d{2}\.json$/.test(f)) continue;
    const doc = JSON.parse(await fs.readFile(path.join(CACHE, f), 'utf8')) as Record<string, Path4[]>;
    for (const [id, bars] of Object.entries(doc)) map.set(id, bars);
  }
  return map;
}

const rowFor = (t: JournalTrade, bars: Path4[]): OptionPathRow => ({
  day: t.day,
  instrumentKey: t.contract!.instrumentKey,
  symbol: t.symbol,
  strike: t.contract!.strike ?? null,
  optType: t.contract!.type ?? null,
  expiry: t.contract!.expiry ?? null,
  lotSize: t.contract!.lotSize ?? null,
  role: 'traded',
  bars,
});

async function main() {
  const today = istDay(Date.now());
  const trades = (await loadTrades()).filter((t) => t.contract);
  const local = await loadLocalPaths();

  let inDb = new Set<string>();
  if (databaseUrl()) {
    const { rows } = await getPool().query<{ d: string; k: string }>(
      'SELECT day::text AS d, instrument_key AS k FROM momentum_option_path',
    );
    inDb = new Set(rows.map((r) => `${r.d.slice(0, 10)}|${r.k}`));
  } else {
    console.log('DATABASE_URL not set — checking local coverage only.\n');
  }

  // ---- 1. locally archived but never pushed
  const unpushed = trades.filter((t) => local.has(t.id) && !inDb.has(`${t.day}|${t.contract!.instrumentKey}`));

  // ---- 2. no path at all; split by whether the series can still answer
  const noPath = trades.filter((t) => !local.has(t.id));
  const recoverable = noPath.filter((t) => (t.contract!.expiry ?? '9999') >= today);
  const lost = noPath.filter((t) => (t.contract!.expiry ?? '9999') < today);

  console.log(`${trades.length} journal trades · ${local.size} archived locally · ${inDb.size} in Postgres\n`);
  console.log(`  archived locally but not pushed : ${unpushed.length}`);
  console.log(`  no path, series still live      : ${recoverable.length}`);
  console.log(`  no path, series expired         : ${lost.length}`);

  if (DRY) {
    for (const t of unpushed) console.log(`    push  ${t.day} ${t.symbol} ${t.contract!.label}`);
    for (const t of recoverable) console.log(`    fetch ${t.day} ${t.symbol} ${t.contract!.label}`);
    console.log('\n--dry, nothing written.');
    return;
  }

  if (databaseUrl() && unpushed.length) {
    const n = await savePaths(getPool(), unpushed.map((t) => rowFor(t, local.get(t.id)!))).catch((e) => {
      console.error('  push failed:', (e as Error).message);
      return 0;
    });
    console.log(`\n  pushed ${n} path(s) to Postgres`);
  }

  let fetched = 0;
  if (recoverable.length) {
    const byMonth = new Map<string, Record<string, Path4[]>>();
    for (const t of recoverable) {
      const month = t.day.slice(0, 7);
      if (!byMonth.has(month)) {
        const file = path.join(CACHE, `journal_paths_${month}.json`);
        byMonth.set(month, await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => ({})));
      }
      try {
        const bars = sessionBars(await sessionCandles(t.contract!.instrumentKey, t.day, today, 'minutes', 1));
        if (!bars.length) { console.log(`  empty  ${t.day} ${t.symbol}`); continue; }
        const p4 = bars.map((b) => [b.minute, b.high, b.low, b.close] as Path4);
        byMonth.get(month)![t.id] = p4;
        if (databaseUrl()) await savePaths(getPool(), [rowFor(t, p4)]).catch(() => 0);
        fetched++;
        console.log(`  rescued ${t.day} ${t.symbol} ${t.contract!.label}`);
      } catch (e) {
        console.log(`  FAILED  ${t.day} ${t.symbol}: ${(e as Error).message.slice(0, 60)}`);
      }
    }
    for (const [month, doc] of byMonth) {
      await fs.writeFile(path.join(CACHE, `journal_paths_${month}.json`), JSON.stringify(doc));
    }
  }

  console.log(`\n  ${fetched} rescued · ${lost.length} permanently unreachable through the normal endpoint`);
  if (lost.length) console.log('  (those need tools/option-paths-expired.ts and an Upstox Plus plan)');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closePool());
