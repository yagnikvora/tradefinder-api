// What precision is actually attainable?
//
// One row per stock per day per decision minute, with the full feature set and the graded
// outcome attached. Then: single-feature precision curves, so the ceiling is measured rather
// than assumed, followed by two-feature conjunctions.

import { U, FIT, state } from './setups.mjs';
import { grade } from './lab.mjs';

const DECISIONS = [30, 45, 60, 75];   // 09:45, 10:00, 10:15, 10:30
const T = 0.5, S = 0.4, LAST = 360;

const rows = [];
for (const day of FIT) {
  for (const r of U.byDay.get(day).values()) {
    if (r.medTurnoverCr < 40) continue;
    for (const m of DECISIONS) {
      const s = state(r, m);
      if (!s) continue;
      for (const [dirName, dir] of [['vwap', s.px > s.vwap ? 1 : -1], ['open', s.px > s.open ? 1 : -1]]) {
        const g = grade(r.s, m, dir, s.px, s.px + dir * T * r.atr, s.px - dir * S * r.atr, LAST);
        rows.push({
          day, sym: r.symbol, m, dirName, dir,
          win: g.out === 'target' ? 1 : 0, lose: g.out === 'stop' ? 1 : 0,
          mfe: g.mfe / r.atr, mae: g.mae / r.atr,
          rvol: s.rvol,
          atrUsed: s.atrUsed,
          distVwap: ((s.px - s.vwap) / s.atr) * dir,
          gap: s.gap * dir,
          crossings: s.crossings,
          oneSided: dir === 1 ? s.aboveFrac : 1 - s.aboveFrac,
          retOpen: ((s.px - s.open) / s.atr) * dir,
          retPrev: ((s.px - s.prevClose) / s.atr) * dir,
          posRange: s.range > 0 ? (dir === 1 ? (s.px - s.dayLow) / s.range : (s.dayHigh - s.px) / s.range) : 0.5,
          orBreak: dir === 1 ? (s.px > s.orHigh ? 1 : 0) : (s.px < s.orLow ? 1 : 0),
          priorBreak: dir === 1 ? (s.px > s.prevHigh ? 1 : 0) : (s.px < s.prevLow ? 1 : 0),
          rel: (s.stockRet - s.niftyRet) * 100 * dir,
          tape: s.niftyRet * 100 * dir,
          atrPct: s.atrPct,
        });
      }
    }
  }
}
console.log(`${rows.length} labelled rows · target +${T} ATR · stop −${S} ATR · held to 15:15`);

function summary(label, sub, total) {
  const n = sub.length;
  if (n < 40) return null;
  const w = sub.reduce((a, r) => a + r.win, 0);
  const l = sub.reduce((a, r) => a + r.lose, 0);
  const exp = (w * T - l * S) / n;
  const perDay = n / (FIT.length * DECISIONS.length * 2);
  return { label, n, hit: (100 * w) / n, stop: (100 * l) / n, exp, perDay, lift: (100 * w) / n - total };
}

const baseHit = (100 * rows.reduce((a, r) => a + r.win, 0)) / rows.length;
console.log(`base hit rate: ${baseHit.toFixed(1)}%\n`);

function scan(name, get, cuts, above = true) {
  console.log(`${name}`);
  for (const c of cuts) {
    const sub = rows.filter((r) => (above ? get(r) >= c : get(r) <= c));
    const s = summary(`${above ? '≥' : '≤'} ${c}`, sub, baseHit);
    if (!s) continue;
    console.log(`   ${s.label.padEnd(9)} n=${String(s.n).padStart(5)}  hit ${s.hit.toFixed(1).padStart(5)}%  stop ${s.stop.toFixed(1).padStart(5)}%  exp ${(s.exp >= 0 ? '+' : '') + s.exp.toFixed(3)}  lift ${(s.lift >= 0 ? '+' : '') + s.lift.toFixed(1)}`);
  }
  console.log();
}

scan('RVOL', (r) => r.rvol, [1, 1.5, 2, 3, 4, 6]);
scan('range used (ATR)', (r) => r.atrUsed, [0.5, 0.8, 1.0, 1.3, 1.6]);
scan('gap with trend (ATR)', (r) => r.gap, [0.2, 0.4, 0.6, 0.9]);
scan('one-sided fraction', (r) => r.oneSided, [0.8, 0.9, 0.95, 0.99]);
scan('move from open (ATR)', (r) => r.retOpen, [0.3, 0.5, 0.8, 1.1]);
scan('rel strength vs Nifty %', (r) => r.rel, [0.5, 1, 1.5, 2.5]);
scan('dist from VWAP (ATR)', (r) => r.distVwap, [0.1, 0.25, 0.4, 0.6]);
scan('VWAP crossings', (r) => r.crossings, [0, 1, 2, 4], false);
scan('ATR % of price', (r) => r.atrPct, [1.8, 2.2, 2.8], false);

// direction rule and decision minute, held constant elsewhere
for (const d of ['vwap', 'open']) {
  const sub = rows.filter((r) => r.dirName === d);
  const s = summary(d, sub, baseHit);
  console.log(`direction=${d.padEnd(5)} n=${s.n} hit ${s.hit.toFixed(1)}%  exp ${s.exp.toFixed(3)}`);
}
for (const m of DECISIONS) {
  const sub = rows.filter((r) => r.m === m);
  const s = summary(String(m), sub, baseHit);
  console.log(`minute=${String(m).padEnd(5)} n=${s.n} hit ${s.hit.toFixed(1)}%  exp ${s.exp.toFixed(3)}`);
}
