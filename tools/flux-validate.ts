// Money Flux bucketing check.  Run: npm run check-flux
//
// The histogram folds five-minute readings into whatever bucket the page asked for. This
// drives bucketFlux over a synthetic session so the aggregation, the alignment to 09:15,
// the resolution floor and the gap reporting are all checked without a market being open
// or a token being present.
//
// Nothing here touches the network; bucketFlux is pure.

import { bucketFlux, type FluxReading } from '../src/flux.js';

const DAY = '2026-07-31';
const OPEN = Date.UTC(2026, 6, 31) / 1000 - 330 * 60 + 9 * 3600 + 15 * 60; // 09:15 IST
const CLOSE = OPEN + 6 * 3600 + 15 * 60;                                   // 15:30 IST
const EXP = '04Aug26';
const SLOT = 300; // the candle resolution the ladder is built at

// A full session: a reading every five minutes from 09:20 to 15:30, with both
// sides swinging sign so cancellation inside a bucket is actually exercised.
const full: FluxReading[] = Array.from({ length: 75 }, (_, i) => ({
  ts: OPEN + (i + 1) * 300,
  ce: (i % 3 === 0 ? -1 : 1) * (i + 1) * 1_000_000,
  pe: (i % 2 === 0 ? 1 : -1) * (i + 1) * 2_000_000,
}));

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}` +
    (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`),
  );
}

/** Which bucket a reading belongs to — recomputed here rather than reusing the module's. */
const bucketOf = (ts: number, width: number) => Math.floor((ts - OPEN) / width);
const net = (rs: FluxReading[]) => rs.reduce((a, r) => a + (r.pe - r.ce), 0);

/* --- one bucket per reading at the candle resolution --- */
const b5 = bucketFlux(full, EXP, 300, DAY, SLOT, CLOSE);
check('5m  bar count', b5.points.length, new Set(full.map((r) => bucketOf(r.ts, 300))).size);
check('5m  step', b5.step, 300);
check('5m  a full session reports no gaps', b5.missing, 0);
check('5m  side totals', [b5.ceFlow, b5.peFlow],
  [full.reduce((a, r) => a + r.ce, 0), full.reduce((a, r) => a + r.pe, 0)]);
check('5m  first bar is put flow minus call flow', b5.points[0][2], net([full[0]]));
check('5m  every bar tagged with the expiry', b5.points.every((p) => p[1] === EXP), true);

/* --- coarser buckets fold readings together without losing any --- */
const b15 = bucketFlux(full, EXP, 900, DAY, SLOT, CLOSE);
check('15m bar count', b15.points.length, new Set(full.map((r) => bucketOf(r.ts, 900))).size);
check('15m step', b15.step, 900);
check('15m side totals unchanged by bucket width', [b15.ceFlow, b15.peFlow], [b5.ceFlow, b5.peFlow]);
check('15m bars sum to the same total as 5m bars',
  b15.points.reduce((a, p) => a + p[2], 0), b5.points.reduce((a, p) => a + p[2], 0));
const firstBucket = Math.min(...full.map((r) => bucketOf(r.ts, 900)));
check('15m first bar holds every reading in its window',
  b15.points[0][2], net(full.filter((r) => bucketOf(r.ts, 900) === firstBucket)));
check('15m bars start on the 09:15 grid, not a UTC one',
  b15.points.every((p) => (p[0] - OPEN) % 900 === 0), true);
check('15m bars are ordered', b15.points.map((p) => p[0]).every((t, i, a) => i === 0 || t > a[i - 1]), true);

/* --- a bucket finer than the candles cannot be invented --- */
const b3 = bucketFlux(full, EXP, 180, DAY, SLOT, CLOSE);
check('3m  floors to the candle resolution', b3.step, 300);
check('3m  yields the same bars as 5m', b3.points.length, b5.points.length);

/* --- a feed that skipped candles is reported, not painted over --- */
const sparse = [full[0], full[40], full[74]];
const gaps = bucketFlux(sparse, EXP, 300, DAY, SLOT, CLOSE);
check('gaps: only real bars are drawn', gaps.points.length, sparse.length);
check('gaps: the missing rest is reported', gaps.missing, 75 - sparse.length);

const none = bucketFlux([], EXP, 300, DAY, SLOT, CLOSE);
check('empty: no bars', none.points.length, 0);
check('empty: whole session reported missing', none.missing, 75);

/* --- buckets that have not happened yet are not missing --- */
const mid = bucketFlux(full.slice(0, 12), EXP, 300, DAY, SLOT, OPEN + 3600);
check('mid-session: future buckets are not counted as gaps', mid.missing, 0);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
