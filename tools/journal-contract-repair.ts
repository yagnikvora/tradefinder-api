// Give a contract to a journal row that never got one, then settle it through the shipped path.
//
//   npx tsx tools/journal-contract-repair.ts 2026-09-01:trend-day:KALYANKJIL --dry
//   npx tsx tools/journal-contract-repair.ts 2026-09-01:trend-day:KALYANKJIL
//
// WHAT THIS IS FOR. `recordEntries` journals a signal even when no contract could be named, so the
// record does not overstate how tradeable the feed is — the row lands `closed / untracked` with no
// premium, no path and no grade. That is the honest default, but it also means the row can never
// answer a question. This tool fills the gap for one such row: it names the strike, takes the
// entry from that contract's own 1-minute candle, and then hands the row to `settleDay`, which
// archives the path and grades it with exactly the rule every other row that day was graded by.
//
// WHAT IS REAL HERE AND WHAT IS NOT — the same disclosure `tools/journal-backfill.ts` carries,
// because the same two compromises apply.
//
//   REAL. That the signal fired, when it fired, and on what reading: this row was written by the
//   live scan, so `entry.at`, `entry.minute`, `entry.spot` and `readings` are untouched. The
//   option prices: the contract's OWN 1-minute candles from Upstox. The grading: `settleDay`,
//   unchanged, at the configured targets and checkpoint.
//
//   NOT REAL. THE ENTRY IS A TRADED PRICE, NOT THE ASK — a live fill pays the offer, so this is
//   cheaper than the real one would have been by something like half the spread.
//   `spreadPctAtEntry` stays null rather than guessed.
//
//   NOT REAL. THE STRIKE IS THE NEAREST ONE TO SPOT. `selectStrike` walks a ladder on delta,
//   spread and open interest, none of which survives the session. Same convention as the backfill.
//
// Every repaired row carries `readings.backfill = 1`, the marker the backfill tool defined and the
// one place `JournalPatch` cannot reach, so a repaired row stays distinguishable from a live one
// for as long as the journal exists.

import '../src/env.js';

import { stockChain } from '../src/momentum/data/option-chain.js';
import { universe } from '../src/momentum/data/universe.js';
import { sessionCandles } from '../src/upstox.js';
import { journalRepository, sessionBars, settleDay } from '../src/momentum/journal/journal.js';
import { closePool, databaseUrl } from '../src/momentum/journal/postgres.js';

const DRY = process.argv.includes('--dry');
const id = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}:[a-z-]+:.+$/.test(a));

const round = (n: number, dp = 2): number => +n.toFixed(dp);

