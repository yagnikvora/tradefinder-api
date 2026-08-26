// Archive the option path of any journalled trade whose contract is STILL FETCHABLE.
//
//   npx tsx tools/archive-catchup.ts          archive what can still be archived
//   npx tsx tools/archive-catchup.ts --dry    report what is reachable, write nothing
//
// WHY IT IS WORTH RUNNING TODAY. Settlement archives a path from now on, but every trade settled
// BEFORE that change has none — and its contract is on a clock. Upstox answers UDAPI100011
// "Invalid Instrument key" the moment a series expires, so each of those trades is fetchable until
// its own expiry and unfetchable forever after. Running this now rescues whatever is left; running
// it in October rescues less; running it in December rescues nothing.
//
// It is also the honest way to find out how much is already gone, which is why the summary counts
// the dead separately rather than lumping them in with failures.

import '../src/env.js';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionCandles } from '../src/upstox.js';
import { istDay } from '../src/momentum/session.js';
import { closePool, databaseUrl, getPool, savePaths, type OptionPathRow } from '../src/momentum/journal/postgres.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, '..', '.cache', 'momentum');
const BATCH = 6;

type Path4 = [number, number, number, number];

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return null; }
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const today = istDay(Date.now());

  const trades: JournalTrade[] = [];
  for (const f of (await fs.readdir(CACHE)).filter((x) => /^journal_\d{4}-\d{2}\.json$/.test(x))) {
    const doc = await readJson<{ trades: JournalTrade[] }>(path.join(CACHE, f));
    if (doc) trades.push(...doc.trades);
  }
  const withContract = trades.filter((t) => t.contract?.instrumentKey);

  // Group by month so each archive document is read and written once.
  const byMonth = new Map<string, JournalTrade[]>();
  for (const t of withContract) {
    const m = t.day.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), t]);
  }

  let already = 0, saved = 0, dead = 0, empty = 0;
  const forDb: OptionPathRow[] = [];

  for (const [month, list] of [...byMonth.entries()].sort()) {
    const file = path.join(CACHE, `journal_paths_${month}.json`);
    const archive = (await readJson<Record<string, Path4[]>>(file)) ?? {};
    const todo = list.filter((t) => !archive[t.id]);
    already += list.length - todo.length;
    if (!todo.length) continue;

    console.log(`\n  ${month}: ${todo.length} trades without a path`);
    for (let i = 0; i < todo.length; i += BATCH) {
      await Promise.all(todo.slice(i, i + BATCH).map(async (t) => {
        const key = t.contract!.instrumentKey;
        const dayStart = Date.parse(`${t.day}T00:00:00Z`) + (9 * 60 + 15 - 330) * 60_000;
        try {
          const raw = await sessionCandles(key, t.day, today, 'minutes', 1);
          const bars = raw
            .map((c) => [Math.round((c[0] * 1000 - dayStart) / 60_000), c[2], c[3], c[4]] as Path4)
            .filter((b) => b[0] >= 0 && b[0] < 375)
            .sort((a, b) => a[0] - b[0]);
          if (!bars.length) { empty++; return; }
          archive[t.id] = bars;
          forDb.push({
            day: t.day, instrumentKey: key, symbol: t.symbol,
            strike: t.contract!.strike ?? null, optType: t.contract!.type ?? null,
            expiry: t.contract!.expiry ?? null, lotSize: t.contract!.lotSize ?? null,
            role: 'traded', bars,
          });
          saved++;
        } catch (e) {
          // The expected failure, not an anomaly: the series has expired and the key is refused.
          if (/UDAPI100011|Invalid Instrument key/i.test(String((e as Error).message))) dead++;
          else empty++;
        }
      }));
      process.stdout.write(`\r    ${Math.min(i + BATCH, todo.length)}/${todo.length}  saved ${saved} · expired ${dead}   `);
    }
    console.log();
    if (!dry && saved) await fs.writeFile(file, JSON.stringify(archive), 'utf8');
  }

  console.log(`\n  already archived  ${already}`);
  console.log(`  rescued now       ${saved}`);
  console.log(`  gone (expired)    ${dead}`);
  if (empty) console.log(`  no candles        ${empty}`);

  if (!dry && saved && databaseUrl()) {
    const n = await savePaths(getPool(), forDb).catch(() => 0);
    console.log(`  written to Neon   ${n}`);
  }
  if (dry) console.log('\n  --dry, nothing written.');
  console.log();
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
