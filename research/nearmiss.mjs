import { U, state } from './setups.mjs';
import { RULE } from './final.mjs';
const clock = (m) => { const t = 555 + m; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };

for (const day of process.argv.slice(2)) {
  if (!U.byDay.has(day)) continue;
  console.log(`\n${day} — names that came within ONE condition of firing`);
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
      const f = [];
      if (s.rvol < RULE.rvol) f.push(`RVOL only ${s.rvol.toFixed(1)}x`);
      if (s.atrUsed < RULE.range) f.push(`range only ${s.atrUsed.toFixed(2)} ATR`);
      if (disp < RULE.open) f.push(`move only ${disp.toFixed(2)} ATR`);
      if (off > RULE.maxOff) f.push(`${off.toFixed(2)} ATR off the extreme`);
      if (f.length === 1 && !best) best = { m, f, dir, close: r.s.close[365], px: s.px };
    }
    if (best) near.push({ sym: r.symbol, ...best });
  }
  if (!near.length) { console.log('   none — the morning was ordinary across the board'); continue; }
  for (const nb of near.slice(0, 12)) {
    const after = (((nb.close - nb.px) / nb.px) * 100 * nb.dir).toFixed(2);
    console.log(`   ${nb.sym.padEnd(12)} ${clock(nb.m)}  ${nb.dir === 1 ? 'call' : 'put '}  rejected: ${nb.f[0].padEnd(28)} (would have ended ${after >= 0 ? '+' : ''}${after}% in the stock)`);
  }
  console.log(`   ${near.length} in total`);
}
