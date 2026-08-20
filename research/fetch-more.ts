// Extend the cached window backwards. Merges into the existing per-symbol files so the study
// set doubles without re-fetching what is already on disk.
import '../src/env.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { historical, inBatches } from '../src/momentum/data/candles.js';
import { universe } from '../src/momentum/data/universe.js';

const OUT = new URL('./data/min/', import.meta.url).pathname.replace(/^\//, '');
const FROM = process.argv[2], TO = process.argv[3];

async function main(): Promise<void> {
  const uni = await universe();
  const targets = [
    ...uni.members.map((m) => ({ symbol: m.symbol, key: m.equityKey })),
    { symbol: '_NIFTY', key: uni.niftyKey },
  ];
  let ok = 0, failed = 0, added = 0;
  await inBatches(targets, 6, async (t) => {
    const path = `${OUT}${t.symbol}.json`;
    if (!existsSync(path)) return;
    const file = JSON.parse(readFileSync(path, 'utf8')) as { symbol: string; days: Record<string, number[][]> };
    try {
      const rows = await historical(t.key, 'minutes', 1, FROM, TO);
      let n = 0;
      for (const c of rows) {
        if (c.minute < 0 || c.minute > 374) continue;
        if (file.days[c.day] && file.days[c.day].length > 300) continue;
        (file.days[c.day] ??= []).push([c.minute, c.open, c.high, c.low, c.close, c.volume]);
        n++;
      }
      for (const d of Object.keys(file.days)) file.days[d].sort((a, b) => a[0] - b[0]);
      writeFileSync(path, JSON.stringify(file));
      added += n; ok++;
      if (ok % 50 === 0) console.log(`  ${ok} symbols extended`);
    } catch (e) {
      failed++;
    }
  });
  console.log(`extended ${ok} symbols, ${failed} failed, ${added} bars added`);
}
main().catch((e) => { console.error(e); process.exit(1); });
