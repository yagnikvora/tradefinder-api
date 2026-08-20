// Real daily bars, one request per symbol.
//
// The study built its ATR by synthesising daily bars from 1-minute sessions for the most recent
// days, because the cached daily history stopped short of them. That is close but not the same
// number production uses: a synthesised close is the 15:29 minute close and the official one is
// the closing-auction print, and the gap fed straight into every ATR-scaled threshold in the
// rule. Measured on 2026-08-20 it moved ATR by a median 1.3% and by up to 17% on individual
// names, which was enough to delete a signal from the holdout.
//
// So the study gets the same daily bars the production baseline gets, and the thresholds are
// re-validated against them.

import '../src/env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { historical, inBatches } from '../src/momentum/data/candles.js';
import { universe } from '../src/momentum/data/universe.js';

const OUT = new URL('./data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FROM = process.argv[2] ?? '2026-03-01';
const TO = process.argv[3] ?? '2026-08-20';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const uni = await universe();
  const out: Record<string, Array<[string, number, number, number, number, number]>> = {};
  let ok = 0, failed = 0;

  await inBatches(uni.members, 6, async (m) => {
    try {
      const bars = await historical(m.equityKey, 'days', 1, FROM, TO);
      out[m.symbol] = bars
        .filter((b) => b.day >= FROM && b.day <= TO)
        .map((b) => [b.day, b.open, b.high, b.low, b.close, b.volume]);
      ok++;
      if (ok % 50 === 0) console.log(`  ${ok} symbols`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${m.symbol}: ${String((e as Error).message).slice(0, 80)}`);
    }
  });

  writeFileSync(`${OUT}daily-real.json`, JSON.stringify({ from: FROM, to: TO, symbols: out }));
  const sample = out.MUTHOOTFIN ?? Object.values(out)[0];
  console.log(`\n${ok} symbols written, ${failed} failed`);
  console.log(`sample: ${sample?.length} bars, last ${JSON.stringify(sample?.[sample.length - 1])}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
