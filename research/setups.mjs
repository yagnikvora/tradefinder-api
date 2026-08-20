// Candidate setups, each a first-principles idea rather than a grid point, and each fired at
// most ONCE per stock per day at the first qualifying minute. Graded over a (target, stop) grid
// so the trade-off between hit rate and option payoff is visible instead of assumed.

import { loadUniverse, grade, clock } from './lab.mjs';

export const U = loadUniverse();
export const FIT = U.days.filter((d) => d < '2026-08-19');
export const HOLD = U.days.filter((d) => d >= '2026-08-19');

// Rough conversion used only to sanity-check the trade, never to grade it: a near-ATM stock
// option roughly 10 sessions from expiry gains about 40% of premium per 1 ATR of underlying
// move. So 0.5 ATR is a ~20% option move before spread and decay.
export const optionPctFor = (atrMove) => 40 * atrMove;

export function state(r, m) {
  const s = r.s;
  const px = s.close[m];
  if (!Number.isFinite(px) || px <= 0) return null;
  const atr = r.atr, vw = s.vwap[m];
  if (!Number.isFinite(vw) || vw <= 0) return null;
  const range = s.dayHigh[m] - s.dayLow[m];
  const gap = (s.open - r.prev.close) / atr;

  let above = 0, seen = 0, crossings = 0, prevSide = 0;
  for (let k = 0; k <= m; k++) {
    if (!Number.isFinite(s.close[k])) continue;
    seen++;
    const side = s.close[k] > s.vwap[k] ? 1 : -1;
    if (side === 1) above++;
    if (prevSide !== 0 && side !== prevSide) crossings++;
    prevSide = side;
  }
  const nsess = U.nifty.sessions.get(r.day);
  const nRet = nsess && Number.isFinite(nsess.close[m]) ? (nsess.close[m] - nsess.open) / nsess.open : 0;

  return {
    m, px, atr, vwap: vw, range, gap, crossings,
    aboveFrac: seen ? above / seen : 0.5,
    rvol: r.profile[m] > 0 ? s.cumVol[m] / r.profile[m] : 0,
    atrUsed: range / atr,
    dayHigh: s.dayHigh[m], dayLow: s.dayLow[m],
    orHigh: s.orHigh, orLow: s.orLow,
    open: s.open, prevClose: r.prev.close, prevHigh: r.prev.high, prevLow: r.prev.low,
    atrPct: (atr / px) * 100,
    niftyRet: nRet,
    stockRet: (px - s.open) / s.open,
  };
}

/** Run one setup across a set of days. Returns one signal per stock per day at most. */
export function run(setup, days, opts = {}) {
  const minTurnover = opts.minTurnover ?? 40;
  const from = opts.from ?? 18, to = opts.to ?? 150;
  const signals = [];
  for (const day of days) {
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < minTurnover) continue;
      for (let m = from; m <= to; m++) {
        const st = state(r, m);
        if (!st) continue;
        const hit = setup(st, r);
        if (!hit) continue;
        signals.push({ day, symbol: r.symbol, m, dir: hit.dir, entry: st.px, atr: r.atr, r, st, why: hit.why ?? '' });
        break;
      }
    }
  }
  return signals;
}

export function report(name, signals, days, grid, holdMin = 999) {
  const perDay = signals.length / days.length;
  console.log(`\n${name}`);
  console.log(`  ${signals.length} signals over ${days.length} sessions = ${perDay.toFixed(1)} a day`);
  if (!signals.length) return;
  console.log('   target  stop      n    hit%   stop%   time%   expectancy(ATR)   ~option% at target');
  for (const [T, S] of grid) {
    let t = 0, st = 0, ti = 0, exp = 0;
    for (const g of signals) {
      const last = Math.min(365, g.m + holdMin);
      const res = grade(g.r.s, g.m, g.dir, g.entry, g.entry + g.dir * T * g.atr, g.entry - g.dir * S * g.atr, last);
      if (res.out === 'target') { t++; exp += T; }
      else if (res.out === 'stop') { st++; exp -= S; }
      else { ti++; exp += (g.dir * (res.exit - g.entry)) / g.atr; }
    }
    const n = signals.length;
    console.log(`   ${T.toFixed(2)}   ${S.toFixed(2)}  ${String(n).padStart(5)}  ${((100 * t) / n).toFixed(1).padStart(5)}  ${((100 * st) / n).toFixed(1).padStart(6)}  ${((100 * ti) / n).toFixed(1).padStart(6)}      ${(exp / n >= 0 ? '+' : '') + (exp / n).toFixed(3).padStart(6)}          ${optionPctFor(T).toFixed(0)}%`);
  }
}

export { clock };
