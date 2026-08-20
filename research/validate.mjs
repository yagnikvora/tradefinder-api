// The honest test.
//
// The rule was CHOSEN on 2026-07-30..2026-08-18. Everything before 2026-07-30 was fetched
// afterwards and the rule has never seen it, so that window is a genuine out-of-sample test
// rather than another slice of the data the search ran on.

import { U, state } from './setups.mjs';
import { collect, optionExit, stat } from './refine.mjs';

const ALL = U.days;
const OOS = ALL.filter((d) => d < '2026-07-30');            // 19 sessions, never searched
const INS = ALL.filter((d) => d >= '2026-07-30' && d < '2026-08-19');
const HOLDOUT = ALL.filter((d) => d >= '2026-08-19');

const RULE = { turn: 150, from: 12, to: 45, rvol: 6, range: 1.0, open: 0.6, maxOff: 0.25, maxPerDay: 4 };
const TP = 0.25, SL = 0.30;

function block(label, days) {
  const sigs = collect(days, RULE);
  const res = sigs.map((s) => optionExit(s, TP, SL)).filter(Boolean);
  const t = stat(res);
  const daysWith = new Set(sigs.map((s) => s.day)).size;
  console.log(
    `  ${label.padEnd(26)} ${String(days.length).padStart(2)} sessions   ${String(t.n).padStart(3)} signals (${(t.n / days.length).toFixed(1)}/day, on ${daysWith} days)   ` +
    `hit ${(100 * t.hit).toFixed(0).padStart(3)}%  stopped ${(100 * t.stop).toFixed(0).padStart(3)}%  profitable ${(100 * t.win).toFixed(0).padStart(3)}%   avg ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`,
  );
  return { sigs, res, t };
}

console.log(`RULE  09:27-10:00 · turnover >= ${RULE.turn}cr · RVOL >= ${RULE.rvol} · range >= ${RULE.range} ATR · move from open >= ${RULE.open} ATR · within ${RULE.maxOff} ATR of the extreme · max ${RULE.maxPerDay}/day`);
console.log(`EXIT  option +${100 * TP}% / −${100 * SL}%, else 15:15\n`);

const oos = block('OUT OF SAMPLE (never fitted)', OOS);
const ins = block('in sample (searched on)', INS);
const hold = block('HOLDOUT 19-20 Aug', HOLDOUT);
block('everything', ALL);

console.log('\nout-of-sample, session by session');
console.log('   day           n   profitable   session total');
for (const d of OOS) {
  const sub = oos.sigs.map((s, i) => ({ s, r: oos.res[i] })).filter((x) => x.s.day === d);
  if (!sub.length) { console.log(`   ${d}    —`); continue; }
  const t = stat(sub.map((x) => x.r));
  console.log(`   ${d}   ${String(t.n).padStart(2)}      ${(100 * t.win).toFixed(0).padStart(3)}%       ${((100 * t.tot >= 0 ? '+' : '') + (100 * t.tot).toFixed(0)).padStart(5)}%`);
}
const oosDays = OOS.map((d) => {
  const sub = oos.sigs.map((s, i) => ({ s, r: oos.res[i] })).filter((x) => x.s.day === d);
  return sub.length ? stat(sub.map((x) => x.r)).tot : null;
}).filter((v) => v !== null);
console.log(`   ${oosDays.filter((v) => v > 0).length} of ${oosDays.length} sessions with a signal were net profitable`);

// Sensitivity of the headline number to each filter, out of sample only.
console.log('\nout-of-sample sensitivity: drop one condition at a time');
console.log('   variant                        n   /day   profitable   avg');
const variants = [
  ['as specified', RULE],
  ['no turnover floor (40cr)', { ...RULE, turn: 40 }],
  ['RVOL 4 instead of 6', { ...RULE, rvol: 4 }],
  ['RVOL 8 instead of 6', { ...RULE, rvol: 8 }],
  ['range 0.7 instead of 1.0', { ...RULE, range: 0.7 }],
  ['no "near the extreme" test', { ...RULE, maxOff: 99 }],
  ['window to 10:30 not 10:00', { ...RULE, to: 75 }],
  ['window to 11:00', { ...RULE, to: 105 }],
  ['no daily cap', { ...RULE, maxPerDay: 99 }],
];
for (const [label, F] of variants) {
  const s = collect(OOS, F);
  const t = stat(s.map((x) => optionExit(x, TP, SL)).filter(Boolean));
  console.log(`   ${label.padEnd(30)} ${String(t.n).padStart(3)}  ${(t.n / OOS.length).toFixed(1).padStart(4)}      ${(100 * t.win).toFixed(0).padStart(3)}%    ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`);
}

console.log('\nout-of-sample exit grid (entry rule fixed)');
console.log('   TP / SL      hit%  stopped%  profitable%    avg');
const oosSigs = collect(OOS, RULE);
for (const [tp, sl] of [[0.20, 0.30], [0.25, 0.30], [0.30, 0.30], [0.35, 0.35], [0.40, 0.35], [0.50, 0.40], [0.80, 0.50]]) {
  const t = stat(oosSigs.map((x) => optionExit(x, tp, sl)).filter(Boolean));
  console.log(`   +${(100 * tp).toFixed(0).padStart(3)}% / −${(100 * sl).toFixed(0).padStart(2)}%   ${(100 * t.hit).toFixed(0).padStart(4)}%    ${(100 * t.stop).toFixed(0).padStart(4)}%       ${(100 * t.win).toFixed(0).padStart(4)}%   ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`);
}
