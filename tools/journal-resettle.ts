// Re-settle trades that were graded against the empty-path bug.
//
//   npx tsx tools/journal-resettle.ts            list what looks affected
//   npx tsx tools/journal-resettle.ts --apply    reset them and settle again
//
// THE SIGNATURE. Before `sessionBars` existed, `settleDay` handed `gradePath` bars whose minute
// was derived by reading an epoch in SECONDS as MILLISECONDS. Every bar landed past the
// square-off minute and was discarded, so `gradePath` returned its no-path answer: an exit equal
// to the entry, at the entry minute, with zero excursion — booking exactly minus the charges.
//
// Those rows are identifiable: same premium in and out, same minute in and out, `square-off`, and
// no excursion either way. A genuinely flat trade is possible in principle but cannot also have
// exited in the minute it entered, so the pair of conditions is safe to match on.
//
// Edited rows are left alone. `settleDay` already refuses to overwrite an operator's own fill and
// this must not go around that.

import '../src/env.js';

import { journalRepository, settleDay } from '../src/momentum/journal/journal.js';
import { closePool } from '../src/momentum/journal/postgres.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

const FROM = '2026-01-01';
const TO = '2027-12-31';

/** A row that carries the empty-path signature. */
function affected(t: JournalTrade): boolean {
  if (t.edited || !t.exit || !t.contract) return false;
  if (t.readings?.backfill === 1) return false;      // backfill computed its own minutes
  return t.exit.reason === 'square-off'
    && t.exit.minute === t.entry.minute
    && t.exit.premium === t.entry.premium
    && (t.mfePct ?? 0) === 0
    && (t.maePct ?? 0) === 0;
}

const inr = (n: number | null): string =>
  n === null ? '—' : (n < 0 ? '-Rs ' : 'Rs ') + Math.round(Math.abs(n)).toLocaleString('en-IN');

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const repo = journalRepository();
  const all = await repo.range(FROM, TO);
  const hits = all.filter(affected);

  console.log(`\n  ${all.length} trades on record · ${hits.length} carry the flat-settle signature\n`);
  for (const t of hits) {
    console.log(`  ${t.day}  ${t.symbol.padEnd(12)} ${(t.contract?.label ?? '').padEnd(10)} ` +
      `in ${t.entry.premium} out ${t.exit!.premium} @min ${t.entry.minute}  net ${inr(t.netPnl)}`);
  }
  if (!hits.length) { console.log('  Nothing to do.\n'); await closePool(); return; }

  if (!apply) { console.log('\n  Re-run with --apply to settle these again.\n'); await closePool(); return; }

  // Hand the rows back to the settler. It owns `exit`, `shadow` and the excursions; clearing them
  // here as well would just be a second place that decides what an unsettled row looks like.
  for (const t of hits) { t.settled = false; t.updatedAt = Date.now(); }
  await repo.save(hits);

  let n = 0;
  for (const day of [...new Set(hits.map((t) => t.day))].sort()) n += await settleDay(day);
  console.log(`\n  re-settled ${n} trades`);

  for (const t of await repo.range(FROM, TO)) {
    if (!hits.some((h) => h.id === t.id)) continue;
    console.log(`  ${t.day}  ${t.symbol.padEnd(12)} in ${t.entry.premium} out ${t.exit?.premium} ` +
      `@min ${t.exit?.minute} ${t.exit?.reason}  net ${inr(t.netPnl)}`);
  }
  await repo.flush().catch(() => {});
  console.log();
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
