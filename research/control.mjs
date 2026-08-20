// The control nobody runs, and the reason every result above looks the way it does.
//
// If simply BUYING an intraday option loses X% on average, then a signal is only worth having
// when it beats X, not when it beats zero. This measures X.

import { U, state } from './setups.mjs';
import { optionExit, stat } from './refine.mjs';
import { score } from './rank.mjs';

const ALL = U.days;

function sample(days, { at, dirRule, filter, k = null, sortBy = null }) {
  const out = [];
  for (const day of days) {
    const cands = [];
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < 100) continue;
      const s = state(r, at);
      if (!s) continue;
      if (filter && !filter(s)) continue;
      const dir = dirRule(s);
      if (!dir) continue;
      const entry = r.s.close[at + 1];
      if (!Number.isFinite(entry) || entry <= 0) continue;
      cands.push({ day, symbol: r.symbol, m: at + 1, signalMin: at, dir, entry, atr: r.atr, r, s });
    }
    if (k) { cands.sort((a, b) => sortBy(b) - sortBy(a)); out.push(...cands.slice(0, k)); }
    else out.push(...cands);
  }
  return out;
}

function show(label, sigs, tp, sl, lastMin = 365) {
  const res = sigs.map((s) => optionExit(s, tp, sl, 0.025, lastMin)).filter(Boolean);
  const t = stat(res);
  if (!t.n) { console.log(`  ${label.padEnd(44)} —`); return; }
  const rets = res.map((r) => r.ret);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - t.avg) ** 2, 0) / Math.max(1, rets.length - 1));
  const tstat = t.avg / (sd / Math.sqrt(rets.length));
  console.log(
    `  ${label.padEnd(44)} ${String(t.n).padStart(5)}  hit ${(100 * t.hit).toFixed(0).padStart(3)}%  stop ${(100 * t.stop).toFixed(0).padStart(3)}%  profitable ${(100 * t.win).toFixed(0).padStart(3)}%  avg ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%  t ${tstat.toFixed(2).padStart(6)}`,
  );
  return t;
}

const AT = 30;
console.log(`All 35 sessions · decide 09:45 · exit +50% / −40% on the option, else 15:15\n`);
console.log('THE CONTROL — no selection at all');
show('every liquid name, VWAP side', sample(ALL, { at: AT, dirRule: (s) => (s.px > s.vwap ? 1 : -1) }), 0.5, 0.4);
show('every liquid name, always a CALL', sample(ALL, { at: AT, dirRule: () => 1 }), 0.5, 0.4);
show('every liquid name, always a PUT', sample(ALL, { at: AT, dirRule: () => -1 }), 0.5, 0.4);

console.log('\nMOMENTUM — the strongest movers');
show('top 3 by score', sample(ALL, { at: AT, dirRule: (s) => (s.px > s.vwap ? 1 : -1), k: 3, sortBy: (c) => score(c.s, c.dir) }), 0.5, 0.4);
show('top 10 by score', sample(ALL, { at: AT, dirRule: (s) => (s.px > s.vwap ? 1 : -1), k: 10, sortBy: (c) => score(c.s, c.dir) }), 0.5, 0.4);

console.log('\nTHE OTHER SIDE — fade the stretch instead');
show('top 3 by score, traded the OTHER way', sample(ALL, { at: AT, dirRule: (s) => (s.px > s.vwap ? -1 : 1), k: 3, sortBy: (c) => score(c.s, -c.dir) }), 0.5, 0.4);
show('fade anything 0.5+ ATR from VWAP', sample(ALL, {
  at: AT, dirRule: (s) => (Math.abs(s.px - s.vwap) / s.atr >= 0.5 ? (s.px > s.vwap ? -1 : 1) : 0),
}), 0.5, 0.4);

console.log('\nHOLDING TIME — the same control, exited earlier');
for (const last of [90, 150, 240, 365]) {
  show(`control, VWAP side, out by minute ${last}`, sample(ALL, { at: AT, dirRule: (s) => (s.px > s.vwap ? 1 : -1) }), 0.5, 0.4, last);
}

console.log('\nWHAT THE DRAG IS MADE OF (a name that does not move at all)');
console.log('  an ATM option, stock unchanged, 12 sessions to expiry:');
for (const mins of [30, 60, 120, 240, 335]) {
  const fake = { entry: 400, atr: 8.8, dir: 1, m: 30, r: { s: { close: new Float64Array(400).fill(400), high: new Float64Array(400).fill(400), low: new Float64Array(400).fill(400) } } };
  const res = optionExit(fake, 9, 9, 0.025, 30 + mins);
  console.log(`    held ${String(mins).padStart(3)} minutes -> ${(100 * res.ret).toFixed(1)}%`);
}
