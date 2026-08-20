import { U, state } from './setups.mjs';
import { scaleExit, RULE } from './final.mjs';

const ALL = U.days;
function scan(days) {
  const out = [];
  for (const day of days) {
    const found = [];
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < RULE.turn) continue;
      for (let m = RULE.from; m <= RULE.to; m++) {
        const s = state(r, m);
        if (!s) continue;
        const dir = s.px > s.vwap ? 1 : -1;
        if (s.rvol < RULE.rvol || s.rvol > 50 || s.atrUsed < RULE.range) continue;
        if (((s.px - s.open) / s.atr) * dir < RULE.open) continue;
        const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
        if (off > RULE.maxOff) continue;
        const entry = r.s.close[m + 1];
        if (!Number.isFinite(entry) || entry <= 0) break;
        found.push({ day, symbol: r.symbol, signalMin: m, m: m + 1, dir, entry, atr: r.atr, rvol: s.rvol, atrUsed: s.atrUsed, r, s });
        break;
      }
    }
    found.sort((a, b) => b.rvol - a.rvol);
    out.push(...found.slice(0, RULE.maxPerDay));
  }
  return out;
}

const sigs = scan(ALL);
const res = sigs.map((s) => ({ s, r: scaleExit(s) })).filter((x) => x.r);
const rets = res.map((x) => x.r.ret);
const n = rets.length;
const avg = rets.reduce((a, b) => a + b, 0) / n;
const sd = Math.sqrt(rets.reduce((a, r) => a + (r - avg) ** 2, 0) / (n - 1));

console.log(`SIGNALS      ${n} over ${ALL.length} sessions = ${(n / ALL.length).toFixed(2)}/day`);
console.log(`             sessions with 0 signals: ${ALL.filter((d) => !sigs.some((s) => s.day === d)).length}`);
console.log(`             sessions with 4 (the cap): ${ALL.filter((d) => sigs.filter((s) => s.day === d).length >= 4).length}`);
console.log(`OUTCOMES     first target +30% reached: ${(100 * res.filter((x) => x.r.tookHalf).length / n).toFixed(0)}%`);
console.log(`             ran to the full +80%:      ${(100 * res.filter((x) => x.r.out === 'target').length / n).toFixed(0)}%`);
console.log(`             stopped at −50%:           ${(100 * res.filter((x) => x.r.out === 'stop').length / n).toFixed(0)}%`);
console.log(`             half taken then breakeven: ${(100 * res.filter((x) => x.r.out === 'breakeven').length / n).toFixed(0)}%`);
console.log(`             PROFITABLE overall:        ${(100 * rets.filter((r) => r > 0).length / n).toFixed(0)}%`);
console.log(`RETURN       average ${(100 * avg).toFixed(1)}%  median ${(100 * [...rets].sort((a, b) => a - b)[Math.floor(n / 2)]).toFixed(1)}%  sd ${(100 * sd).toFixed(0)}%  t ${(avg / (sd / Math.sqrt(n))).toFixed(2)}`);
console.log(`             control (buy any liquid option 09:46, hold to close) = −7.4%`);
console.log(`             alpha over control: +${(100 * (avg + 0.074)).toFixed(1)} points`);
const sorted = [...rets].sort((a, b) => b - a);
console.log(`             best ${(100 * sorted[0]).toFixed(0)}%  worst ${(100 * sorted[n - 1]).toFixed(0)}%`);
console.log(`             top 5 trades = ${(100 * sorted.slice(0, 5).reduce((a, b) => a + b, 0)).toFixed(0)}% of the ${(100 * rets.reduce((a, b) => a + b, 0)).toFixed(0)}% total`);
console.log(`             excluding them: ${(100 * (rets.reduce((a, b) => a + b, 0) - sorted.slice(0, 5).reduce((a, b) => a + b, 0)) / (n - 5)).toFixed(1)}% per trade over ${n - 5} trades`);

console.log('\nby direction');
for (const d of [1, -1]) {
  const sub = res.filter((x) => x.s.dir === d);
  const a = sub.reduce((q, x) => q + x.r.ret, 0) / sub.length;
  console.log(`  ${d === 1 ? 'CALL' : 'PUT '}  n ${String(sub.length).padStart(3)}  profitable ${(100 * sub.filter((x) => x.r.ret > 0).length / sub.length).toFixed(0)}%  avg ${((100 * a >= 0 ? '+' : '') + (100 * a).toFixed(1))}%`);
}

console.log('\nsession totals (1 lot each, %)');
let run = 0; const line = [];
for (const d of ALL) {
  const sub = res.filter((x) => x.s.day === d);
  const tot = sub.reduce((a, x) => a + x.r.ret, 0);
  run += tot;
  line.push(`${d.slice(5)} ${sub.length ? ((100 * tot >= 0 ? '+' : '') + (100 * tot).toFixed(0)).padStart(5) : '    ·'}`);
}
for (let i = 0; i < line.length; i += 5) console.log('  ' + line.slice(i, i + 5).join('   '));
const dayTots = ALL.map((d) => res.filter((x) => x.s.day === d)).filter((s) => s.length).map((s) => s.reduce((a, x) => a + x.r.ret, 0));
console.log(`  ${dayTots.filter((v) => v > 0).length} of ${dayTots.length} sessions with a signal were net positive; cumulative ${(100 * run).toFixed(0)}% across ${n} single-lot trades`);

console.log('\nsignal count distribution');
const counts = {};
for (const d of ALL) { const c = sigs.filter((s) => s.day === d).length; counts[c] = (counts[c] || 0) + 1; }
for (const k of Object.keys(counts).sort()) console.log(`  ${k} signal${k === '1' ? '' : 's'}: ${counts[k]} sessions`);
