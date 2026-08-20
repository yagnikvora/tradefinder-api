// One-off data pull for strategy research.
//
// ONE request per symbol buys ~23 sessions of 1-minute bars, because Upstox serves a 30-day
// 1-minute range in a single call. Fetching day-by-day would be 208 x 23 and spends the
// 30-minute quota in the first minute — which is exactly what happened on the first attempt.
//
// Written to disk once and never re-fetched: every rule below is tested against this file,
// so a rule change costs no upstream requests at all.

import '../src/env.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { historical, inBatches } from '../src/momentum/data/candles.js';
import { universe } from '../src/momentum/data/universe.js';

const OUT = new URL('./data/min/', import.meta.url).pathname.replace(/^\//, '');
const FROM = process.argv[2] ?? '2026-07-20';
const TO = process.argv[3] ?? '2026-08-20';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const uni = await universe();
  const targets = [
    ...uni.members.map((m) => ({ symbol: m.symbol, key: m.equityKey })),
    { symbol: '_NIFTY', key: uni.niftyKey },
  ];

  let done = 0, failed = 0, skipped = 0;
  await inBatches(targets, 6, async (t) => {
    const path = `${OUT}${t.symbol}.json`;
    if (existsSync(path)) { skipped++; return; }
    try {
      const rows = await historical(t.key, 'minutes', 1, FROM, TO);
      const days: Record<string, number[][]> = {};
      for (const c of rows) {
        if (c.minute < 0 || c.minute > 374) continue;
        (days[c.day] ??= []).push([c.minute, c.open, c.high, c.low, c.close, c.volume]);
      }
      for (const d of Object.keys(days)) days[d].sort((a, b) => a[0] - b[0]);
      writeFileSync(path, JSON.stringify({ symbol: t.symbol, days }));
      done++;
      if (done % 25 === 0) console.log(`  ${done} written, ${failed} failed, ${skipped} skipped`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${t.symbol}: ${(e as Error).message.slice(0, 90)}`);
    }
  });
  console.log(`\ndone: ${done} written, ${skipped} already present, ${failed} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
