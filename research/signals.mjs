import { U, state } from './setups.mjs';
import { scan, scaleExit, RULE } from './final.mjs';
import { grade } from './lab.mjs';

const clock = (m) => { const t = 555 + m; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
const DAYS = process.argv.slice(2).length ? process.argv.slice(2) : ['2026-08-19', '2026-08-20'];

for (const day of DAYS) {
  if (!U.byDay.has(day)) { console.log(`${day}: no data`); continue; }
  console.log(`\n${'='.repeat(104)}\n${day}\n${'='.repeat(104)}`);
  const sigs = scan([day]);
  if (!sigs.length) console.log('  NO SIGNAL — nothing cleared the rule. That is the intended behaviour on a day with no real displacement.');
  for (const s of sigs) {
    const ex = scaleExit(s);
    const g = grade(s.r.s, s.m, s.dir, s.entry, s.entry + s.dir * 99 * s.atr, s.entry - s.dir * 99 * s.atr, 365);
    const close = s.r.s.close[365];
    console.log(
      `\n  ${clock(s.signalMin)}  ${s.symbol}  ${s.dir === 1 ? 'BUY CALL' : 'BUY PUT'}  ${s.strike} strike` +
      `\n     entry ${s.entry.toFixed(2)} at ${clock(s.m)}   ATR ${s.atr.toFixed(2)} (${((100 * s.atr) / s.entry).toFixed(2)}%)` +
      `\n     why: RVOL ${s.rvol.toFixed(1)}x · ${s.atrUsed.toFixed(2)} ATR of range by ${clock(s.signalMin)} · ${s.disp.toFixed(2)} ATR from the open · ${s.off.toFixed(2)} ATR off the extreme` +
      `\n     after: best +${((100 * g.mfe) / s.entry).toFixed(2)}%  worst −${((100 * g.mae) / s.entry).toFixed(2)}%  close ${(((close - s.entry) / s.entry) * 100 * s.dir >= 0 ? '+' : '') + (((close - s.entry) / s.entry) * 100 * s.dir).toFixed(2)}%` +
      `\n     option: ${ex.out === 'target' ? 'both targets hit' : ex.out === 'stop' ? 'stopped at −50%' : ex.out === 'breakeven' ? 'half at +30%, rest stopped at breakeven' : ex.tookHalf ? 'half at +30%, rest closed at 15:15' : 'no target, closed at 15:15'} -> ${(100 * ex.ret >= 0 ? '+' : '') + (100 * ex.ret).toFixed(1)}%`,
    );
  }

  // What ALMOST qualified, so the gate is legible rather than mysterious.
  const near = [];
  for (const r of U.byDay.get(day).values()) {
    if (r.medTurnoverCr < RULE.turn) continue;
    let best = null;
    for (let m = RULE.from; m <= RULE.to; m++) {
      const s = state(r, m);
      if (!s) continue;
      const dir = s.px > s.vwap ? 1 : -1;
      const disp = ((s.px - s.open) / s.atr) * dir;
      const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
      const fails = [];
      if (s.rvol < RULE.rvol) fails.push(`RVOL ${s.rvol.toFixed(1)}<${RULE.rvol}`);
      if (s.atrUsed < RULE.range) fails.push(`range ${s.atrUsed.toFixed(2)}<${RULE.range}`);
      if (disp < RULE.open) fails.push(`move ${disp.toFixed(2)}<${RULE.open}`);
      if (off > RULE.maxOff) fails.push(`off-extreme ${off.toFixed(2)}>${RULE.maxOff}`);
      if (fails.length === 1 && (!best || best.fails.length > 1)) best = { m, fails, s, dir };
    }
    if (best) near.push({ sym: r.symbol, ...best });
  }
  if (near.length) {
    console.log(`\n  came within one condition (${near.length}):`);
    for (const nb of near.slice(0, 10)) console.log(`     ${nb.sym.padEnd(12)} ${clock(nb.m)}  failed only: ${nb.fails.join(', ')}`);
  }
}

// For contrast, a day the rule liked.
console.log(`\n${'='.repeat(104)}\nfor contrast — every signal on the three best and three worst sessions\n${'='.repeat(104)}`);
const byDay = U.days.map((d) => {
  const s = scan([d]).map((x) => ({ x, r: scaleExit(x) })).filter((y) => y.r);
  return { d, n: s.length, tot: s.reduce((a, y) => a + y.r.ret, 0), s };
}).filter((v) => v.n);
byDay.sort((a, b) => b.tot - a.tot);
for (const grp of [byDay.slice(0, 3), byDay.slice(-3)]) {
  for (const d of grp) {
    console.log(`\n  ${d.d}  ${d.n} signals, session total ${(100 * d.tot >= 0 ? '+' : '') + (100 * d.tot).toFixed(0)}%`);
    for (const y of d.s)
      console.log(`     ${clock(y.x.signalMin)} ${y.x.symbol.padEnd(12)} ${y.x.dir === 1 ? 'CALL' : 'PUT '}  RVOL ${y.x.rvol.toFixed(1).padStart(5)}x  range ${y.x.atrUsed.toFixed(2)}  ->  ${(100 * y.r.ret >= 0 ? '+' : '') + (100 * y.r.ret).toFixed(1)}%`);
  }
}
