// Why 55% profitable still lost money in the 10-14 Aug week.
//
// Three candidate explanations, and they are distinguishable: the trades went the wrong way, or
// they went the right way but not far enough to pay for the option, or the mix of exits was
// unlucky against the strategy's own base rates. Everything is measured against all 35 sessions.

import { U, state } from './setups.mjs';
import { RULE } from './final.mjs';
import { bs, ivFromAtr } from './option.mjs';

const TD = 12, COST = 0.025;
const step = (p) => (p < 100 ? 2.5 : p < 250 ? 5 : p < 500 ? 10 : p < 1000 ? 20 : p < 2500 ? 50 : 100);
const WEEK = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];

function scanDay(day) {
  const found = [];
  for (const r of U.byDay.get(day).values()) {
    if (r.medTurnoverCr < RULE.turn) continue;
    for (let m = RULE.from; m <= RULE.to; m++) {
      const s = state(r, m);
      if (!s) continue;
      const dir = s.px > s.vwap ? 1 : -1;
      if (s.rvol < RULE.rvol || s.rvol > 50 || s.atrUsed < RULE.range) continue;
      const disp = ((s.px - s.open) / s.atr) * dir;
      if (disp < RULE.open) continue;
      const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
      if (off > RULE.maxOff) continue;
      const entry = r.s.close[m + 1];
      if (!Number.isFinite(entry) || entry <= 0) break;
      found.push({
        day, symbol: r.symbol, m: m + 1, dir, entry, atr: r.atr, r, rvol: s.rvol,
        strike: Math.round(entry / step(entry)) * step(entry),
      });
      break;
    }
  }
  found.sort((a, b) => b.rvol - a.rvol);
  return found.slice(0, RULE.maxPerDay);
}

