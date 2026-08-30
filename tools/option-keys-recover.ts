// Rebuild an option-key map for an expiry that has ALREADY PASSED.
//
//   npx tsx tools/option-keys-recover.ts 2026-03-30        one expiry
//   npx tsx tools/option-keys-recover.ts --months 6        every monthly expiry in the last 6
//   npx tsx tools/option-keys-recover.ts --list            what Upstox still holds, and how far back
//
// WHY THIS EXISTS. `option-keys-capture.ts` has to run BEFORE an expiry, because the live chain
// endpoint stops answering for a dead series. Miss the window and that month is unreplayable: the
// journal can still name the contract it bought, but nothing can price it. That is why the study
// covered one month — exactly one map had ever been captured.
//
// Upstox's expired-instruments API removes the deadline. It serves the full strike ladder, with
// instrument keys, for any expiry it still holds — 23 monthly series as of 2026-08-30, back to
// 2024-10-31. So a map that was never captured can be rebuilt after the fact, and this writes it
// in the SAME shape `option-keys-capture.ts` writes, into the same directory, so `journal-backfill`
// cannot tell the difference.
//
// THE ONE REAL DIFFERENCE, and it matters for strike selection. The live capture records
// `underlying_spot_price` as it stood at capture time; the expired endpoint does not return a spot
// at all. `spot` is therefore written as 0, which is honest rather than invented — the backfill
// picks its strike from the replayed equity candle for the session it is pricing, not from this
// field, so nothing downstream reads it. Do not "fix" it by back-filling a close: a single spot for
// a month-long series would be wrong on every day but one.
//
// Requires an Upstox Plus subscription; without it every call returns UDAPI1149.

import '../src/env.js';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { istDay } from '../src/momentum/session.js';
import { universe, type UniverseMember } from '../src/momentum/data/universe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, '..', '.cache', 'option-keys');
const BASE = 'https://api.upstox.com';
const BATCH = 6;

interface KeyMap {
  expiry: string;
  capturedOn: string;
  /** `spot` is 0 for a recovered map — see the header. */
  symbols: Record<string, { spot: number; strikes: Record<string, { ce: string | null; pe: string | null }> }>;
}

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

async function api(p: string): Promise<unknown> {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) throw new Error('UPSTOX_ACCESS_TOKEN is not set');
  const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const text = await r.text();
  if (!r.ok) {
    let code = '';
    try { code = (JSON.parse(text) as { errors?: { errorCode?: string }[] })?.errors?.[0]?.errorCode ?? ''; } catch { /* raw */ }
    if (code === 'UDAPI1149') throw new Error('PLAN: Upstox Plus is required for expired-instrument data');
    throw new Error(`${r.status} ${code || text.slice(0, 80)}`);
  }
  return JSON.parse(text);
}

/** Every expiry Upstox still holds for a symbol, oldest first. */
async function pastExpiries(equityKey: string): Promise<string[]> {
  const j = await api(`/v2/expired-instruments/expiries?instrument_key=${encodeURIComponent(equityKey)}`) as { data?: string[] };
  return (j.data ?? []).slice().sort();
}

/** The strike ladder for one symbol in one dead series. */
async function ladder(equityKey: string, expiry: string): Promise<KeyMap['symbols'][string] | null> {
  const j = await api(
    `/v2/expired-instruments/option/contract?instrument_key=${encodeURIComponent(equityKey)}&expiry_date=${expiry}`,
  ) as { data?: { strike_price?: number; instrument_type?: string; instrument_key?: string }[] };
  const rows = j.data ?? [];
  if (!rows.length) return null;
  const strikes: KeyMap['symbols'][string]['strikes'] = {};
  for (const r of rows) {
    if (typeof r.strike_price !== 'number' || !r.instrument_key) continue;
    const k = String(r.strike_price);
    strikes[k] ??= { ce: null, pe: null };
    if (r.instrument_type === 'CE') strikes[k].ce = r.instrument_key;
    else if (r.instrument_type === 'PE') strikes[k].pe = r.instrument_key;
  }
  return Object.keys(strikes).length ? { spot: 0, strikes } : null;
}

