// Every signal the rule produced across all 35 cached sessions, as CSV, so the whole record
// can be checked independently rather than the last few days of it.

import { writeFileSync } from 'node:fs';
import { U, state } from './setups.mjs';
import { RULE } from './final.mjs';
import { bs, ivFromAtr } from './option.mjs';

const TD = 12, COST = 0.025;
const clock = (m) => { const t = 555 + m; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
const step = (px) => (px < 100 ? 2.5 : px < 250 ? 5 : px < 500 ? 10 : px < 1000 ? 20 : px < 2500 ? 50 : 100);

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
      found.push({ day, symbol: r.symbol, signalMin: m, m: m + 1, dir, entry, atr: r.atr, r, s,
        rvol: s.rvol, atrUsed: s.atrUsed, disp, off, open: s.open, prevClose: s.prevClose, vwap: s.vwap,
        strike: Math.round(entry / step(entry)) * step(entry) });
      break;
    }
  }
  found.sort((a, b) => b.rvol - a.rvol);
  return found.slice(0, RULE.maxPerDay);
}

function run(sig) {
  const iv = ivFromAtr(sig.atr, sig.entry);
  const paid = bs(sig.entry, sig.strike, iv, TD / 252, sig.dir === 1).price * (1 + COST);
  let half = null, realised = 0, stop = 0.5, halfAt = null, outAt = null, outWhat = '';
  for (let k = sig.m + 1; k <= 365; k++) {
    const lo = sig.dir === 1 ? sig.r.s.low[k] : sig.r.s.high[k];
    const hi = sig.dir === 1 ? sig.r.s.high[k] : sig.r.s.low[k];
    if (!Number.isFinite(lo)) continue;
    const yr = Math.max(0, (TD - (k - sig.m) / 375) / 252);
    const d = (bs(lo, sig.strike, iv, yr, sig.dir === 1).price * (1 - COST) - paid) / paid;
    const u = (bs(hi, sig.strike, iv, yr, sig.dir === 1).price * (1 - COST) - paid) / paid;
    if (d <= -stop) return { paid, ret: realised + (half === null ? 1 : 0.5) * -stop, halfAt, outAt: k, outWhat: half === null ? 'stopped' : 'breakeven' };
    if (half === null && u >= 0.3) { half = k; halfAt = k; realised = 0.15; stop = 0; }
    else if (half !== null && u >= 0.8) return { paid, ret: realised + 0.4, halfAt, outAt: k, outWhat: 'full target' };
  }
  const yr = Math.max(0, (TD - (365 - sig.m) / 375) / 252);
  const c = (bs(sig.r.s.close[365], sig.strike, iv, yr, sig.dir === 1).price * (1 - COST) - paid) / paid;
  return { paid, ret: realised + (half === null ? 1 : 0.5) * c, halfAt, outAt: 365, outWhat: 'close' };
}

const rows = [['date', 'signal_time', 'entry_time', 'symbol', 'side', 'strike', 'entry_price',
  'prev_close', 'day_open', 'vwap', 'atr', 'atr_pct', 'rvol', 'range_atr', 'move_from_open_atr',
  'off_extreme_atr', 'est_premium', 'best_price', 'best_pct', 'worst_price', 'worst_pct',
  'close_price', 'half_out_time', 'exit_time', 'exit_reason', 'option_return_pct']];

let n = 0, w = 0, tot = 0;
for (const day of U.days) {
  for (const sg of scanDay(day)) {
    const o = run(sg);
    let best = sg.entry, worst = sg.entry;
    for (let k = sg.m + 1; k <= 365; k++) {
      const h = sg.dir === 1 ? sg.r.s.high[k] : sg.r.s.low[k];
      const l = sg.dir === 1 ? sg.r.s.low[k] : sg.r.s.high[k];
      if (!Number.isFinite(h)) continue;
      if ((h - best) * sg.dir > 0) best = h;
      if ((l - worst) * sg.dir < 0) worst = l;
    }
    n++; tot += o.ret; if (o.ret > 0) w++;
    rows.push([day, clock(sg.signalMin), clock(sg.m), sg.symbol, sg.dir === 1 ? 'CALL' : 'PUT',
      sg.strike, sg.entry.toFixed(2), sg.prevClose.toFixed(2), sg.open.toFixed(2), sg.vwap.toFixed(2),
      sg.atr.toFixed(2), ((100 * sg.atr) / sg.entry).toFixed(2), sg.rvol.toFixed(1), sg.atrUsed.toFixed(2),
      sg.disp.toFixed(2), sg.off.toFixed(2), o.paid.toFixed(2),
      best.toFixed(2), (((best - sg.entry) / sg.entry) * 100 * sg.dir).toFixed(2),
      worst.toFixed(2), (((worst - sg.entry) / sg.entry) * 100 * sg.dir).toFixed(2),
      sg.r.s.close[365].toFixed(2), o.halfAt ? clock(o.halfAt) : '', clock(o.outAt), o.outWhat,
      (100 * o.ret).toFixed(1)]);
  }
}
const out = 'y:/Trading/tradefinder-app/api/research/signals-35-sessions.csv';
writeFileSync(out, rows.map((r) => r.join(',')).join('\n'));
console.log(`${n} signals written to ${out}`);
console.log(`${w} profitable (${((100 * w) / n).toFixed(0)}%) · total ${(100 * tot).toFixed(0)}% · average ${((100 * tot) / n).toFixed(1)}%`);

// Where the four days the user asked about sit in the distribution of sessions.
const perDay = U.days.map((d) => {
  const s = scanDay(d).map(run);
  return { d, n: s.length, tot: s.reduce((a, x) => a + x.ret, 0) };
}).filter((x) => x.n);
perDay.sort((a, b) => a.tot - b.tot);
console.log('\nsession ranking, worst to best (of the 31 sessions that produced a signal)');
perDay.forEach((x, i) => {
  const mark = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'].includes(x.d) ? '  <<<' : '';
  if (i < 8 || i >= perDay.length - 5 || mark) console.log(`  #${String(i + 1).padStart(2)}  ${x.d}  ${String(x.n)} signal(s)  ${(100 * x.tot >= 0 ? '+' : '') + (100 * x.tot).toFixed(0)}%${mark}`);
});
