// Today is served only by the intraday endpoint — the historical range above stops at
// yesterday. Merged into the same per-symbol files so everything downstream sees one series.
import '../src/env.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { todaySession, inBatches } from '../src/momentum/data/candles.js';
import { universe } from '../src/momentum/data/universe.js';

const OUT = new URL('./data/min/', import.meta.url).pathname.replace(/^\//, '');
const DAY = process.argv[2] ?? '2026-08-20';

async function main(): Promise<void> {
  const uni = await universe();
  const targets = [
    ...uni.members.map((m) => ({ symbol: m.symbol, key: m.equityKey })),
    { symbol: '_NIFTY', key: uni.niftyKey },
  ];
  let ok = 0, empty = 0, failed = 0;
  await inBatches(targets, 6, async (t) => {
    const path = `${OUT}${t.symbol}.json`;
    if (!existsSync(path)) return;
    const file = JSON.parse(readFileSync(path, 'utf8')) as { symbol: string; days: Record<string, number[][]> };
    if (file.days[DAY]?.length) { ok++; return; }
    try {
      const rows = await todaySession(t.key, DAY, 1);
      const bars = rows
        .filter((c) => c.day === DAY && c.minute >= 0 && c.minute <= 374)
        .map((c) => [c.minute, c.open, c.high, c.low, c.close, c.volume]);
      if (!bars.length) { empty++; return; }
      bars.sort((a, b) => a[0] - b[0]);
      file.days[DAY] = bars;
      writeFileSync(path, JSON.stringify(file));
      ok++;
    } catch { failed++; }
  });
  console.log(`${DAY}: ${ok} merged, ${empty} empty, ${failed} failed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
