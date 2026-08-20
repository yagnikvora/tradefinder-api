// Exploratory pass: does any single reading actually move P(target before stop)?
//
// Evaluated on a grid of entry minutes rather than on a rule, so nothing here is fitted yet —
// the question is only which readings carry information at all.

import { loadUniverse, grade } from './lab.mjs';

const U = loadUniverse();
const FIT = U.days.filter((d) => d < '2026-08-19');     // 14 sessions, everything below is fitted here
const T = 0.6, S = 0.5, LAST = 365;

const nifty = U.nifty;

function features(r, m) {
  const s = r.s;
  const px = s.close[m];
  if (!Number.isFinite(px) || px <= 0) return null;
  const atr = r.atr;
  const vw = s.vwap[m];
  const dir = px > vw ? 1 : -1;
  const range = s.dayHigh[m] - s.dayLow[m];

  let above = 0, seen = 0, crossings = 0, prevSide = 0;
  for (let k = 0; k <= m; k++) {
    if (!Number.isFinite(s.close[k])) continue;
    seen++;
    const side = s.close[k] > s.vwap[k] ? 1 : -1;
    if (side === 1) above++;
    if (prevSide !== 0 && side !== prevSide) crossings++;
    prevSide = side;
  }
  const adherence = seen ? (dir === 1 ? above / seen : 1 - above / seen) : 0;

  const nsess = nifty.sessions.get(r.day);
  const nRet = nsess && Number.isFinite(nsess.close[m]) ? (nsess.close[m] - nsess.open) / nsess.open : 0;
  const stockRet = (px - s.open) / s.open;

  return {
    dir,
    rvol: r.profile[m] > 0 ? s.cumVol[m] / r.profile[m] : 0,
    atrUsed: range / atr,
    distVwap: ((px - vw) / atr) * dir,
    gapAtr: ((s.open - r.prev.close) / atr) * dir,
    retOpen: ((px - s.open) / atr) * dir,
    retPrev: ((px - r.prev.close) / atr) * dir,
    adherence,
    crossings,
    posInRange: range > 0 ? (dir === 1 ? (px - s.dayLow[m]) / range : (s.dayHigh[m] - px) / range) : 0.5,
    orBroken: dir === 1 ? (px > s.orHigh ? 1 : 0) : (px < s.orLow ? 1 : 0),
    priorBroken: dir === 1 ? (px > r.prev.high ? 1 : 0) : (px < r.prev.low ? 1 : 0),
    relStrength: (stockRet - nRet) * 100 * dir,
    tapeWith: nRet * dir > 0.0005 ? 1 : nRet * dir < -0.0005 ? -1 : 0,
    turnoverCr: r.medTurnoverCr,
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
      const entry = r.s.close[m];
      const g = grade(r.s, m, f.dir, entry, entry + f.dir * T * r.atr, entry - f.dir * S * r.atr, LAST);
      rows.push({ day, sym: r.symbol, m, ...f, out: g.out, mfe: g.mfe / r.atr, mae: g.mae / r.atr });
    }
  }
}

const won = (g) => rows.filter((r) => g(r) && r.out === 'target').length;
const n = (g) => rows.filter(g).length;

function bucketise(name, get, edges) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const g = (r) => get(r) >= lo && get(r) < hi;
    const N = n(g);
    if (N < 60) { out.push([`${lo}–${hi}`, N, null, null]); continue; }
    const w = won(g);
    const sub = rows.filter(g);
    const mfe = sub.map((r) => r.mfe).sort((a, b) => a - b);
    out.push([`${lo}–${hi}`, N, (100 * w) / N, mfe[Math.floor(mfe.length / 2)]]);
  }
  console.log(`\n${name}`);
  console.log('  bucket        n      target%   median MFE (ATR)');
  for (const [b, N, p, mf] of out)
    console.log(`  ${b.padEnd(12)} ${String(N).padStart(6)}   ${p === null ? '   —  ' : p.toFixed(1).padStart(6)}   ${mf === null ? '  —' : mf.toFixed(2).padStart(6)}`);
}

console.log(`base: ${rows.length} evaluations, ${((100 * won(() => true)) / rows.length).toFixed(1)}% reached +${T} ATR before −${S} ATR`);
console.log(`(a driftless walk would give ${((100 * S) / (S + T)).toFixed(1)}%)`);

bucketise('RVOL at entry', (r) => r.rvol, [0, 0.8, 1.2, 1.8, 2.5, 4, 100]);
bucketise('Intraday range already used (ATR)', (r) => r.atrUsed, [0, 0.3, 0.5, 0.7, 1.0, 1.4, 100]);
bucketise('Distance from VWAP (ATR, with trend)', (r) => r.distVwap, [-2, 0, 0.15, 0.35, 0.6, 1.0, 100]);
bucketise('Opening gap (ATR, with trend)', (r) => r.gapAtr, [-100, -0.3, 0, 0.2, 0.5, 1.0, 100]);
bucketise('VWAP adherence so far', (r) => r.adherence, [0, 0.6, 0.75, 0.9, 0.98, 1.01]);
bucketise('VWAP crossings so far', (r) => r.crossings, [0, 1, 2, 4, 8, 100]);
bucketise('Position in day range', (r) => r.posInRange, [0, 0.4, 0.65, 0.85, 0.95, 1.01]);
bucketise('Relative strength vs Nifty (%, with trend)', (r) => r.relStrength, [-100, -0.5, 0, 0.5, 1.2, 100]);
bucketise('Tape alignment', (r) => r.tapeWith, [-1.5, -0.5, 0.5, 1.5]);
bucketise('Entry minute', (r) => r.m, [20, 40, 60, 80, 100, 121]);
bucketise('Prior-day range broken', (r) => r.priorBroken, [0, 0.5, 1.5]);
bucketise('Opening range broken', (r) => r.orBroken, [0, 0.5, 1.5]);
bucketise('ATR as % of price', (r) => r.atrPct, [0, 1.5, 2.0, 2.6, 3.5, 100]);
