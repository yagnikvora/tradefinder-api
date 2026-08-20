// Reverse the question. Instead of guessing filters, take the days that DID deliver a large
// favourable move and ask what they looked like at the decision minute.

import { U, FIT, state } from './setups.mjs';
import { grade } from './lab.mjs';

const M = 45;              // 10:00
const rows = [];
for (const day of FIT) {
  for (const r of U.byDay.get(day).values()) {
    if (r.medTurnoverCr < 40) continue;
    const s = state(r, M);
    if (!s) continue;
    const dir = s.px > s.vwap ? 1 : -1;
    const g = grade(r.s, M, dir, s.px, s.px + dir * 99 * r.atr, s.px - dir * 99 * r.atr, 360);
    rows.push({
      day, sym: r.symbol, dir,
      mfe: g.mfe / r.atr, mae: g.mae / r.atr,
      fwd: (dir * (r.s.close[360] - s.px)) / r.atr,
      rvol: s.rvol, atrUsed: s.atrUsed,
      gap: s.gap * dir,
      retOpen: ((s.px - s.open) / s.atr) * dir,
      distVwap: ((s.px - s.vwap) / s.atr) * dir,
      oneSided: dir === 1 ? s.aboveFrac : 1 - s.aboveFrac,
      crossings: s.crossings,
      posRange: s.range > 0 ? (dir === 1 ? (s.px - s.dayLow) / s.range : (s.dayHigh - s.px) / s.range) : 0.5,
      rel: (s.stockRet - s.niftyRet) * 100 * dir,
      atrPct: s.atrPct,
      turnover: r.medTurnoverCr,
    });
  }
}

const BIG = 1.0;
const big = rows.filter((r) => r.mfe >= BIG);
console.log(`${rows.length} stock-days at 10:00 over ${FIT.length} sessions`);
console.log(`${big.length} of them (${((100 * big.length) / rows.length).toFixed(1)}%) went on to travel +${BIG} ATR in favour before the close`);
console.log(`  = ${(big.length / FIT.length).toFixed(1)} a day out of ${(rows.length / FIT.length).toFixed(0)} tradable names\n`);

const keys = ['rvol', 'atrUsed', 'gap', 'retOpen', 'distVwap', 'oneSided', 'crossings', 'posRange', 'rel', 'atrPct', 'turnover'];
const med = (a, k) => { const v = a.map((x) => x[k]).sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
console.log('feature          median (big movers)   median (rest)   ratio');
const rest = rows.filter((r) => r.mfe < BIG);
for (const k of keys) {
  const a = med(big, k), b = med(rest, k);
  console.log(`  ${k.padEnd(14)} ${a.toFixed(2).padStart(10)}        ${b.toFixed(2).padStart(10)}     ${(b !== 0 ? (a / b).toFixed(2) : '—').padStart(6)}`);
}

// Precision of single thresholds for "will travel +1 ATR"
console.log('\nprecision of a single cut for "reaches +1.0 ATR in favour"');
console.log('  filter                       n     precision   signals/day   lift');
const base = big.length / rows.length;
function prec(label, f) {
  const sub = rows.filter(f);
  if (sub.length < 20) return;
  const p = sub.filter((r) => r.mfe >= BIG).length / sub.length;
  console.log(`  ${label.padEnd(28)} ${String(sub.length).padStart(4)}     ${(100 * p).toFixed(1).padStart(5)}%      ${(sub.length / FIT.length).toFixed(1).padStart(5)}      ${(p / base).toFixed(2)}x`);
}
prec('everything', () => true);
for (const v of [2, 3, 4, 6, 8]) prec(`rvol >= ${v}`, (r) => r.rvol >= v);
for (const v of [0.8, 1.0, 1.3, 1.6]) prec(`range used >= ${v}`, (r) => r.atrUsed >= v);
for (const v of [0.5, 0.8, 1.1, 1.5]) prec(`move from open >= ${v}`, (r) => r.retOpen >= v);
for (const v of [0.4, 0.7, 1.0]) prec(`gap >= ${v}`, (r) => r.gap >= v);
for (const v of [1.5, 2.5, 4]) prec(`rel strength >= ${v}%`, (r) => r.rel >= v);
prec('rvol>=3 & open>=0.8', (r) => r.rvol >= 3 && r.retOpen >= 0.8);
prec('rvol>=3 & open>=0.8 & gap>=0.3', (r) => r.rvol >= 3 && r.retOpen >= 0.8 && r.gap >= 0.3);
prec('rvol>=4 & range>=1.0', (r) => r.rvol >= 4 && r.atrUsed >= 1.0);
prec('rvol>=4 & range>=1.0 & rel>=2', (r) => r.rvol >= 4 && r.atrUsed >= 1.0 && r.rel >= 2);
prec('rvol>=3 & open>=1.0 & cross<=2', (r) => r.rvol >= 3 && r.retOpen >= 1.0 && r.crossings <= 2);
