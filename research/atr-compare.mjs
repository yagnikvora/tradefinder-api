// The live preview found no signal on 2026-08-20 where the study found one. The whole rule is
// ATR-scaled, so the first suspect is the ATR itself: the study spliced daily bars synthesised
// from 1-minute sessions on top of the cached daily history, while the production baseline uses
// Upstox's own daily bars throughout. This measures the gap.

import { readFileSync } from 'node:fs';
import { loadUniverse } from './lab.mjs';

const live = JSON.parse(readFileSync('.cache/momentum/baseline.json', 'utf8'));
const U = loadUniverse();
const day = '2026-08-20';

const rows = [];
for (const [sym, r] of U.byDay.get(day)) {
  const b = live.symbols?.[sym];
  if (!b || !(b.atr > 0) || !(r.atr > 0)) continue;
  rows.push({ sym, research: r.atr, production: b.atr, ratio: b.atr / r.atr,
    resPrevClose: r.prev.close, prodPrevClose: b.prevClose });
}
rows.sort((a, b) => a.ratio - b.ratio);
const ratios = rows.map((r) => r.ratio);
const pct = (p) => ratios[Math.floor(ratios.length * p)];
const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;

console.log(`${rows.length} symbols compared on ${day}\n`);
console.log('production ATR / study ATR');
console.log(`  p05 ${pct(0.05).toFixed(3)}   p25 ${pct(0.25).toFixed(3)}   median ${pct(0.5).toFixed(3)}   p75 ${pct(0.75).toFixed(3)}   p95 ${pct(0.95).toFixed(3)}`);
console.log(`  mean ${mean.toFixed(3)}`);
console.log(`  production runs HIGHER on ${ratios.filter((v) => v > 1).length} of ${ratios.length} symbols (${((100 * ratios.filter((v) => v > 1).length) / ratios.length).toFixed(0)}%)`);

const pcMismatch = rows.filter((r) => Math.abs(r.resPrevClose - r.prodPrevClose) / r.prodPrevClose > 0.001);
console.log(`\nprevious close disagrees by >0.1% on ${pcMismatch.length} symbols`);
for (const r of pcMismatch.slice(0, 5))
  console.log(`  ${r.sym.padEnd(12)} study ${r.resPrevClose.toFixed(2)}  production ${r.prodPrevClose.toFixed(2)}`);

console.log('\nthe extremes');
for (const r of rows.slice(0, 4))
  console.log(`  ${r.sym.padEnd(12)} study ${r.research.toFixed(2)}  production ${r.production.toFixed(2)}  ratio ${r.ratio.toFixed(3)}`);
for (const r of rows.slice(-4))
  console.log(`  ${r.sym.padEnd(12)} study ${r.research.toFixed(2)}  production ${r.production.toFixed(2)}  ratio ${r.ratio.toFixed(3)}`);

const m = rows.find((r) => r.sym === 'MUTHOOTFIN');
if (m) {
  console.log(`\nMUTHOOTFIN, the signal that vanished:`);
  console.log(`  study ATR ${m.research.toFixed(2)} -> range read 1.02 ATR, which cleared the 1.00 gate`);
  console.log(`  production ATR ${m.production.toFixed(2)} -> the same rupee range reads ${(1.02 * m.research / m.production).toFixed(3)} ATR, which does not`);
}
