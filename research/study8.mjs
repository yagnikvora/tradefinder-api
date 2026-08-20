// Does deciding EARLIER put more of the move in front of you?
import { U, FIT, state } from './setups.mjs';
import { grade } from './lab.mjs';

console.log('base rate of a large favourable move, by the minute you decide');
console.log('  decide   n/day   P(+0.5 ATR)  P(+0.75)  P(+1.0)  P(+1.5)   median MFE   median MAE');
for (const M of [10, 15, 20, 30, 45, 60, 75, 105]) {
  const rows = [];
  for (const day of FIT) {
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < 40) continue;
      const s = state(r, M);
      if (!s) continue;
      const dir = s.px > s.vwap ? 1 : -1;
      const g = grade(r.s, M, dir, s.px, s.px + dir * 99 * r.atr, s.px - dir * 99 * r.atr, 360);
      rows.push({ mfe: g.mfe / r.atr, mae: g.mae / r.atr });
    }
  }
  const n = rows.length;
  const p = (x) => ((100 * rows.filter((r) => r.mfe >= x).length) / n).toFixed(1).padStart(5);
  const mfe = rows.map((r) => r.mfe).sort((a, b) => a - b);
  const mae = rows.map((r) => r.mae).sort((a, b) => a - b);
  const t = 555 + M;
  const hhmm = String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  console.log(`  ${hhmm}   ${(n / FIT.length).toFixed(0).padStart(5)}   ${p(0.5)}%     ${p(0.75)}%   ${p(1.0)}%   ${p(1.5)}%      ${mfe[Math.floor(n / 2)].toFixed(2)}         ${mae[Math.floor(n / 2)].toFixed(2)}`);
}

console.log('\nsame, but only for the names that already look like something at that minute');
console.log('(rvol >= 2.5 and at least 0.5 ATR of range already made)');
console.log('  decide   n/day   P(+0.5 ATR)  P(+0.75)  P(+1.0)  P(+1.5)   median MFE   median MAE');
for (const M of [10, 15, 20, 30, 45, 60, 75, 105]) {
  const rows = [];
  for (const day of FIT) {
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < 40) continue;
      const s = state(r, M);
      if (!s) continue;
      if (s.rvol < 2.5 || s.atrUsed < 0.5) continue;
      const dir = s.px > s.vwap ? 1 : -1;
      const g = grade(r.s, M, dir, s.px, s.px + dir * 99 * r.atr, s.px - dir * 99 * r.atr, 360);
      rows.push({ mfe: g.mfe / r.atr, mae: g.mae / r.atr });
    }
  }
  const n = rows.length;
  if (n < 30) continue;
  const p = (x) => ((100 * rows.filter((r) => r.mfe >= x).length) / n).toFixed(1).padStart(5);
  const mfe = rows.map((r) => r.mfe).sort((a, b) => a - b);
  const mae = rows.map((r) => r.mae).sort((a, b) => a - b);
  const t = 555 + M;
  const hhmm = String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  console.log(`  ${hhmm}   ${(n / FIT.length).toFixed(1).padStart(5)}   ${p(0.5)}%     ${p(0.75)}%   ${p(1.0)}%   ${p(1.5)}%      ${mfe[Math.floor(n / 2)].toFixed(2)}         ${mae[Math.floor(n / 2)].toFixed(2)}`);
}
