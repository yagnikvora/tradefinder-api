// Final parameter map, on all 35 sessions, scored against the −7.4% control rather than zero.
// Reported with a t-statistic and split by period, so a cell that only works in one half is
// visible as such instead of being picked as the winner.

import { U, state } from './setups.mjs';
import { optionExit, stat } from './refine.mjs';

const ALL = U.days;
const EARLY = ALL.filter((d) => d < '2026-07-30');
const LATE = ALL.filter((d) => d >= '2026-07-30');
const CONTROL = -0.074;

function collect(days, F) {
  const out = [];
  for (const day of days) {
    const found = [];
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < F.turn) continue;
      for (let m = F.from; m <= F.to; m++) {
        const s = state(r, m);
        if (!s) continue;
        const dir = s.px > s.vwap ? 1 : -1;
        if (s.rvol < F.rvol || s.atrUsed < F.range) continue;
        if (((s.px - s.open) / s.atr) * dir < F.open) continue;
        const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
        if (off > F.maxOff) continue;
        const entry = r.s.close[m + 1];
        if (!Number.isFinite(entry) || entry <= 0) break;
        found.push({ day, symbol: r.symbol, signalMin: m, m: m + 1, dir, entry, atr: r.atr, r, s, rvol: s.rvol });
        break;
      }
    }
    found.sort((a, b) => b.rvol - a.rvol);
    out.push(...found.slice(0, F.maxPerDay));
  }
  return out;
}

function ev(days, F, tp, sl) {
  const res = collect(days, F).map((s) => optionExit(s, tp, sl)).filter(Boolean);
  const t = stat(res);
  if (!t.n) return null;
  const rets = res.map((r) => r.ret);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - t.avg) ** 2, 0) / Math.max(1, rets.length - 1));
  return { ...t, sd, tstat: t.avg / (sd / Math.sqrt(t.n)), alpha: t.avg - CONTROL, perDay: t.n / days.length };
}

const TP = 0.5, SL = 0.4;
console.log(`exit +${100 * TP}% / −${100 * SL}% on the option, else 15:15 · control is ${(100 * CONTROL).toFixed(1)}%\n`);
console.log('  rvol  range  window   n   /day   profitable   avg      alpha    t      early half   late half');
for (const rvol of [3, 4, 5, 6, 8])
  for (const range of [0.6, 0.8, 1.0, 1.2])
    for (const [from, to] of [[12, 45], [12, 75]]) {
      const F = { turn: 100, from, to, rvol, range, open: 0.5, maxOff: 0.35, maxPerDay: 5 };
      const a = ev(ALL, F, TP, SL);
      if (!a || a.n < 20) continue;
      const e = ev(EARLY, F, TP, SL), l = ev(LATE, F, TP, SL);
      console.log(
        `  ${String(rvol).padStart(4)}  ${String(range).padStart(5)}  ${String(from + '-' + to).padStart(6)} ${String(a.n).padStart(4)}  ${a.perDay.toFixed(1).padStart(4)}     ${(100 * a.win).toFixed(0).padStart(3)}%   ${((100 * a.avg >= 0 ? '+' : '') + (100 * a.avg).toFixed(1)).padStart(6)}%  ${('+' + (100 * a.alpha).toFixed(1)).padStart(6)}  ${a.tstat.toFixed(2).padStart(5)}   ` +
        `${e ? ((100 * e.avg >= 0 ? '+' : '') + (100 * e.avg).toFixed(1)).padStart(6) + '% n' + String(e.n).padStart(3) : '     —'}  ${l ? ((100 * l.avg >= 0 ? '+' : '') + (100 * l.avg).toFixed(1)).padStart(6) + '% n' + String(l.n).padStart(3) : '     —'}`,
      );
    }

console.log('\nexit grid on the most robust entry cell (rvol>=5, range>=1.0, 09:27-10:00)');
const BEST = { turn: 100, from: 12, to: 45, rvol: 5, range: 1.0, open: 0.5, maxOff: 0.35, maxPerDay: 5 };
console.log('   TP / SL      n   hit%  stopped%  profitable%   avg     alpha    t');
for (const [tp, sl] of [[0.25, 0.30], [0.30, 0.35], [0.40, 0.35], [0.50, 0.40], [0.60, 0.45], [0.80, 0.50], [1.00, 0.50]]) {
  const a = ev(ALL, BEST, tp, sl);
  console.log(`   +${(100 * tp).toFixed(0).padStart(3)}% / −${(100 * sl).toFixed(0).padStart(2)}%  ${String(a.n).padStart(4)}  ${(100 * a.hit).toFixed(0).padStart(4)}%     ${(100 * a.stop).toFixed(0).padStart(3)}%       ${(100 * a.win).toFixed(0).padStart(4)}%  ${((100 * a.avg >= 0 ? '+' : '') + (100 * a.avg).toFixed(1)).padStart(6)}%  ${('+' + (100 * a.alpha).toFixed(1)).padStart(6)}  ${a.tstat.toFixed(2).padStart(5)}`);
}
