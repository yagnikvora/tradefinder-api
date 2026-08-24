// Capture the strike -> instrument-key map for the option series that are live RIGHT NOW.
//
//   npx tsx tools/option-keys-capture.ts                  the near expiry, every F&O symbol
//   npx tsx tools/option-keys-capture.ts 2026-09-29       a specific expiry
//
// WHY THIS IS URGENT AND NOTHING ELSE HERE IS. Upstox option instrument keys are opaque numeric
// tokens — `NSE_FO|144219` — and nothing about a symbol, strike, expiry or type derives them. The
// only two ways to learn one are `/v2/option/contract` and `/v2/option/chain`, and BOTH answer
// only for contracts that have not yet expired. Verified on 2026-08-24: the chain for the July
// series (2026-07-28) came back `[]`, and `/v2/option/contract` listed 2026-08-25, 2026-09-29 and
// 2026-10-27 and nothing earlier. The published instrument master is the current tradeable
// universe, so expired contracts are not in it either.
//
// The CANDLES for an expired contract are still served — `/v3/historical-candle` answers happily
// for a key you already hold, back through the contract's whole traded life. So the key is the
// only perishable half of the record. Once the series expires, a backfill that needed it is not
// merely harder, it is impossible.
//
// That asymmetry is the whole reason this tool exists separately from the backfill that consumes
// it: capturing is cheap, must happen before expiry, and is worth doing even if the backfill is
// never written. Run it once a month, a few days before the monthly expiry.

import '../src/env.js';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { call } from '../src/upstox.js';
import { expiries, chosenExpiry } from '../src/momentum/data/option-chain.js';
import { universe, type UniverseMember } from '../src/momentum/data/universe.js';
import { istDay } from '../src/momentum/session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, '..', '.cache', 'option-keys');

/** Upstox concurrency: the ladder fetcher uses 8 and measured no rejections. Match it. */
const BATCH = 8;

interface RawLeg { instrument_key?: string }
interface RawChainRow {
  strike_price?: number;
  underlying_spot_price?: number;
  call_options?: RawLeg;
  put_options?: RawLeg;
}

/** symbol -> strike -> { ce, pe } */
export interface KeyMap {
  expiry: string;
  capturedOn: string;
  symbols: Record<string, { spot: number; strikes: Record<string, { ce: string | null; pe: string | null }> }>;
}

async function chainKeys(underlyingKey: string, expiry: string) {
  const raw = await call<RawChainRow[]>(
    `/v2/option/chain?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${encodeURIComponent(expiry)}`,
  );
  if (!Array.isArray(raw) || !raw.length) return null;
  const strikes: Record<string, { ce: string | null; pe: string | null }> = {};
  for (const r of raw) {
    if (typeof r.strike_price !== 'number') continue;
    strikes[String(r.strike_price)] = {
      ce: r.call_options?.instrument_key ?? null,
      pe: r.put_options?.instrument_key ?? null,
    };
  }
  return { spot: raw.find((r) => r.underlying_spot_price)?.underlying_spot_price ?? 0, strikes };
}

async function main(): Promise<void> {
  const today = istDay(Date.now());
  const members: UniverseMember[] = (await universe()).members.filter((m) => m.equityKey);

  const asked = process.argv[2];
  let expiry: string | null = asked ?? null;
  if (!expiry) {
    // Resolved off a symbol that is certain to have a chain, then reused for the whole board:
    // stock options are monthly and share one expiry date.
    const probe = members.find((m) => m.symbol === 'RELIANCE') ?? members[0];
    expiry = chosenExpiry(await expiries(probe.equityKey), today);
  }
  if (!expiry) throw new Error('could not resolve an expiry to capture');

  console.log(`\n  Capturing option keys for expiry ${expiry} — ${members.length} symbols\n`);

  const series: string = expiry;
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${series}.json`);

  // RESUMABLE, because the first run against 208 symbols lost 20 of them to throttling, and a
  // capture that has to succeed all-or-nothing on the day before expiry is a bad bet. An existing
  // file is merged into and only the symbols missing from it are requested again.
  const prior = await fs.readFile(file, 'utf8').then((t) => JSON.parse(t) as KeyMap).catch(() => null);
  const out: KeyMap = prior?.expiry === series ? prior : { expiry: series, capturedOn: today, symbols: {} };
  if (prior) console.log(`  resuming — ${Object.keys(out.symbols).length} already captured\n`);

  let ok = Object.keys(out.symbols).length, empty = 0, failed = 0;
  let pending = members.filter((m) => !out.symbols[m.symbol]);

  // Retried with a widening pause. A throttle answers instantly, so a failed batch that is not
  // slowed down simply fails again at the same rate.
  for (let attempt = 1; pending.length && attempt <= 4; attempt++) {
    const missed: UniverseMember[] = [];
    for (let i = 0; i < pending.length; i += BATCH) {
      await Promise.all(pending.slice(i, i + BATCH).map(async (m) => {
        try {
          const got = await chainKeys(m.equityKey, series);
          if (!got || !Object.keys(got.strikes).length) { empty++; return; }
          out.symbols[m.symbol] = got;
          ok++;
        } catch {
          missed.push(m);
        }
      }));
      process.stdout.write(`\r  pass ${attempt}: ${Math.min(i + BATCH, pending.length)}/${pending.length}  ok ${ok} · to retry ${missed.length}   `);
      if (attempt > 1) await new Promise((res) => setTimeout(res, 250 * attempt));
    }
    // Written after every pass, so an interrupted capture keeps whatever it already has.
    await fs.writeFile(file, JSON.stringify(out), 'utf8');
    pending = missed;
    failed = missed.length;
    if (pending.length) {
      console.log(`\n  ${pending.length} failed on pass ${attempt} — pausing before the next`);
      await new Promise((res) => setTimeout(res, 1500 * attempt));
    }
  }

  const strikes = Object.values(out.symbols).reduce((a, s) => a + Object.keys(s.strikes).length, 0);
  console.log(`\n\n  ${ok} symbols · ${strikes} strikes · ${strikes * 2} contract keys`);
  console.log(`  saved to .cache/option-keys/${expiry}.json\n`);
  if (empty || failed) console.log(`  ${empty} served an empty chain, ${failed} errored — usually illiquid names with no chain.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
