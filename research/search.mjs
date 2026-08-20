// The search. Deliberately small: a handful of readings that carried lift in study4/7, a
// coarse threshold grid, and one signal per stock per day. Anything finer than this is fitting
// noise on 14 sessions, and the holdout check at the end is there to prove it either way.

import { U, FIT, HOLD, state } from './setups.mjs';
import { grade } from './lab.mjs';
import { bs, ivFromAtr } from './option.mjs';

const COST = 0.025, TD = 12;
function optRet(sig, g) {
  const iv = ivFromAtr(sig.atr, sig.entry);
  const isCall = sig.dir === 1;
  const e = bs(sig.entry, sig.entry, iv, TD / 252, isCall).price;
  if (!(e > 0)) return 0;
  const held = g.at - sig.m;
  const yr1 = Math.max(0, (TD - held / 375) / 252);
  const x = bs(g.exit, sig.entry, iv * (g.out === 'target' ? 0.96 : 1), yr1, isCall).price;
  return (x * (1 - COST) - e * (1 + COST)) / (e * (1 + COST));
}

/** Collect one candidate signal per stock-day for a filter, scanning a time window. */
function collect(days, F) {
  const out = [];
  for (const day of days) {
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < F.turn) continue;
      for (let m = F.from; m <= F.to; m++) {
        const s = state(r, m);
        if (!s) continue;
        const dir = s.px > s.vwap ? 1 : -1;
        if (s.rvol < F.rvol) continue;
        if (s.atrUsed < F.range) continue;
        if (((s.px - s.open) / s.atr) * dir < F.open) continue;
        if (s.crossings > F.cross) continue;
        if ((s.stockRet - s.niftyRet) * 100 * dir < F.rel) continue;
        const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
        if (off > F.maxOff) continue;
        out.push({ day, symbol: r.symbol, m, dir, entry: s.px, atr: r.atr, r, s });
        break;
      }
    }
  }
  return out;
}

function evaluate(sigs, days, T, S, hold) {
  const n = sigs.length;
  if (!n) return null;
  let t = 0, st = 0, sum = 0, w = 0;
  for (const sg of sigs) {
    const last = Math.min(365, sg.m + hold);
    const g = grade(sg.r.s, sg.m, sg.dir, sg.entry, sg.entry + sg.dir * T * sg.atr, sg.entry - sg.dir * S * sg.atr, last);
    if (g.out === 'target') t++; else if (g.out === 'stop') st++;
    const rr = optRet(sg, g);
    sum += rr;
    if (rr > 0) w++;
  }
  return { n, perDay: n / days.length, hit: t / n, stop: st / n, optWin: w / n, avg: sum / n };
}

const RVOL = [1.5, 2.5, 4, 6];
const RANGE = [0.4, 0.7, 1.0];
const OPEN = [0.3, 0.6, 0.9];
const CROSS = [2, 6, 99];
const REL = [0, 1.0, 2.0];
const MAXOFF = [0.25, 0.6, 99];
const WINDOWS = [[12, 45], [12, 75], [30, 90]];
const TS = [[0.3, 0.4], [0.4, 0.4], [0.5, 0.4], [0.5, 0.6], [0.75, 0.5], [0.75, 0.7], [1.0, 0.5], [1.0, 0.8], [1.5, 0.8]];
const HOLDS = [90, 999];

const results = [];
for (const [from, to] of WINDOWS)
  for (const rvol of RVOL)
    for (const range of RANGE)
      for (const open of OPEN)
        for (const cross of CROSS)
          for (const rel of REL)
            for (const maxOff of MAXOFF) {
              const F = { turn: 40, from, to, rvol, range, open, cross, rel, maxOff };
              const sigs = collect(FIT, F);
              if (sigs.length < 25) continue;
              if (sigs.length / FIT.length > 5.5) continue;      // the brief: under five a day
              for (const [T, S] of TS)
                for (const hold of HOLDS) {
                  const e = evaluate(sigs, FIT, T, S, hold);
                  if (e) results.push({ F, T, S, hold, ...e });
                }
            }

results.sort((a, b) => b.avg - a.avg);
console.log(`${results.length} rule/exit combinations tested, all at 5.5 signals a day or fewer\n`);
console.log('top 15 by average option return on the 14 fit sessions');
console.log('  win    rvol range open cross rel  maxOff  tgt/stop  hold    n   /day   tgt%  optWin%   avgOpt');
for (const r of results.slice(0, 15)) {
  const f = r.F;
  console.log(
    `  ${String(f.from) + '-' + String(f.to)}  ${String(f.rvol).padStart(4)} ${String(f.range).padStart(4)} ${String(f.open).padStart(4)} ${String(f.cross).padStart(5)} ${String(f.rel).padStart(3)} ${String(f.maxOff).padStart(6)}  ` +
    `${r.T}/${r.S}  ${String(r.hold === 999 ? 'close' : r.hold).padStart(5)}  ${String(r.n).padStart(3)}  ${r.perDay.toFixed(1).padStart(4)}   ${(100 * r.hit).toFixed(0).padStart(3)}%   ${(100 * r.optWin).toFixed(0).padStart(4)}%   ${((100 * r.avg >= 0 ? '+' : '') + (100 * r.avg).toFixed(1)).padStart(6)}%`,
  );
}

console.log('\nhow many combinations were positive at all:',
  results.filter((r) => r.avg > 0).length, 'of', results.length);