async function main() {
  if (!id) { console.error('usage: journal-contract-repair.ts <trade-id> [--dry]'); process.exitCode = 1; return; }

  const repo = journalRepository();
  const t = await repo.one(id);
  if (!t) { console.error(`no such trade: ${id}`); process.exitCode = 1; return; }

  console.log(`${t.day} ${t.channel} ${t.symbol}  dir=${t.direction > 0 ? '+1' : '-1'}  spot@entry=${t.entry.spot}  minute=${t.entry.minute}`);
  if (t.contract) { console.log('  already has a contract — nothing to repair.'); return; }
  if (t.edited) { console.log('  edited by the operator — refusing to overwrite.'); return; }

  // ---- 1. the strike: nearest to the spot the signal fired at
  const uni = await universe(Date.now());
  const member = uni.bySymbol.get(t.symbol);
  if (!member) { console.error(`  ${t.symbol} is not in the F&O universe`); process.exitCode = 1; return; }

  const chain = await stockChain(t.symbol, member.equityKey, Date.now());
  const rows = chain?.rows ?? [];
  if (!rows.length) { console.error('  option chain came back empty'); process.exitCode = 1; return; }

  const type: 'CE' | 'PE' = t.direction === 1 ? 'CE' : 'PE';
  const spot = t.entry.spot;
  if (!(spot && spot > 0)) { console.error('  no entry spot on the row'); process.exitCode = 1; return; }

  let best: { strike: number; key: string } | null = null;
  for (const r of rows) {
    const leg = type === 'CE' ? r.call : r.put;
    if (!leg?.instrumentKey) continue;
    if (!best || Math.abs(r.strike - spot) < Math.abs(best.strike - spot)) best = { strike: r.strike, key: leg.instrumentKey };
  }
  if (!best) { console.error(`  no ${type} leg anywhere in the chain`); process.exitCode = 1; return; }

  const lotSize = member.future?.lotSize ?? null;
  if (!lotSize) { console.error('  no futures lot size for this symbol'); process.exitCode = 1; return; }

  // ---- 2. the entry: that contract's own candle for the minute the alert fired
  const bars = sessionBars(await sessionCandles(best.key, t.day, t.day, 'minutes', 1));
  const at = bars.find((b) => b.minute === t.entry.minute) ?? bars.find((b) => b.minute >= t.entry.minute);
  if (!at || !(at.close > 0)) { console.error(`  no candle at minute ${t.entry.minute} for ${best.key}`); process.exitCode = 1; return; }

  const paid = round(at.close);
  console.log(`  strike   ${best.strike} ${type}  (${best.key}, exp ${chain.expiry}, lot ${lotSize})`);
  console.log(`  entry    ${paid} at minute ${at.minute}   ->  ${round(paid * lotSize * t.lots)} deployed`);
  console.log(`  bars     ${bars.length} minutes of candles for the contract`);

  if (DRY) { console.log('\n--dry, nothing written.'); return; }

  // ---- 3. reopen the row with its contract, then let the shipped settlement do the rest
  t.contract = {
    label: `${best.strike} ${type}`,
    strike: best.strike,
    type,
    instrumentKey: best.key,
    expiry: chain.expiry,
    lotSize,
  };
  t.entry = { ...t.entry, premium: paid };
  t.exit = null;
  t.mark = null;
  t.markedFrom = null;
  // Candles carry no book. A guessed spread is worse than a gap.
  t.spreadPctAtEntry = null;
  t.readings = { ...t.readings, backfill: 1 };
  t.note = 'SEEDED — live signal, reconstructed contract. The trend-day plan was withheld (session '
    + 'extreme was 48 min old at the 10:30 confirm, past the 45-min limit, so the ATR budget was '
    + 'withdrawn and no target could be sized), and no plan means no strike is chosen. Strike is '
    + 'the nearest to spot, not the live delta pick. Entry is a traded price, not the ask.';
  t.status = 'open';
  t.settled = false;
  t.updatedAt = Date.now();

  await repo.save([t]);
  // Archives the contract's path (local + Postgres) BEFORE grading, then grades with the same
  // gradePath + checkpoint and the same trail-aware shadows every other row that day used.
  const n = await settleDay(t.day);
  console.log(`\n  settled ${n} row(s) through settleDay`);

  const after = await repo.one(id);
  if (after) {
    const inr = (v: number | null) => (v === null ? '—' : 'Rs ' + Math.round(v).toLocaleString('en-IN'));
    console.log(`  exit     ${after.exit?.premium} at minute ${after.exit?.minute} (${after.exit?.reason})`);
    console.log(`  MFE      ${((after.mfePct ?? 0) * 100).toFixed(1)}% @m${after.mfeMinute}   MAE ${((after.maePct ?? 0) * 100).toFixed(1)}% @m${after.maeMinute}`);
    console.log(`  gross    ${inr(after.grossPnl)}   charges ${inr(after.charges)}   net ${inr(after.netPnl)} (${((after.netPct ?? 0) * 100).toFixed(2)}%)`);
    console.log(`  shadow   ${after.shadow.map((s) => `${s.name} ${(s.pct * 100).toFixed(1)}% ${s.out}`).join(' · ')}`);
  }
  if (databaseUrl()) await closePool();
}

main();
