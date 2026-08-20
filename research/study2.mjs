// Same grid, but reporting what actually happened rather than one headline.
//
// The first pass showed a 12% target rate against a 45% "random walk" figure, which is not a
// finding — it is a horizon artefact. With barriers half an ATR wide and a few hours left, most
// trades reach NEITHER, and the infinite-time formula does not apply. What matters for an option
// buyer is: of the trades that resolve, how many resolve the right way, and how far did price
// travel in favour before it stopped.

import { loadUniverse, grade } from './lab.mjs';

const U = loadUniverse();
const FIT = U.days.filter((d) => d < '2026-08-19');
const nifty = U.nifty;

const T = 0.6, S = 0.5, HOLD = 120;   // 2 hours, the outer edge of an option-buyer hold

function features(r, m) {
  const s = r.s;
  const px = s.close[m];
  if (!Number.isFinite(px) || px <= 0) return null;
  const atr = r.atr, vw = s.vwap[m];
  const range = s.dayHigh[m] - s.dayLow[m];
  const dir = px > vw ? 1 : -1;

  let above = 0, seen = 0, crossings = 0, prevSide = 0;
  for (let k = 0; k <= m; k++) {
    if (!Number.isFinite(s.close[k])) continue;
    seen++;
    const side = s.close[k] > s.vwap[k] ? 1 : -1;
    if (side === 1) above++;
    if (prevSide !== 0 && side !== prevSide) crossings++;
    prevSide = side;
  }
  const nsess = nifty.sessions.get(r.day);
  const nRet = nsess && Number.isFinite(nsess.close[m]) ? (nsess.close[m] - nsess.open) / nsess.open : 0;

  return {
    dir,
    rvol: r.profile[m] > 0 ? s.cumVol[m] / r.profile[m] : 0,
    atrUsed: range / atr,
    distVwap: ((px - vw) / atr) * dir,
    gapAtr: ((s.open - r.prev.close) / atr) * dir,
    retOpen: ((px - s.open) / atr) * dir,
    adherence: seen ? (dir === 1 ? above / seen : 1 - above / seen) : 0,
    crossings,
    posInRange: range > 0 ? (dir === 1 ? (px - s.dayLow[m]) / range : (s.dayHigh[m] - px) / range) : 0.5,
    relStrength: (((px - s.open) / s.open) - nRet) * 100 * dir,
    atrPct: (atr / px) * 100,
  };
}

const rows = [];
for (const day of FIT) {
  for (const r of U.byDay.get(day).values()) {
    if (r.medTurnoverCr < 40) continue;
    for (let m = 20; m <= 120; m += 5) {
      const f = features(r, m);
      if (!f) continue;
      const e = r.s.close[m];
      const g = grade(r.s, m, f.dir, e, e + f.dir * T * r.atr, e - f.dir * S * r.atr, Math.min(365, m + HOLD));
      rows.push({ m, ...f, out: g.out, mfe: g.mfe / r.atr, mae: g.mae / r.atr });
    }
  }
}

function line(label, sub) {
  const N = sub.length;
  if (N < 60) return `  ${label.padEnd(13)} ${String(N).padStart(6)}       —`;
  const t = sub.filter((r) => r.out === 'target').length;
  const st = sub.filter((r) => r.out === 'stop').length;
  const resolved = t + st;
  const mfe = sub.map((r) => r.mfe).sort((a, b) => a - b);
  const p60 = sub.filter((r) => r.mfe >= 0.6).length / N;
  return `  ${label.padEnd(13)} ${String(N).padStart(6)}   ${((100 * t) / N).toFixed(1).padStart(5)}  ${((100 * st) / N).toFixed(1).padStart(5)}  ${((100 * (N - resolved)) / N).toFixed(1).padStart(5)}   ${resolved ? ((100 * t) / resolved).toFixed(1).padStart(5) : '   — '}    ${mfe[Math.floor(mfe.length / 2)].toFixed(2)}   ${(100 * p60).toFixed(0).padStart(3)}%`;
}

function bucketise(name, get, edges) {
  console.log(`\n${name}`);
  console.log('  bucket             n    tgt%  stop%  time%   resolved-win%   medMFE  reach0.6');
  for (let i = 0; i < edges.length - 1; i++)
    console.log(line(`${edges[i]}–${edges[i + 1]}`, rows.filter((r) => get(r) >= edges[i] && get(r) < edges[i + 1])));
}

console.log(`${rows.length} evaluations · target +${T} ATR · stop −${S} ATR · max hold ${HOLD}m`);
console.log(line('ALL', rows).replace('ALL', 'ALL          '));

bucketise('RVOL at entry', (r) => r.rvol, [0, 0.8, 1.2, 1.8, 2.5, 4, 100]);
bucketise('Range already used (ATR)', (r) => r.atrUsed, [0, 0.3, 0.5, 0.7, 1.0, 1.4, 100]);
bucketise('Distance from VWAP (ATR)', (r) => r.distVwap, [0, 0.15, 0.35, 0.6, 100]);
bucketise('Gap (ATR, with trend)', (r) => r.gapAtr, [-100, -0.3, 0, 0.2, 0.5, 1.0, 100]);
bucketise('VWAP adherence', (r) => r.adherence, [0, 0.6, 0.75, 0.9, 0.98, 1.01]);
bucketise('VWAP crossings', (r) => r.crossings, [0, 1, 2, 4, 8, 100]);
bucketise('Position in day range', (r) => r.posInRange, [0, 0.4, 0.65, 0.85, 0.95, 1.01]);
bucketise('Rel. strength vs Nifty %', (r) => r.relStrength, [-100, -0.5, 0, 0.5, 1.2, 100]);
bucketise('Entry minute', (r) => r.m, [20, 40, 60, 80, 100, 121]);
bucketise('ATR % of price', (r) => r.atrPct, [0, 2, 2.6, 3.5, 100]);
