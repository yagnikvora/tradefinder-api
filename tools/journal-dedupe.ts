// One stock, one position, one day — across channels.
//
//   npx tsx tools/journal-dedupe.ts            list the stocks taken twice
//   npx tsx tools/journal-dedupe.ts --apply    delete the later of each pair
//
// THE PROBLEM. Displacement fires between 09:27 and 10:00; a trend day cannot confirm before
// 10:30. When the same underlying clears both, the journal records two trades on what is one
// move read twice — two lots of premium on a single thesis, reported as two independent signals.
// On 2026-09-09 it happened three times before eleven o'clock.
//
// `newlyConfirmed` now refuses a symbol displacement has already taken, so this cannot recur.
// This tool is for what is already in the record.
//
// WHICH ONE GOES. The later one, always. The earlier alert is the one that was actually
// actionable at the time it fired, and the later channel only ever saw a move the first had
// already named. Ties are impossible in practice — the windows do not overlap — but if the
// minutes match, the tool refuses the pair rather than guessing.
//
// WHAT IT DELETES. The journal row, from the local month document AND from the database, because
// `reconcile` pushes any local row the database is missing and a one-sided delete comes straight
// back on the next boot. Its archived option path goes too: a path is evidence about a trade, and
// one whose trade no longer exists is not evidence of anything.
//
// ON A TWO-MACHINE SETUP THIS MUST BE RUN ON BOTH. The recording machine keeps its own local copy
// and will re-push these rows the next time it boots and reconciles.

import '../src/env.js';

import { journalRepository } from '../src/momentum/journal/journal.js';
import { store } from '../src/momentum/store.js';
import { closePool, databaseUrl, getPool } from '../src/momentum/journal/postgres.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

const FROM = '2026-01-01';
const TO = '2027-12-31';

const apply = process.argv.includes('--apply');
const m2t = (m: number): string => {
  const x = 9 * 60 + 15 + m;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

const repo = journalRepository();
const all = await repo.range(FROM, TO);

/** day -> symbol -> the trades on it, whatever channel they came from. */
const byDaySymbol = new Map<string, Map<string, JournalTrade[]>>();
for (const t of all) {
  const day = byDaySymbol.get(t.day) ?? new Map<string, JournalTrade[]>();
  day.set(t.symbol, [...(day.get(t.symbol) ?? []), t]);
  byDaySymbol.set(t.day, day);
}

const drop: JournalTrade[] = [];
const ambiguous: JournalTrade[][] = [];

for (const [, symbols] of [...byDaySymbol].sort()) {
  for (const [, trades] of symbols) {
    if (trades.length < 2) continue;
    const ordered = [...trades].sort((a, b) => a.entry.minute - b.entry.minute);
    if (ordered[0].entry.minute === ordered[1].entry.minute) { ambiguous.push(ordered); continue; }
    drop.push(...ordered.slice(1));
  }
}

console.log(`\n  ${all.length} trades in the record, ${drop.length} to remove.\n`);

for (const t of drop) {
  const kept = (byDaySymbol.get(t.day)!.get(t.symbol) ?? [])
    .filter((o) => o.id !== t.id)
    .map((o) => `${o.channel} ${m2t(o.entry.minute)}`)
    .join(', ');
  console.log(
    `  ${t.day}  ${t.symbol.padEnd(12)} DROP ${t.channel.padEnd(12)} ${m2t(t.entry.minute)}  ` +
    `${String(t.contract?.label ?? '—').padEnd(10)} net ${String(t.netPnl ?? 0).padStart(9)}   ` +
    `keeping: ${kept}`,
  );
}

if (ambiguous.length) {
  console.log(`\n  ${ambiguous.length} pair(s) entered in the same minute and were NOT touched:`);
  for (const pair of ambiguous)
    console.log(`    ${pair[0].day} ${pair[0].symbol} — ${pair.map((t) => t.channel).join(' + ')}`);
}

if (!drop.length) {
  console.log('  Nothing to remove.\n');
  await closePool();
  process.exit(0);
}

const removed = drop.reduce((s, t) => s + (t.netPnl ?? 0), 0);
console.log(`\n  Removing these changes the booked total by ${(-removed).toFixed(2)}.`);

if (!apply) {
  console.log('\n  Dry run. Re-run with --apply to delete.\n');
  await closePool();
  process.exit(0);
}

/* ------------------------------------------------------------------------- the delete --- */

// Local month documents first, for the same reason every other write here goes to disk first:
// it is the copy that cannot be unreachable, and it is the one `reconcile` pushes FROM.
const byMonth = new Map<string, JournalTrade[]>();
for (const t of drop) {
  const key = `journal_${t.day.slice(0, 7)}`;
  byMonth.set(key, [...(byMonth.get(key) ?? []), t]);
}
for (const [key, gone] of byMonth) {
  const doc = await store.read<{ month: string; trades: JournalTrade[] }>(key);
  if (!doc) continue;
  const ids = new Set(gone.map((t) => t.id));
  const before = doc.trades.length;
  doc.trades = doc.trades.filter((t) => !ids.has(t.id));
  await store.write(key, doc);
  console.log(`  ${key}: ${before} -> ${doc.trades.length}`);
}

// Then the database, and the paths that belonged to the rows just removed.
if (databaseUrl()) {
  const db = getPool();
  for (const t of drop) {
    await db.query('DELETE FROM momentum_journal WHERE id = $1', [t.id]);
    if (t.contract?.instrumentKey)
      await db.query(
        `DELETE FROM momentum_option_path WHERE day = $1 AND instrument_key = $2 AND role = 'traded'`,
        [t.day, t.contract.instrumentKey],
      );
  }
  console.log(`  database: ${drop.length} trades and their traded paths deleted`);
}

// The local path archive keys on the trade id, so it is cleared the same way.
const pathMonths = new Map<string, Set<string>>();
for (const t of drop) {
  const key = `journal_paths_${t.day.slice(0, 7)}`;
  pathMonths.set(key, (pathMonths.get(key) ?? new Set()).add(t.id));
}
for (const [key, ids] of pathMonths) {
  const doc = await store.read<Record<string, unknown>>(key);
  if (!doc) continue;
  let n = 0;
  for (const id of ids) if (doc[id]) { delete doc[id]; n++; }
  if (n) { await store.write(key, doc); console.log(`  ${key}: ${n} path(s) removed`); }
}

console.log('\n  Done. Run this on the recording machine too, or its next boot pushes them back.\n');
await closePool();
