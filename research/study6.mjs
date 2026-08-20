// Where the option money actually goes: decay from holding, and the strike chosen.
import { U, FIT, run } from './setups.mjs';
import { grade } from './lab.mjs';
import { bs, ivFromAtr } from './option.mjs';

const COST = 0.025, TD = 12;

// Same trade, but the contract is a strike `otmPct` out of the money.
function optRet(sig, g, otmPct) {
  const iv = ivFromAtr(sig.atr, sig.entry);
  const strike = sig.entry * (1 + sig.dir * otmPct / 100);
  const isCall = sig.dir === 1;
  const e = bs(sig.entry, strike, iv, TD / 252, isCall).price;
  if (!(e > 0.01 * sig.entry * 0.02)) return null;
  const held = g.at - sig.m;
  const yr1 = Math.max(0, (TD - held / 375) / 252);
  const ivx = g.out === 'target' ? iv * 0.96 : iv;
  const x = bs(g.exit, strike, ivx, yr1, isCall).price;
  return (x * (1 - COST) - e * (1 + COST)) / (e * (1 + COST));
}

const bigDay = (s) => s.rvol >= 2.0 && s.atrUsed >= 0.7;
const breakEntry = (s) => {
  if (s.m < 25) return null;
  if (!bigDay(s)) return null;
  const dir = s.px > s.vwap ? 1 : -1;
  if (((s.px - s.open) / s.atr) * dir < 0.5) return null;
  const atExtreme = dir === 1 ? s.px >= s.dayHigh - 1e-9 : s.px <= s.dayLow + 1e-9;
  return atExtreme ? { dir } : null;
};

const sigs = run(breakEntry, FIT);
console.log(`${sigs.length} signals (${(sigs.length / FIT.length).toFixed(1)}/day)\n`);

const T = 0.5, S = 0.4;
console.log('effect of the HOLD LIMIT (ATM contract, target 0.5 ATR, stop 0.4 ATR)');
console.log('  hold    tgt%  stop%  time%   avg option   median   profitable%');
for (const hold of [30, 45, 60, 90, 120, 180, 999]) {
  let t = 0, st = 0, ti = 0, sum = 0, w = 0; const rs = [];
  for (const sg of sigs) {
    const last = Math.min(365, sg.m + hold);
    const g = grade(sg.r.s, sg.m, sg.dir, sg.entry, sg.entry + sg.dir * T * sg.atr, sg.entry - sg.dir * S * sg.atr, last);
    if (g.out === 'target') t++; else if (g.out === 'stop') st++; else ti++;
    const r = optRet(sg, g, 0);
    if (r === null) continue;
    sum += r; rs.push(r); if (r > 0) w++;
  }
  rs.sort((a, b) => a - b);
  const n = rs.length;
  console.log(`  ${String(hold === 999 ? 'close' : hold + 'm').padEnd(6)} ${((100 * t) / sigs.length).toFixed(0).padStart(5)}%${((100 * st) / sigs.length).toFixed(0).padStart(6)}%${((100 * ti) / sigs.length).toFixed(0).padStart(6)}%   ${((100 * sum / n >= 0 ? '+' : '') + (100 * sum / n).toFixed(1)).padStart(7)}%  ${((100 * rs[Math.floor(n / 2)] >= 0 ? '+' : '') + (100 * rs[Math.floor(n / 2)]).toFixed(1)).padStart(7)}%      ${((100 * w) / n).toFixed(0)}%`);
}

console.log('\neffect of the STRIKE (hold 90m, target 0.5 ATR, stop 0.4 ATR)');
console.log('  strike        avg option   median   profitable%   break-even move');
for (const otm of [-2, -1, 0, 1, 2, 3]) {
  let sum = 0, w = 0; const rs = [];
  for (const sg of sigs) {
    const last = Math.min(365, sg.m + 90);
    const g = grade(sg.r.s, sg.m, sg.dir, sg.entry, sg.entry + sg.dir * T * sg.atr, sg.entry - sg.dir * S * sg.atr, last);
    const r = optRet(sg, g, otm);
    if (r === null) continue;
    sum += r; rs.push(r); if (r > 0) w++;
  }
  rs.sort((a, b) => a - b);
  const n = rs.length;
  // break-even underlying move for this strike on a representative name
  const spot = 400, atr = 8.8, iv = ivFromAtr(atr, spot), k = spot * (1 + otm / 100);
  const e = bs(spot, k, iv, TD / 252, true).price;
  let be = null;
  for (let x = 0; x < 1.2; x += 0.01) {
    const v = bs(spot + x * atr, k, iv * 0.96, (TD - 90 / 375) / 252, true).price;
    if ((v * (1 - COST) - e * (1 + COST)) >= 0) { be = x; break; }
  }
  const label = otm === 0 ? 'ATM' : otm > 0 ? `${otm}% OTM` : `${-otm}% ITM`;
  console.log(`  ${label.padEnd(12)} ${((100 * sum / n >= 0 ? '+' : '') + (100 * sum / n).toFixed(1)).padStart(7)}%  ${((100 * rs[Math.floor(n / 2)] >= 0 ? '+' : '') + (100 * rs[Math.floor(n / 2)]).toFixed(1)).padStart(7)}%       ${((100 * w) / n).toFixed(0).padStart(3)}%        +${be === null ? '>1.2' : be.toFixed(2)} ATR`);
}
