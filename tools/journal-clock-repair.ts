// Re-stamp exits that were filed with the clock of the job that graded them.
//
//   npx tsx tools/journal-clock-repair.ts            list what is wrong
//   npx tsx tools/journal-clock-repair.ts --apply    fix it
//
// THE SIGNATURE. `settleDay` wrote `exit.at = Date.now()` for an exit whose minute it had just
// read off a candle. Settlement is a catch-up job, so that stamp is the moment the JOB RAN: on a
// normal day it lands at 15:16 and a 12:05 checkpoint is quietly filed at 3:16 PM, and on a row
// re-settled after dinner it lands at 22:26 and the journal shows a 15:15 square-off as 10:26 PM
// with an eleven-hour holding period. `exit.minute` was right the whole time; only the timestamp
// the page prints was wrong, which is why this is repairable at all.
//
// WHAT IS LEFT ALONE:
//
//   manual exits             `exit.at` is the instant the operator clicked. It is a real event
//                            time and the minute was derived FROM it, not the other way round.
//   stamps already close     a live exit written by `journalTick` carries a genuine sub-minute
//                            timestamp. Anything within a minute of its own session minute is
//                            already telling the truth and is not rounded off for tidiness.
//   minutes outside the day  a row whose `exit.minute` is not a minute of the session (795, from
//                            a tick that ran at 22:30) has no sound minute to rebuild a stamp
//                            from. Re-stamping it would only make a bad exit look plausible, so
//                            it is reported for re-settling instead.
//
// `entry.at` and `mark.at` are never touched. Both are real observations with clocks of their own.

import '../src/env.js';

import { journalRepository } from '../src/momentum/journal/journal.js';
import { closePool } from '../src/momentum/journal/postgres.js';
import { sessionAt, SESSION_MINUTES } from '../src/momentum/session.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

const FROM = '2026-01-01';
const TO = '2027-12-31';
/** Below this the stamp is a genuine live one and is left as it is. */
const TOLERANCE_MS = 60_000;

const apply = process.argv.includes('--apply');

const clock = (ms: number): string =>
  new Date(ms + 5.5 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);

const repo = journalRepository();
const all = await repo.range(FROM, TO);

const fix: Array<{ t: JournalTrade; from: number; to: number }> = [];
const unsound: JournalTrade[] = [];

for (const t of all) {
  if (!t.exit) continue;
  if (t.exit.source === 'manual') continue;
  if (t.exit.minute < 0 || t.exit.minute > SESSION_MINUTES) { unsound.push(t); continue; }
  const want = sessionAt(t.day, t.exit.minute);
  if (Math.abs(t.exit.at - want) < TOLERANCE_MS) continue;
  fix.push({ t, from: t.exit.at, to: want });
}

console.log(`\n  ${all.length} trades in the record, ${fix.length} filed under the wrong clock.\n`);

const byDay = new Map<string, number>();
for (const f of fix) byDay.set(f.t.day, (byDay.get(f.t.day) ?? 0) + 1);

for (const f of fix.slice(0, 12)) {
  console.log(
    `  ${f.t.day}  ${f.t.symbol.padEnd(12)} minute ${String(f.t.exit!.minute).padStart(3)}  ` +
    `${clock(f.from)}  ->  ${clock(f.to)}`,
  );
}
if (fix.length > 12) console.log(`  ... and ${fix.length - 12} more`);

if (byDay.size) {
  console.log('\n  by day:');
  for (const [day, n] of [...byDay].sort()) console.log(`    ${day}  ${n}`);
}

if (unsound.length) {
  console.log(`\n  ${unsound.length} row(s) carry a minute that is not in the session at all.`);
  console.log('  These need re-settling from candles, not a new stamp:\n');
  for (const t of unsound)
    console.log(`    ${t.day}  ${t.symbol.padEnd(12)} minute ${t.exit!.minute}  ` +
      `${t.exit!.reason}  settled=${t.settled}`);
}

if (!fix.length) {
  console.log('\n  Nothing to re-stamp.\n');
  await closePool();
  process.exit(0);
}

if (!apply) {
  console.log('\n  Dry run. Re-run with --apply to write these.\n');
  await closePool();
  process.exit(0);
}

for (const f of fix) {
  f.t.exit!.at = f.to;
  f.t.updatedAt = Date.now();
}
await repo.save(fix.map((f) => f.t));
await repo.flush().catch(() => {});
console.log(`\n  Re-stamped ${fix.length} exits.\n`);
await closePool();
