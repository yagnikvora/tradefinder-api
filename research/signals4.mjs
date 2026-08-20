// Signal log for a set of sessions, written so it can be checked against a chart.
//
// Everything an option exit does is reported as a STOCK price and a clock time, because that
// is what a candlestick chart shows. The option percentages are alongside, not instead.

import { U, state } from './setups.mjs';
import { RULE } from './final.mjs';
import { bs, ivFromAtr } from './option.mjs';

const TD = 12, COST = 0.025;
const clock = (m) => { const t = 555 + m; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
const rs = (v) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function strikeStep(px) {
  if (px < 100) return 2.5;
  if (px < 250) return 5;
  if (px < 500) return 10;
  if (px < 1000) return 20;
  if (px < 2500) return 50;
  return 100;
}

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
      const step = strikeStep(entry);
      found.push({
        day, symbol: r.symbol, signalMin: m, m: m + 1, dir, entry, atr: r.atr, r, s,
        rvol: s.rvol, atrUsed: s.atrUsed, disp, off, vwap: s.vwap,
        dayHigh: s.dayHigh, dayLow: s.dayLow, open: s.open, prevClose: s.prevClose,
        strike: Math.round(entry / step) * step,
      });
      break;
    }
  }
  found.sort((a, b) => b.rvol - a.rvol);
  return found.slice(0, RULE.maxPerDay);
}

