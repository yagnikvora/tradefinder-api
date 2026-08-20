// A ranking rule instead of a threshold rule.
//
// Thresholds are where a 14-session search overfits: each cut is a free parameter and the
// out-of-sample sensitivity table showed most of them carried nothing. A RANK has no cut to
// fit — "the three strongest names this morning" is the same instruction on every session —
// and it fires on every day, which is what makes the sample big enough to believe.

import { U, state } from './setups.mjs';
import { optionExit, stat } from './refine.mjs';

const ALL = U.days;
const OOS = ALL.filter((d) => d < '2026-07-30');
const HOLDOUT = ALL.filter((d) => d >= '2026-08-19');

/** Score a name on the readings that were monotone in study 4 and 7. No thresholds. */
export function score(s, dir) {
  const rv = Math.min(3, Math.log10(Math.max(1, s.rvol)) / Math.log10(8));
  const rng = Math.min(2, s.atrUsed / 1.2);
  const disp = Math.min(2, (((s.px - s.open) / s.atr) * dir) / 1.0);
  const rel = Math.min(2, ((s.stockRet - s.niftyRet) * 100 * dir) / 2.0);
  return 2.0 * rv + 1.0 * rng + 1.5 * disp + 0.8 * rel;
}

export function pick(days, { at = 30, k = 3, minTurn = 100, minDisp = 0.4, delay = 1 } = {}) {
  const out = [];
  for (const day of days) {
    const cands = [];
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < minTurn) continue;
      const s = state(r, at);
      if (!s) continue;
      const dir = s.px > s.vwap ? 1 : -1;
      const disp = ((s.px - s.open) / s.atr) * dir;
      if (disp < minDisp) continue;
      const entry = r.s.close[at + delay];
      if (!Number.isFinite(entry) || entry <= 0) continue;
      cands.push({ day, symbol: r.symbol, signalMin: at, m: at + delay, dir, entry, atr: r.atr, r, s, sc: score(s, dir), disp });
    }
    cands.sort((a, b) => b.sc - a.sc);
    out.push(...cands.slice(0, k));
  }
  return out;
}

if (process.argv[1].endsWith('rank.mjs')) {
  console.log('Top-K by score at a fixed minute, exit +50% / −40% on the option, else 15:15\n');
  console.log('  decide   K   set                n   /day   hit%  stopped%  profitable%    avg      t-stat');
  const rows = [];
  for (const at of [15, 20, 30, 45, 60]) {
    for (const k of [2, 3, 5]) {
      for (const [label, days] of [['all 35', ALL], ['unseen 19', OOS]]) {
        const sigs = pick(days, { at, k });
        const res = sigs.map((s) => optionExit(s, 0.5, 0.4)).filter(Boolean);
        const t = stat(res);
        if (!t.n) continue;
        const rets = res.map((r) => r.ret);
        const mean = t.avg;
        const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
        const tstat = (mean / (sd / Math.sqrt(rets.length)));
        const tt = 555 + at;
        const hhmm = String(Math.floor(tt / 60)).padStart(2, '0') + ':' + String(tt % 60).padStart(2, '0');
        console.log(`  ${hhmm}   ${k}   ${label.padEnd(10)} ${String(t.n).padStart(5)}   ${(t.n / days.length).toFixed(1).padStart(4)}  ${(100 * t.hit).toFixed(0).padStart(4)}%     ${(100 * t.stop).toFixed(0).padStart(3)}%       ${(100 * t.win).toFixed(0).padStart(4)}%   ${((100 * mean >= 0 ? '+' : '') + (100 * mean).toFixed(1)).padStart(6)}%    ${tstat.toFixed(2).padStart(5)}`);
        rows.push({ at, k, label, t, tstat });
      }
    }
    console.log();
  }
}