async function recover(expiry: string, members: UniverseMember[], today: string): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${expiry}.json`);

  // Resumable and non-destructive, like the live capture: a real capture is strictly better than a
  // recovered one (it has a spot), so an existing file is merged into and never overwritten.
  const prior = await fs.readFile(file, 'utf8').then((t) => JSON.parse(t) as KeyMap).catch(() => null);
  const out: KeyMap = prior?.expiry === expiry ? prior : { expiry, capturedOn: today, symbols: {} };
  const already = Object.keys(out.symbols).length;

  let ok = already, empty = 0;
  let pending = members.filter((m) => !out.symbols[m.symbol]);
  if (!pending.length) { console.log(`  ${expiry}  already complete (${already} symbols)`); return; }

  for (let attempt = 1; pending.length && attempt <= 4; attempt++) {
    const missed: UniverseMember[] = [];
    for (let i = 0; i < pending.length; i += BATCH) {
      await Promise.all(pending.slice(i, i + BATCH).map(async (m) => {
        try {
          const got = await ladder(m.equityKey, expiry);
          if (!got) { empty++; return; }          // not in F&O that month — expected going back
          out.symbols[m.symbol] = got;
          ok++;
        } catch (e) {
          if ((e as Error).message.startsWith('PLAN:')) throw e;
          missed.push(m);
        }
      }));
      process.stdout.write(`\r  ${expiry}  pass ${attempt}: ${Math.min(i + BATCH, pending.length)}/${pending.length} · ok ${ok} · retry ${missed.length}   `);
      if (attempt > 1) await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    await fs.writeFile(file, JSON.stringify(out), 'utf8');
    pending = missed;
  }
  process.stdout.write('\r');
  console.log(`  ${expiry}  ${ok} symbols · ${empty} not in F&O that month · ${pending.length} unrecovered`.padEnd(78));
}

async function main(): Promise<void> {
  const today = istDay(Date.now());
  const members = (await universe()).members.filter((m) => m.equityKey);
  const probe = members.find((m) => m.symbol === 'RELIANCE') ?? members[0];
  const held = await pastExpiries(probe.equityKey);

  if (flag('list')) {
    console.log(`\n  Upstox still holds ${held.length} monthly expiries for ${probe.symbol}:\n`);
    for (const e of held) console.log(`    ${e}`);
    const have = await fs.readdir(OUT_DIR).catch(() => [] as string[]);
    const haveSet = new Set(have.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')));
    console.log(`\n  captured or recovered locally: ${[...haveSet].sort().join(', ') || 'none'}`);
    console.log(`  recoverable but missing: ${held.filter((e) => !haveSet.has(e)).join(', ') || 'none'}\n`);
    return;
  }

  let wanted: string[];
  const asked = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (asked) wanted = [asked];
  else {
    const months = Number(opt('months') ?? 6);
    // The N most recent expiries Upstox still holds — "the last N months" in the only sense the
    // data supports, since stock options are monthly.
    wanted = held.slice(-months);
  }

  const unheld = wanted.filter((e) => !held.includes(e));
  if (unheld.length) {
    console.error(`\n  Not available from Upstox: ${unheld.join(', ')}`);
    console.error(`  It holds ${held[0]} .. ${held[held.length - 1]}. Run with --list to see all.\n`);
  }
  wanted = wanted.filter((e) => held.includes(e));
  if (!wanted.length) { console.error('  Nothing to recover.\n'); return; }

  console.log(`\n  Recovering option keys for ${wanted.length} expiries · ${members.length} symbols each`);
  console.log(`  ${wanted.join(', ')}\n`);
  for (const e of wanted) await recover(e, members, today);
  console.log(`\n  Done. journal-backfill can now price every session these series covered.\n`);
}

main().catch((e) => {
  const m = (e as Error).message;
  if (m.startsWith('PLAN:')) {
    console.error(`\n  ${m.slice(6)}`);
    console.error('  The key format and endpoint are correct — the account is not entitled to the data.\n');
    process.exitCode = 2;
  } else {
    console.error(e);
    process.exitCode = 1;
  }
});