/** The stock price at which the option is worth `mult` of what was paid, `mins` into the hold. */
function spotFor(sig, iv, paid, mult, mins) {
  const yr = Math.max(0, (TD - mins / 375) / 252);
  const want = (paid * mult) / (1 - COST);
  let lo = sig.entry * 0.85, hi = sig.entry * 1.15;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const v = bs(mid, sig.strike, iv, yr, sig.dir === 1).price;
    if ((v < want) === (sig.dir === 1)) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Walk the day, recording each exit event as a time and a stock price. */
function run(sig) {
  const iv = ivFromAtr(sig.atr, sig.entry);
  const paid = bs(sig.entry, sig.strike, iv, TD / 252, sig.dir === 1).price * (1 + COST);
  const events = [];
  let half = null, realised = 0, stop = 0.50;
  for (let k = sig.m + 1; k <= 365; k++) {
    const lo = sig.dir === 1 ? sig.r.s.low[k] : sig.r.s.high[k];
    const hi = sig.dir === 1 ? sig.r.s.high[k] : sig.r.s.low[k];
    if (!Number.isFinite(lo)) continue;
    const mins = k - sig.m;
    const yr = Math.max(0, (TD - mins / 375) / 252);
    const vDown = (bs(lo, sig.strike, iv, yr, sig.dir === 1).price * (1 - COST) - paid) / paid;
    const vUp = (bs(hi, sig.strike, iv, yr, sig.dir === 1).price * (1 - COST) - paid) / paid;
    if (vDown <= -stop) {
      const rest = half === null ? 1 : 0.5;
      events.push({ what: half === null ? 'STOPPED −50%' : 'rest out at breakeven', at: k, px: lo });
      return { paid, iv, events, ret: realised + rest * -stop };
    }
    if (half === null && vUp >= 0.30) { half = k; realised = 0.5 * 0.30; stop = 0; events.push({ what: 'HALF OUT at +30%', at: k, px: hi }); }
    else if (half !== null && vUp >= 0.80) { events.push({ what: 'REST OUT at +80%', at: k, px: hi }); return { paid, iv, events, ret: realised + 0.5 * 0.80 }; }
  }
  const mins = 365 - sig.m;
  const yr = Math.max(0, (TD - mins / 375) / 252);
  const close = (bs(sig.r.s.close[365], sig.strike, iv, yr, sig.dir === 1).price * (1 - COST) - paid) / paid;
  events.push({ what: 'closed at 15:15', at: 365, px: sig.r.s.close[365] });
  return { paid, iv, events, ret: realised + (half === null ? 1 : 0.5) * close };
}

const DAYS = process.argv.slice(2);
let grand = 0, count = 0, wins = 0;
for (const day of DAYS) {
  if (!U.byDay.has(day)) { console.log(`\n${day}: no data\n`); continue; }
  const sigs = scanDay(day);
  console.log(`\n${'━'.repeat(100)}`);
  console.log(`${day}   ${sigs.length} signal${sigs.length === 1 ? '' : 's'}`);
  console.log('━'.repeat(100));
  if (!sigs.length) { console.log('  no signal — nothing cleared the rule'); continue; }
  let dayTot = 0;
  for (const sg of sigs) {
    const out = run(sg);
    dayTot += out.ret; grand += out.ret; count++; if (out.ret > 0) wins++;
    const mfeK = []; let best = sg.entry, worst = sg.entry, bestAt = sg.m, worstAt = sg.m;
    for (let k = sg.m + 1; k <= 365; k++) {
      const h = sg.dir === 1 ? sg.r.s.high[k] : sg.r.s.low[k];
      const l = sg.dir === 1 ? sg.r.s.low[k] : sg.r.s.high[k];
      if (!Number.isFinite(h)) continue;
      if ((h - best) * sg.dir > 0) { best = h; bestAt = k; }
      if ((l - worst) * sg.dir < 0) { worst = l; worstAt = k; }
    }
    const t30 = spotFor(sg, out.iv, out.paid, 1.30, 30);
    const t80 = spotFor(sg, out.iv, out.paid, 1.80, 60);
    const t50 = spotFor(sg, out.iv, out.paid, 0.50, 30);
    console.log(`\n  ${clock(sg.signalMin)}  ${sg.symbol}   ${sg.dir === 1 ? 'BUY CALL' : 'BUY PUT'}  ${sg.strike} ${sg.dir === 1 ? 'CE' : 'PE'}  (monthly)`);
    console.log(`     entry        ${rs(sg.entry)} at ${clock(sg.m)}`);
    console.log(`     the readings RVOL ${sg.rvol.toFixed(1)}x · range ${sg.atrUsed.toFixed(2)} ATR by ${clock(sg.signalMin)} · ${sg.disp.toFixed(2)} ATR from open ${rs(sg.open)} · ${sg.off.toFixed(2)} ATR off the ${sg.dir === 1 ? 'high' : 'low'} ${rs(sg.dir === 1 ? sg.dayHigh : sg.dayLow)}`);
    console.log(`     context      prev close ${rs(sg.prevClose)} · VWAP ${rs(sg.vwap)} · ATR ${rs(sg.atr)} (${((100 * sg.atr) / sg.entry).toFixed(2)}%)`);
    console.log(`     levels       half out near ${rs(t30)}   ·   rest out near ${rs(t80)}   ·   stop near ${rs(t50)}`);
    console.log(`     what happened  best ${rs(best)} at ${clock(bestAt)} (${(((best - sg.entry) / sg.entry) * 100 * sg.dir).toFixed(2)}%)   worst ${rs(worst)} at ${clock(worstAt)} (${(((worst - sg.entry) / sg.entry) * 100 * sg.dir).toFixed(2)}%)   close ${rs(sg.r.s.close[365])}`);
    for (const e of out.events) console.log(`                    ${clock(e.at)}  ${e.what}  — stock ${rs(e.px)}`);
    console.log(`     RESULT       ${(100 * out.ret >= 0 ? '+' : '') + (100 * out.ret).toFixed(1)}% on the premium`);
  }
  console.log(`\n  session total: ${(100 * dayTot >= 0 ? '+' : '') + (100 * dayTot).toFixed(1)}% across ${sigs.length} single-lot trades`);
}
console.log(`\n${'━'.repeat(100)}`);
console.log(`${count} signals over ${DAYS.length} sessions · ${wins} profitable (${count ? ((100 * wins) / count).toFixed(0) : 0}%) · total ${(100 * grand >= 0 ? '+' : '') + (100 * grand).toFixed(1)}% · average ${count ? ((100 * grand / count >= 0 ? '+' : '') + (100 * grand / count).toFixed(1)) : 0}%`);
