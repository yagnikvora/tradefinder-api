// The same scan and grade as signals4.mjs, emitted as JSON so the Discord poster and the
// terminal report cannot drift apart about a price.

import { U, state } from './setups.mjs';
import { RULE } from './final.mjs';
import { bs, ivFromAtr } from './option.mjs';

const TD = 12, COST = 0.025;
const clock = (m) => { const t = 555 + m; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
const step = (p) => (p < 100 ? 2.5 : p < 250 ? 5 : p < 500 ? 10 : p < 1000 ? 20 : p < 2500 ? 50 : 100);
const rs = (v) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

const out = {};
for (const day of process.argv.slice(2)) {
  out[day] = [];
  if (!U.byDay.has(day)) continue;
  for (const sg of scanDay(day)) {
    const iv = ivFromAtr(sg.atr, sg.entry);
    const paid = bs(sg.entry, sg.strike, iv, TD / 252, sg.dir === 1).price * (1 + COST);
    const events = [];
    let half = null, realised = 0, stop = 0.5, ret = null;
    for (let k = sg.m + 1; k <= 365 && ret === null; k++) {
      const lo = sg.dir === 1 ? sg.r.s.low[k] : sg.r.s.high[k];
      const hi = sg.dir === 1 ? sg.r.s.high[k] : sg.r.s.low[k];
      if (!Number.isFinite(lo)) continue;
      const yr = Math.max(0, (TD - (k - sg.m) / 375) / 252);
      const d = (bs(lo, sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid;
      const u = (bs(hi, sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid;
      if (d <= -stop) {
        events.push({ at: clock(k), what: half === null ? '**STOPPED −50%**' : 'rest out at breakeven', px: lo });
        ret = realised + (half === null ? 1 : 0.5) * -stop;
      } else if (half === null && u >= 0.3) { half = k; realised = 0.15; stop = 0; events.push({ at: clock(k), what: '**HALF OUT +30%**', px: hi }); }
      else if (half !== null && u >= 0.8) { events.push({ at: clock(k), what: '**REST OUT +80%**', px: hi }); ret = realised + 0.4; }
    }
    if (ret === null) {
      const yr = Math.max(0, (TD - (365 - sg.m) / 375) / 252);
      const c = (bs(sg.r.s.close[365], sg.strike, iv, yr, sg.dir === 1).price * (1 - COST) - paid) / paid;
      events.push({ at: '15:15', what: 'closed at 15:15', px: sg.r.s.close[365] });
      ret = realised + (half === null ? 1 : 0.5) * c;
    }
    let best = sg.entry, worst = sg.entry, bestAt = sg.m;
    for (let k = sg.m + 1; k <= 365; k++) {
      const h = sg.dir === 1 ? sg.r.s.high[k] : sg.r.s.low[k];
      const l = sg.dir === 1 ? sg.r.s.low[k] : sg.r.s.high[k];
      if (!Number.isFinite(h)) continue;
      if ((h - best) * sg.dir > 0) { best = h; bestAt = k; }
      if ((l - worst) * sg.dir < 0) worst = l;
    }
    out[day].push({
      day, signalTime: clock(sg.signalMin), entryTime: clock(sg.m), symbol: sg.symbol,
      side: sg.dir === 1 ? 'CALL' : 'PUT', strike: sg.strike, entry: sg.entry,
      prevClose: sg.prevClose, open: sg.open, vwap: sg.vwap, atr: sg.atr,
      atrPct: (100 * sg.atr) / sg.entry, rvol: sg.rvol, rangeAtr: sg.atrUsed,
      moveAtr: sg.disp, offAtr: sg.off,
      half: rs(spotFor(sg, iv, paid, 1.3, 30)), full: rs(spotFor(sg, iv, paid, 1.8, 60)), stop: rs(spotFor(sg, iv, paid, 0.5, 30)),
      best, bestPct: (((best - sg.entry) / sg.entry) * 100 * sg.dir), bestAt: clock(bestAt),
      worst, worstPct: (((worst - sg.entry) / sg.entry) * 100 * sg.dir),
      events, ret: 100 * ret,
    });
  }
}
process.stdout.write(JSON.stringify(out));
