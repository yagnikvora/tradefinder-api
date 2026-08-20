// Three ways this could still be an illusion:
//   1. entry at the signal bar's own close is a fill nobody gets — retest with a full minute's delay
//   2. the exit is expressed in ATR, which the trader cannot see — retest with an option-level exit
//   3. the option model's cost assumption may be too kind — retest at double the spread

import { U, FIT, state } from './setups.mjs';
import { grade } from './lab.mjs';
import { bs, ivFromAtr } from './option.mjs';

const TD = 12;
const RULE = { turn: 40, from: 12, to: 45, rvol: 6, range: 1.0, open: 0.6, cross: 99, rel: 0, maxOff: 0.25 };

function collect(days, F, delay) {
  const out = [];
  for (const day of days) {
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
        const em = m + delay;
        const entry = r.s.close[em];
        if (!Number.isFinite(entry) || entry <= 0) break;
        out.push({ day, symbol: r.symbol, m: em, signalMin: m, dir, entry, atr: r.atr, r, s });
        break;
      }
    }
  }
  return out;
}

function optRet(sig, g, cost) {
  const iv = ivFromAtr(sig.atr, sig.entry);
  const isCall = sig.dir === 1;
  const e = bs(sig.entry, sig.entry, iv, TD / 252, isCall).price;
  if (!(e > 0)) return 0;
  const yr1 = Math.max(0, (TD - (g.at - sig.m) / 375) / 252);
  const x = bs(g.exit, sig.entry, iv * (g.won ? 0.96 : 1), yr1, isCall).price;
  return (x * (1 - cost) - e * (1 + cost)) / (e * (1 + cost));
}

/** Walk the path and exit on an OPTION percentage, which is what a buyer can actually see. */
function optionExit(sig, tpPct, slPct, cost) {
  const iv = ivFromAtr(sig.atr, sig.entry);
  const isCall = sig.dir === 1;
  const e0 = bs(sig.entry, sig.entry, iv, TD / 252, isCall).price;
  if (!(e0 > 0)) return null;
  const paid = e0 * (1 + cost);
  for (let k = sig.m + 1; k <= 365; k++) {
    const px = sig.r.s.close[k];
    if (!Number.isFinite(px)) continue;
    const yr = Math.max(0, (TD - (k - sig.m) / 375) / 252);
    // Adverse first inside the minute, for the same reason the ATR grader does it.
    const adverse = isCall ? sig.r.s.low[k] : sig.r.s.high[k];
    const favour = isCall ? sig.r.s.high[k] : sig.r.s.low[k];
    const vLow = bs(adverse, sig.entry, iv, yr, isCall).price * (1 - cost);
    if ((vLow - paid) / paid <= -slPct) return { ret: -slPct, at: k, out: 'stop' };
    const vHigh = bs(favour, sig.entry, iv * 0.96, yr, isCall).price * (1 - cost);
    if ((vHigh - paid) / paid >= tpPct) return { ret: tpPct, at: k, out: 'target' };
  }
  const yr = Math.max(0, (TD - (365 - sig.m) / 375) / 252);
  const v = bs(sig.r.s.close[365], sig.entry, iv, yr, isCall).price * (1 - cost);
  return { ret: (v - paid) / paid, at: 365, out: 'close' };
}

const stat = (rets) => {
  const n = rets.length;
  const sum = rets.reduce((a, b) => a + b, 0);
  const w = rets.filter((r) => r > 0).length;
  return { n, avg: n ? sum / n : 0, win: n ? w / n : 0, tot: sum };
};

console.log('1. FILL DELAY — entry moved from the signal bar to N minutes later');
console.log('   delay    n   profitable   avg option');
for (const delay of [0, 1, 2, 3, 5]) {
  const sigs = collect(FIT, RULE, delay);
  const rets = sigs.map((sg) => {
    const g = grade(sg.r.s, sg.m, sg.dir, sg.entry, sg.entry + sg.dir * 1.5 * sg.atr, sg.entry - sg.dir * 0.8 * sg.atr, 365);
    return optRet(sg, { ...g, won: g.out === 'target' }, 0.025);
  });
  const t = stat(rets);
  console.log(`   ${String(delay + 'm').padEnd(6)} ${String(t.n).padStart(4)}     ${(100 * t.win).toFixed(0).padStart(4)}%     ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`);
}

console.log('\n2. COST — the spread assumption, each way');
console.log('   cost     n   profitable   avg option');
for (const c of [0.015, 0.025, 0.04, 0.06]) {
  const sigs = collect(FIT, RULE, 1);
  const rets = sigs.map((sg) => {
    const g = grade(sg.r.s, sg.m, sg.dir, sg.entry, sg.entry + sg.dir * 1.5 * sg.atr, sg.entry - sg.dir * 0.8 * sg.atr, 365);
    return optRet(sg, { ...g, won: g.out === 'target' }, c);
  });
  const t = stat(rets);
  console.log(`   ${String((100 * c).toFixed(1) + '%').padEnd(6)} ${String(t.n).padStart(4)}     ${(100 * t.win).toFixed(0).padStart(4)}%     ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`);
}

console.log('\n3. EXIT ON THE OPTION, not on the stock (1-minute fill delay, 2.5% cost)');
console.log('   take-profit  stop-loss     n   hit-target%   stopped%   profitable%   avg option');
const sigs = collect(FIT, RULE, 1);
for (const [tp, sl] of [[0.25, 0.30], [0.30, 0.30], [0.35, 0.35], [0.40, 0.35], [0.50, 0.40], [0.60, 0.40], [0.75, 0.50]]) {
  const res = sigs.map((sg) => optionExit(sg, tp, sl, 0.025)).filter(Boolean);
  const t = stat(res.map((r) => r.ret));
  const hitP = (100 * res.filter((r) => r.out === 'target').length) / res.length;
  const stopP = (100 * res.filter((r) => r.out === 'stop').length) / res.length;
  console.log(`   +${(100 * tp).toFixed(0).padStart(3)}%       −${(100 * sl).toFixed(0).padStart(3)}%   ${String(t.n).padStart(4)}      ${hitP.toFixed(0).padStart(4)}%      ${stopP.toFixed(0).padStart(4)}%        ${(100 * t.win).toFixed(0).padStart(4)}%      ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`);
}
