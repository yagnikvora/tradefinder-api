// Interrogate the rule the search picked. Three questions, in order of how likely each is to
// kill it: is it one lucky day, is it a lone spike in parameter space, and does it survive
// being fitted on one half of the sample and tested on the other.

import { U, FIT, HOLD, state } from './setups.mjs';
import { grade } from './lab.mjs';
import { bs, ivFromAtr } from './option.mjs';

const COST = 0.025, TD = 12;
function optRet(sig, g) {
  const iv = ivFromAtr(sig.atr, sig.entry);
  const isCall = sig.dir === 1;
  const e = bs(sig.entry, sig.entry, iv, TD / 252, isCall).price;
  if (!(e > 0)) return 0;
  const yr1 = Math.max(0, (TD - (g.at - sig.m) / 375) / 252);
  const x = bs(g.exit, sig.entry, iv * (g.out === 'target' ? 0.96 : 1), yr1, isCall).price;
  return (x * (1 - COST) - e * (1 + COST)) / (e * (1 + COST));
}

export const RULE = { turn: 40, from: 12, to: 45, rvol: 6, range: 1.0, open: 0.6, cross: 99, rel: 0, maxOff: 0.25 };
export const EXIT = { T: 1.5, S: 0.8, hold: 999 };

export function collect(days, F) {
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

export function graded(sigs, E) {
  return sigs.map((sg) => {
    const last = Math.min(365, sg.m + E.hold);
    const g = grade(sg.r.s, sg.m, sg.dir, sg.entry, sg.entry + sg.dir * E.T * sg.atr, sg.entry - sg.dir * E.S * sg.atr, last);
    return { ...sg, g, ret: optRet(sg, g) };
  });
}

const stat = (rows) => {
  const n = rows.length;
  const sum = rows.reduce((a, r) => a + r.ret, 0);
  const w = rows.filter((r) => r.ret > 0).length;
  return { n, avg: n ? sum / n : 0, win: n ? w / n : 0, tot: sum };
};

if (process.argv[1].endsWith('analyse.mjs')) {
  const rows = graded(collect(FIT, RULE), EXIT);
  const s = stat(rows);
  console.log(`RULE: window ${RULE.from}-${RULE.to} (09:27-10:00), RVOL>=${RULE.rvol}, range>=${RULE.range} ATR, move from open>=${RULE.open} ATR, within ${RULE.maxOff} ATR of the extreme`);
  console.log(`EXIT: target ${EXIT.T} ATR, stop ${EXIT.S} ATR, else the close\n`);
  console.log(`fit: ${s.n} signals over ${FIT.length} sessions (${(s.n / FIT.length).toFixed(1)}/day), avg option ${(100 * s.avg).toFixed(1)}%, profitable ${(100 * s.win).toFixed(0)}%\n`);

  console.log('1. DAY BY DAY  — is it one lucky session?');
  console.log('   day          n   profitable   total option %   biggest single');
  let cum = 0;
  for (const d of FIT) {
    const sub = rows.filter((r) => r.day === d);
    const t = stat(sub);
    cum += t.tot;
    const best = sub.length ? sub.reduce((a, b) => (b.ret > a.ret ? b : a)) : null;
    console.log(`   ${d}  ${String(t.n).padStart(2)}      ${t.n ? (100 * t.win).toFixed(0).padStart(3) + '%' : '  — '}     ${((100 * t.tot >= 0 ? '+' : '') + (100 * t.tot).toFixed(0)).padStart(6)}%        ${best ? best.symbol + ' ' + ((100 * best.ret >= 0 ? '+' : '') + (100 * best.ret).toFixed(0)) + '%' : ''}`);
  }
  console.log(`   ${FIT.filter((d) => rows.some((r) => r.day === d)).length} of ${FIT.length} sessions produced a signal; cumulative ${(100 * cum).toFixed(0)}% summed across ${s.n} single-lot trades`);

  const byDay = FIT.map((d) => stat(rows.filter((r) => r.day === d)).tot).filter((v, i) => rows.some((r) => r.day === FIT[i]));
  const pos = byDay.filter((v) => v > 0).length;
  console.log(`   profitable sessions: ${pos} of ${byDay.length}`);
  const sorted = [...rows].sort((a, b) => b.ret - a.ret);
  console.log(`   top 3 trades contribute ${(100 * sorted.slice(0, 3).reduce((a, r) => a + r.ret, 0)).toFixed(0)}% of the ${(100 * cum).toFixed(0)}% total`);
  console.log(`   without them the rule totals ${(100 * (cum - sorted.slice(0, 3).reduce((a, r) => a + r.ret, 0))).toFixed(0)}% over ${s.n - 3} trades = ${(100 * (cum - sorted.slice(0, 3).reduce((a, r) => a + r.ret, 0)) / (s.n - 3)).toFixed(1)}% each`);

  console.log('\n2. PARAMETER NEIGHBOURHOOD — a lone spike, or a plateau?');
  console.log('   rvol  range   open   maxOff  T/S        n   /day  profitable   avgOpt');
  for (const rvol of [4, 5, 6, 7, 8])
    for (const range of [0.8, 1.0, 1.2]) {
      const F = { ...RULE, rvol, range };
      const t = stat(graded(collect(FIT, F), EXIT));
      if (t.n < 15) continue;
      console.log(`   ${String(rvol).padStart(4)}  ${String(range).padStart(5)}   ${String(RULE.open).padStart(4)}   ${String(RULE.maxOff).padStart(6)}  ${EXIT.T}/${EXIT.S}  ${String(t.n).padStart(4)}  ${(t.n / FIT.length).toFixed(1).padStart(4)}   ${(100 * t.win).toFixed(0).padStart(6)}%    ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`);
    }
  console.log();
  for (const [T, S] of [[1.0, 0.6], [1.0, 0.8], [1.25, 0.8], [1.5, 0.8], [1.5, 1.0], [2.0, 0.8], [99, 0.8]]) {
    const t = stat(graded(collect(FIT, RULE), { T, S, hold: 999 }));
    console.log(`   target ${String(T === 99 ? 'none' : T).padStart(4)}  stop ${S}   n ${t.n}  profitable ${(100 * t.win).toFixed(0)}%   avgOpt ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1))}%`);
  }

  console.log('\n3. SPLIT-SAMPLE — first half vs second half');
  const half = Math.floor(FIT.length / 2);
  for (const [label, days] of [['first 7 sessions', FIT.slice(0, half)], ['last 7 sessions', FIT.slice(half)]]) {
    const t = stat(graded(collect(days, RULE), EXIT));
    console.log(`   ${label.padEnd(18)} n ${String(t.n).padStart(3)}  profitable ${(100 * t.win).toFixed(0).padStart(3)}%  avgOpt ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`);
  }
}
