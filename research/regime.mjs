// On the losing sessions every signal failed together, which is what a market-wide reversal
// looks like. Two candidate guards, tested on all 35 sessions.

import { U, state } from './setups.mjs';
import { scaleExit, RULE } from './final.mjs';

const ALL = U.days;
const nif = U.nifty;

function scanWith(days, guard, rvolCap = Infinity) {
  const out = [];
  for (const day of days) {
    const found = [];
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < RULE.turn) continue;
      for (let m = RULE.from; m <= RULE.to; m++) {
        const s = state(r, m);
        if (!s) continue;
        const dir = s.px > s.vwap ? 1 : -1;
        if (s.rvol < RULE.rvol || s.rvol > rvolCap || s.atrUsed < RULE.range) continue;
        if (((s.px - s.open) / s.atr) * dir < RULE.open) continue;
        const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
        if (off > RULE.maxOff) continue;
        if (guard && !guard(day, m, dir)) continue;
        const entry = r.s.close[m + 1];
        if (!Number.isFinite(entry) || entry <= 0) break;
        found.push({ day, symbol: r.symbol, signalMin: m, m: m + 1, dir, entry, atr: r.atr, r, s, rvol: s.rvol });
        break;
      }
    }
    found.sort((a, b) => b.rvol - a.rvol);
    out.push(...found.slice(0, RULE.maxPerDay));
  }
  return out;
}

function show(label, sigs, days) {
  const res = sigs.map((s) => scaleExit(s)).filter(Boolean);
  const n = res.length;
  if (!n) { console.log(`  ${label.padEnd(42)} none`); return; }
  const avg = res.reduce((a, r) => a + r.ret, 0) / n;
  const sd = Math.sqrt(res.reduce((a, r) => a + (r.ret - avg) ** 2, 0) / Math.max(1, n - 1));
  const prof = res.filter((r) => r.ret > 0).length / n;
  const th = res.filter((r) => r.tookHalf).length / n;
  console.log(`  ${label.padEnd(42)} ${String(n).padStart(3)}  ${(n / days.length).toFixed(1)}/d  first target ${(100 * th).toFixed(0).padStart(3)}%  profitable ${(100 * prof).toFixed(0).padStart(3)}%  avg ${((100 * avg >= 0 ? '+' : '') + (100 * avg).toFixed(1)).padStart(6)}%  t ${(avg / (sd / Math.sqrt(n))).toFixed(2).padStart(5)}`);
}

// Nifty's own displacement at the decision minute, in % from its open.
const nifRet = (day, m) => {
  const s = nif.sessions.get(day);
  if (!s || !Number.isFinite(s.close[m])) return 0;
  return (s.close[m] - s.open) / s.open;
};
// How settled the index is: range so far as a fraction of its own 14-day ATR proxy.
const nifRange = (day, m) => {
  const s = nif.sessions.get(day);
  if (!s || !Number.isFinite(s.dayHigh[m])) return 0;
  return (s.dayHigh[m] - s.dayLow[m]) / s.open * 100;
};

console.log('all 35 sessions, scale-out exit\n');
show('as specified (no guard)', scanWith(ALL, null), ALL);
show('RVOL capped at 50x (drop data artefacts)', scanWith(ALL, null, 50), ALL);
show('trade must agree with Nifty', scanWith(ALL, (d, m, dir) => nifRet(d, m) * dir > 0), ALL);
show('trade must NOT fight Nifty by >0.15%', scanWith(ALL, (d, m, dir) => nifRet(d, m) * dir > -0.0015), ALL);
show('only when Nifty itself is quiet (<0.5%)', scanWith(ALL, (d, m) => nifRange(d, m) < 0.5), ALL);
show('only when Nifty is moving (>0.3%)', scanWith(ALL, (d, m) => nifRange(d, m) > 0.3), ALL);
show('cap 50x + not fighting Nifty', scanWith(ALL, (d, m, dir) => nifRet(d, m) * dir > -0.0015, 50), ALL);

console.log('\nsame guards, split by period (early 19 sessions / late 16)');
const E = ALL.filter((d) => d < '2026-07-30'), L = ALL.filter((d) => d >= '2026-07-30');
for (const [label, guard, cap] of [
  ['no guard', null, Infinity],
  ['cap 50x', null, 50],
  ['not fighting Nifty', (d, m, dir) => nifRet(d, m) * dir > -0.0015, Infinity],
  ['cap 50x + not fighting Nifty', (d, m, dir) => nifRet(d, m) * dir > -0.0015, 50],
]) {
  console.log(`  ${label}`);
  show('    early', scanWith(E, guard, cap), E);
  show('    late', scanWith(L, guard, cap), L);
}
