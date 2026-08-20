// The obvious response to "11 of 20 trades just bled decay" is to exit earlier. Testing it on
// all 35 sessions rather than on the one bad week, because the week alone cannot answer it.

import { U, state } from './setups.mjs';
import { RULE } from './final.mjs';
import { bs, ivFromAtr } from './option.mjs';

const TD = 12, COST = 0.025;
const step = (p) => (p < 100 ? 2.5 : p < 250 ? 5 : p < 500 ? 10 : p < 1000 ? 20 : p < 2500 ? 50 : 100);
const WEEK = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];

function scanDay(day) {
  const found = [];
  for (const r of U.byDay.get(day).values()) {
    if (r.medTurnoverCr < RULE.turn) continue;
    for (let m = RULE.from; m <= RULE.to; m++) {
      const s = state(r, m);
      if (!s) continue;
      const dir = s.px > s.vwap ? 1 : -1;
      if (s.rvol < RULE.rvol || s.rvol > 50 || s.atrUsed < RULE.range) continue;
      if (((s.px - s.open) / s.atr) * dir < RULE.open) continue;
      const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
      if (off > RULE.maxOff) continue;
      const entry = r.s.close[m + 1];
      if (!Number.isFinite(entry) || entry <= 0) break;
      found.push({ day, symbol: r.symbol, m: m + 1, dir, entry, atr: r.atr, r, rvol: s.rvol,
        strike: Math.round(entry / step(entry)) * step(entry) });
      break;
    }
  }
  found.sort((a, b) => b.rvol - a.rvol);
  return found.slice(0, RULE.maxPerDay);
}

function trade(sg, lastMin) {
  const iv = ivFromAtr(sg.atr, sg.entry);
  const paid = bs(sg.entry, sg.strike, iv, TD / 252, sg.dir === 1).price * (1 + COST);
  let half = null, realised = 0, stop = 0.5;
  for (let k = sg.m + 1; k <= lastMin; k++) {
    const lo = sg.dir === 1 ? sg.r.s.low[k] : sg.r.s.high[k];
    const hi = sg.dir === 1 ? sg.r.s.high[k] : sg.r.s.low[k];
    if (!Number.isFinite(lo)) continue;
    const yr = Math.max(0, (TD - (k - sg.m) / 375) / 252);
    if ((bs(lo, sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid <= -stop)
      return realised + (half === null ? 1 : 0.5) * -stop;
    const u = (bs(hi, sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid;
    if (half === null && u >= 0.3) { half = k; realised = 0.15; stop = 0; }
    else if (half !== null && u >= 0.8) return realised + 0.4;
  }
  const yr = Math.max(0, (TD - (lastMin - sg.m) / 375) / 252);
  const c = (bs(sg.r.s.close[lastMin], sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid;
  return realised + (half === null ? 1 : 0.5) * c;
}

const sigs = U.days.flatMap(scanDay);
console.log('does exiting earlier help? (same entries, same targets, only the final cut-off moves)\n');
console.log('  out by     all 35 sessions              the 10-14 Aug week');
console.log('             n   profitable    avg        n   profitable    avg');
for (const [label, last] of [['12:00', 165], ['13:00', 225], ['14:00', 285], ['15:15', 365]]) {
  const a = sigs.map((s) => trade(s, last));
  const w = sigs.filter((s) => WEEK.includes(s.day)).map((s) => trade(s, last));
  const f = (arr) => `${String(arr.length).padStart(3)}   ${((100 * arr.filter((r) => r > 0).length) / arr.length).toFixed(0).padStart(3)}%    ${((100 * arr.reduce((x, y) => x + y, 0) / arr.length >= 0 ? '+' : '') + (100 * arr.reduce((x, y) => x + y, 0) / arr.length).toFixed(1)).padStart(6)}%`;
  console.log(`  ${label}      ${f(a)}      ${f(w)}`);
}