function trade(sg) {
  const iv = ivFromAtr(sg.atr, sg.entry);
  const paid = bs(sg.entry, sg.strike, iv, TD / 252, sg.dir === 1).price * (1 + COST);
  let half = null, realised = 0, stop = 0.5, ret = null, out = null;
  for (let k = sg.m + 1; k <= 365 && ret === null; k++) {
    const lo = sg.dir === 1 ? sg.r.s.low[k] : sg.r.s.high[k];
    const hi = sg.dir === 1 ? sg.r.s.high[k] : sg.r.s.low[k];
    if (!Number.isFinite(lo)) continue;
    const yr = Math.max(0, (TD - (k - sg.m) / 375) / 252);
    const d = (bs(lo, sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid;
    const u = (bs(hi, sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid;
    if (d <= -stop) { ret = realised + (half === null ? 1 : 0.5) * -stop; out = half === null ? 'stopped' : 'breakeven'; }
    else if (half === null && u >= 0.3) { half = k; realised = 0.15; stop = 0; }
    else if (half !== null && u >= 0.8) { ret = realised + 0.4; out = 'full'; }
  }
  if (ret === null) {
    const yr = Math.max(0, (TD - (365 - sg.m) / 375) / 252);
    const c = (bs(sg.r.s.close[365], sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid;
    ret = realised + (half === null ? 1 : 0.5) * c;
    out = half === null ? 'closed flat' : 'closed after half';
  }
  let mfe = 0, mae = 0;
  for (let k = sg.m + 1; k <= 365; k++) {
    const h = sg.dir === 1 ? sg.r.s.high[k] : sg.r.s.low[k];
    const l = sg.dir === 1 ? sg.r.s.low[k] : sg.r.s.high[k];
    if (!Number.isFinite(h)) continue;
    mfe = Math.max(mfe, ((h - sg.entry) * sg.dir) / sg.atr);
    mae = Math.max(mae, ((sg.entry - l) * sg.dir) / sg.atr);
  }
  return { ...sg, ret, out, mfe, mae, tookHalf: half !== null };
}

const all = U.days.flatMap((d) => scanDay(d).map(trade));
const week = all.filter((t) => WEEK.includes(t.day));
const rest = all.filter((t) => !WEEK.includes(t.day));

function summarise(label, ts) {
  const n = ts.length;
  const wins = ts.filter((t) => t.ret > 0), losses = ts.filter((t) => t.ret <= 0);
  const avgW = wins.length ? wins.reduce((a, t) => a + t.ret, 0) / wins.length : 0;
  const avgL = losses.length ? losses.reduce((a, t) => a + t.ret, 0) / losses.length : 0;
  const exp = ts.reduce((a, t) => a + t.ret, 0) / n;
  const mfe = ts.map((t) => t.mfe).sort((a, b) => a - b);
  const mae = ts.map((t) => t.mae).sort((a, b) => a - b);
  const ratio = avgL !== 0 ? Math.abs(avgW / avgL) : 0;
  console.log(
    `  ${label.padEnd(20)} n=${String(n).padStart(3)}  win ${((100 * wins.length) / n).toFixed(0).padStart(3)}%  ` +
    `avg win ${(100 * avgW).toFixed(0).padStart(4)}%  avg loss ${(100 * avgL).toFixed(0).padStart(4)}%  ` +
    `win/loss ${ratio.toFixed(2)}  expectancy ${((100 * exp >= 0 ? '+' : '') + (100 * exp).toFixed(1)).padStart(6)}%  ` +
    `medMFE ${mfe[Math.floor(n / 2)].toFixed(2)}  medMAE ${mae[Math.floor(n / 2)].toFixed(2)}`,
  );
}

console.log('1. THE ARITHMETIC - a 55% win rate is not enough when the losses are bigger\n');
summarise('10-14 Aug', week);
summarise('the other 30 days', rest);
summarise('all 35 sessions', all);
const wW = week.filter((t) => t.ret > 0), wL = week.filter((t) => t.ret <= 0);
const aw = wW.reduce((a, t) => a + t.ret, 0) / wW.length, al = wL.reduce((a, t) => a + t.ret, 0) / wL.length;
console.log(`\n  that week: ${wW.length} wins averaging +${(100 * aw).toFixed(0)}% and ${wL.length} losses averaging ${(100 * al).toFixed(0)}%.`);
console.log(`  break-even would have needed a win rate of ${(100 * Math.abs(al) / (aw + Math.abs(al))).toFixed(0)}%, and you got ${((100 * wW.length) / week.length).toFixed(0)}%.`);

console.log('\n2. THE EXIT MIX - which gates fired, that week versus normally\n');
console.log('   exit                 that week        all 35');
for (const k of ['stopped', 'breakeven', 'full', 'closed flat', 'closed after half']) {
  const a = week.filter((t) => t.out === k).length, b = all.filter((t) => t.out === k).length;
  console.log(`   ${k.padEnd(20)} ${String(a).padStart(2)}/${week.length} = ${((100 * a) / week.length).toFixed(0).padStart(3)}%        ${((100 * b) / all.length).toFixed(0).padStart(3)}%`);
}
const wHalf = week.filter((t) => t.tookHalf).length, aHalf = all.filter((t) => t.tookHalf).length;
console.log(`   reached +30% at all  ${String(wHalf).padStart(2)}/${week.length} = ${((100 * wHalf) / week.length).toFixed(0).padStart(3)}%        ${((100 * aHalf) / all.length).toFixed(0).padStart(3)}%   <-- this is the gap`);

console.log('\n3. DID THE STOCKS ACTUALLY MOVE?\n');
console.log('   travelled at least X ATR in favour:');
console.log('   X ATR      that week    all 35');
for (const x of [0.2, 0.3, 0.5, 0.75, 1.0]) {
  const a = week.filter((t) => t.mfe >= x).length / week.length;
  const b = all.filter((t) => t.mfe >= x).length / all.length;
  console.log(`   ${x.toFixed(2)}       ${(100 * a).toFixed(0).padStart(4)}%       ${(100 * b).toFixed(0).padStart(4)}%`);
}
console.log('\n   went against by at least X ATR first:');
console.log('   X ATR      that week    all 35');
for (const x of [0.3, 0.5, 0.75, 1.0]) {
  const a = week.filter((t) => t.mae >= x).length / week.length;
  const b = all.filter((t) => t.mae >= x).length / all.length;
  console.log(`   ${x.toFixed(2)}       ${(100 * a).toFixed(0).padStart(4)}%       ${(100 * b).toFixed(0).padStart(4)}%`);
}

console.log('\n4. WHERE THE LOSS CAME FROM, trade by trade\n');
for (const t of [...week].sort((a, b) => a.ret - b.ret)) {
  console.log(`   ${t.day.slice(5)}  ${t.symbol.padEnd(12)} ${t.dir === 1 ? 'CALL' : 'PUT '}  ${((100 * t.ret >= 0 ? '+' : '') + (100 * t.ret).toFixed(0)).padStart(5)}%   MFE ${t.mfe.toFixed(2)} ATR   MAE ${t.mae.toFixed(2)} ATR   ${t.out}`);
}
const stopped = week.filter((t) => t.out === 'stopped');
const others = week.filter((t) => t.out !== 'stopped');
console.log(`\n   the ${stopped.length} hard stops:      ${(100 * stopped.reduce((a, t) => a + t.ret, 0)).toFixed(0)}%   (${stopped.map((t) => t.symbol).join(', ')})`);
console.log(`   the other ${others.length} trades:  ${((100 * others.reduce((a, t) => a + t.ret, 0)) >= 0 ? '+' : '') + (100 * others.reduce((a, t) => a + t.ret, 0)).toFixed(0)}%`);

console.log('\n5. WAS THE MARKET DIFFERENT? Nifty daily range against its own 35-session average\n');
const nif = U.nifty;
const nrange = (d) => { const s = nif.sessions.get(d); return s ? ((s.dayHigh[374] - s.dayLow[374]) / s.open) * 100 : null; };
const allR = U.days.map(nrange).filter((v) => v !== null);
const avgR = allR.reduce((a, b) => a + b, 0) / allR.length;
for (const d of WEEK) {
  const w = week.filter((t) => t.day === d);
  console.log(`   ${d}  Nifty range ${nrange(d).toFixed(2)}%  = ${((100 * nrange(d)) / avgR).toFixed(0).padStart(3)}% of average   session ${((100 * w.reduce((a, t) => a + t.ret, 0)) >= 0 ? '+' : '') + (100 * w.reduce((a, t) => a + t.ret, 0)).toFixed(0)}%`);
}
const weekAvg = WEEK.map(nrange).reduce((a, b) => a + b, 0) / WEEK.length;
console.log(`   week average ${weekAvg.toFixed(2)}% against ${avgR.toFixed(2)}% overall = ${((100 * weekAvg) / avgR).toFixed(0)}% of normal`);
