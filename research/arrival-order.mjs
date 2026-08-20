// A live scan cannot know the morning's top four by relative volume in advance — it fires in
// the order conditions are met. The research ranked each day and took the top four, so this
// checks whether that difference matters before the rule is wired into the engine.

import { U, state } from './setups.mjs';
import { RULE } from './final.mjs';
import { bs, ivFromAtr } from './option.mjs';

const TD = 12, COST = 0.025;
const step = (p) => (p < 100 ? 2.5 : p < 250 ? 5 : p < 500 ? 10 : p < 1000 ? 20 : p < 2500 ? 50 : 100);

function qualifying(day) {
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
      found.push({ day, symbol: r.symbol, firedAt: m, m: m + 1, dir, entry, atr: r.atr, r,
        rvol: s.rvol, strike: Math.round(entry / step(entry)) * step(entry) });
      break;
    }
  }
  return found;
}

function trade(sg) {
  const iv = ivFromAtr(sg.atr, sg.entry);
  const paid = bs(sg.entry, sg.strike, iv, TD / 252, sg.dir === 1).price * (1 + COST);
  let half = null, realised = 0, stop = 0.5;
  for (let k = sg.m + 1; k <= 365; k++) {
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
  const yr = Math.max(0, (TD - (365 - sg.m) / 375) / 252);
  const c = (bs(sg.r.s.close[365], sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid;
  return realised + (half === null ? 1 : 0.5) * c;
}

const CAP = 4;
let overCap = 0, sameSet = 0, days = 0;
const byRank = [], byArrival = [], uncapped = [];
for (const d of U.days) {
  const q = qualifying(d);
  if (!q.length) continue;
  days++;
  if (q.length > CAP) overCap++;
  const rank = [...q].sort((a, b) => b.rvol - a.rvol).slice(0, CAP);
  // Arrival order: earliest firing minute first, ties broken by relative volume, which is what
  // a 15-second scan would produce.
  const arrive = [...q].sort((a, b) => a.firedAt - b.firedAt || b.rvol - a.rvol).slice(0, CAP);
  if (rank.map((x) => x.symbol).sort().join() === arrive.map((x) => x.symbol).sort().join()) sameSet++;
  byRank.push(...rank.map(trade));
  byArrival.push(...arrive.map(trade));
  uncapped.push(...q.map(trade));
}

const f = (arr, label) => {
  const n = arr.length;
  const tot = arr.reduce((a, b) => a + b, 0);
  console.log(`  ${label.padEnd(28)} n=${String(n).padStart(3)}  profitable ${((100 * arr.filter((r) => r > 0).length) / n).toFixed(0).padStart(3)}%  avg ${((100 * tot / n >= 0 ? '+' : '') + (100 * tot / n).toFixed(1)).padStart(6)}%  total ${((100 * tot >= 0 ? '+' : '') + (100 * tot).toFixed(0)).padStart(5)}%`);
};

console.log(`${days} sessions produced at least one qualifying name`);
console.log(`${overCap} of them had more than ${CAP} qualify, so the cap actually bound on ${((100 * overCap) / days).toFixed(0)}% of days`);
console.log(`the two selections picked the identical set on ${sameSet} of ${days} sessions (${((100 * sameSet) / days).toFixed(0)}%)\n`);
f(byRank, 'top 4 by RVOL (research)');
f(byArrival, 'first 4 to fire (live)');
f(uncapped, 'no cap at all');

// How many fire per day, and when, so the production cap and window can be sized honestly.
const counts = {}, mins = [];
for (const d of U.days) {
  const q = qualifying(d);
  counts[Math.min(q.length, 8)] = (counts[Math.min(q.length, 8)] || 0) + 1;
  for (const x of q) mins.push(x.firedAt);
}
console.log('\nqualifying names per session (before any cap)');
for (const k of Object.keys(counts).sort((a, b) => a - b)) console.log(`  ${k}${k === '8' ? '+' : ''}: ${counts[k]} sessions`);
mins.sort((a, b) => a - b);
const cl = (m) => { const t = 555 + m; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
console.log(`\nfiring minute: earliest ${cl(mins[0])}, median ${cl(mins[Math.floor(mins.length / 2)])}, latest ${cl(mins[mins.length - 1])}`);
console.log(`  share firing at 09:27 (the first minute the rule can be measured): ${((100 * mins.filter((m) => m === 12).length) / mins.length).toFixed(0)}%`);
