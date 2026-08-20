// The fidelity check that was impossible while the baseline was 62% stale.
//
// The baseline on disk is now built for 2026-08-21 with every symbol fresh, so its ATR uses daily
// bars through 2026-08-20 — exactly the series `daily-real.json` holds. If the study and production
// agree here, the thresholds in the shipped rule mean the same thing they meant in the research.

import { readFileSync } from 'node:fs';

const live = JSON.parse(readFileSync('.cache/momentum/baseline.json', 'utf8'));
const real = JSON.parse(readFileSync('research/data/daily-real.json', 'utf8')).symbols;

function wilderAtr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], c = bars[i];
    tr.push(Math.max(c[2] - c[3], Math.abs(c[2] - p[4]), Math.abs(c[3] - p[4])));
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr /= period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

console.log(`baseline day ${live.day}, builtToday ${Object.values(live.symbols).filter((s) => !s.carriedFrom).length}/${Object.keys(live.symbols).length}\n`);

const ratios = [];
const pcOk = [];
for (const [sym, b] of Object.entries(live.symbols)) {
  const bars = (real[sym] ?? []).filter((r) => r[0] < live.day);
  if (bars.length < 20 || !(b.atr > 0)) continue;
  const mine = wilderAtr(bars);
  if (!mine) continue;
  ratios.push({ sym, mine, prod: b.atr, ratio: b.atr / mine });
  const lastClose = bars[bars.length - 1][4];
  pcOk.push(Math.abs(b.prevClose - lastClose) / lastClose);
}

ratios.sort((a, b) => a.ratio - b.ratio);
const rs = ratios.map((r) => r.ratio);
const q = (p) => rs[Math.floor(rs.length * p)];
console.log(`${ratios.length} symbols compared`);
console.log('production ATR / independently computed ATR');
console.log(`  p05 ${q(0.05).toFixed(4)}  p25 ${q(0.25).toFixed(4)}  median ${q(0.5).toFixed(4)}  p75 ${q(0.75).toFixed(4)}  p95 ${q(0.95).toFixed(4)}`);
console.log(`  within 1%: ${((100 * rs.filter((v) => Math.abs(v - 1) <= 0.01).length) / rs.length).toFixed(0)}%   within 2%: ${((100 * rs.filter((v) => Math.abs(v - 1) <= 0.02).length) / rs.length).toFixed(0)}%`);
pcOk.sort((a, b) => a - b);
console.log(`\nprevious close matches the last real daily close on ${((100 * pcOk.filter((v) => v < 0.001).length) / pcOk.length).toFixed(0)}% of symbols`);
console.log(`  worst disagreement ${(100 * pcOk[pcOk.length - 1]).toFixed(3)}%`);

console.log('\nwidest remaining ATR gaps');
for (const r of ratios.slice(0, 3)) console.log(`  ${r.sym.padEnd(12)} mine ${r.mine.toFixed(2)}  production ${r.prod.toFixed(2)}  ratio ${r.ratio.toFixed(4)}`);
for (const r of ratios.slice(-3)) console.log(`  ${r.sym.padEnd(12)} mine ${r.mine.toFixed(2)}  production ${r.prod.toFixed(2)}  ratio ${r.ratio.toFixed(4)}`);
