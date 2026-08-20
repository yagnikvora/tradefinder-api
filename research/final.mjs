// The finished rule, its scale-out exit, and the signal list for any set of days.

import { U, state } from './setups.mjs';
import { bs, ivFromAtr } from './option.mjs';

const TD = 12, COST = 0.025;

export const RULE = {
  turn: 100,        // median daily turnover, crore — the option has to be quotable
  from: 12, to: 45, // scan 09:27 to 10:00 only
  rvol: 5,          // trading at 5x its own normal volume for that time of day
  range: 1.0,       // a full normal day's range already made, before 10:00
  open: 0.5,        // at least half an ATR of displacement from the open, in the trade's direction
  maxOff: 0.35,     // still within a third of an ATR of the day's extreme
  maxPerDay: 4,
};

export function scan(days) {
  const out = [];
  for (const day of days) {
    const found = [];
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < RULE.turn) continue;
      for (let m = RULE.from; m <= RULE.to; m++) {
        const s = state(r, m);
        if (!s) continue;
        const dir = s.px > s.vwap ? 1 : -1;
        if (s.rvol < RULE.rvol || s.atrUsed < RULE.range) continue;
        const disp = ((s.px - s.open) / s.atr) * dir;
        if (disp < RULE.open) continue;
        const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
        if (off > RULE.maxOff) continue;
        const entry = r.s.close[m + 1];
        if (!Number.isFinite(entry) || entry <= 0) break;
        found.push({
          day, symbol: r.symbol, signalMin: m, m: m + 1, dir, entry, atr: r.atr, r, s,
          rvol: s.rvol, atrUsed: s.atrUsed, disp, off,
          strike: Math.round(entry / strikeStep(entry)) * strikeStep(entry),
        });
        break;
      }
    }
    found.sort((a, b) => b.rvol - a.rvol);
    out.push(...found.slice(0, RULE.maxPerDay));
  }
  return out;
}

function strikeStep(px) {
  if (px < 100) return 2.5;
  if (px < 250) return 5;
  if (px < 500) return 10;
  if (px < 1000) return 20;
  if (px < 2500) return 50;
  return 100;
}

/** Option value at a given spot and elapsed minutes, net of one side's cost. */
function val(sig, spot, mins, iv) {
  const yr = Math.max(0, (TD - mins / 375) / 252);
  return bs(spot, sig.entry, iv, yr, sig.dir === 1).price;
}

/**
 * Scale-out exit: half off at +TP1, stop to breakeven on the rest, the rest runs to TP2 or the
 * close. Adverse side of each minute is tested first, so a bar that could have done either is
 * always resolved against the trade.
 */
export function scaleExit(sig, tp1 = 0.30, tp2 = 0.80, sl = 0.50, lastMin = 365) {
  const iv = ivFromAtr(sig.atr, sig.entry);
  const paid = val(sig, sig.entry, 0, iv) * (1 + COST);
  if (!(paid > 0)) return null;
  let half = null, realised = 0, stop = sl;
  for (let k = sig.m + 1; k <= lastMin; k++) {
    const lo = sig.dir === 1 ? sig.r.s.low[k] : sig.r.s.high[k];
    const hi = sig.dir === 1 ? sig.r.s.high[k] : sig.r.s.low[k];
    if (!Number.isFinite(lo)) continue;
    const mins = k - sig.m;
    const down = (val(sig, lo, mins, iv) * (1 - COST) - paid) / paid;
    const up = (val(sig, hi, mins, iv) * (1 - COST) - paid) / paid;
    if (down <= -stop) {
      const rest = half === null ? 1 : 0.5;
      return { ret: realised + rest * -stop, at: k, out: half === null ? 'stop' : 'breakeven', tookHalf: half !== null };
    }
    if (half === null && up >= tp1) { half = k; realised = 0.5 * tp1; stop = 0; }
    else if (half !== null && up >= tp2) return { ret: realised + 0.5 * tp2, at: k, out: 'target', tookHalf: true };
  }
  const mins = lastMin - sig.m;
  const close = (val(sig, sig.r.s.close[lastMin], mins, iv) * (1 - COST) - paid) / paid;
  const rest = half === null ? 1 : 0.5;
  return { ret: realised + rest * close, at: lastMin, out: 'close', tookHalf: half !== null };
}

export function report(label, days) {
  const sigs = scan(days);
  const res = sigs.map((s) => ({ s, r: scaleExit(s) })).filter((x) => x.r);
  const n = res.length;
  if (!n) { console.log(`${label}: no signals`); return null; }
  const rets = res.map((x) => x.r.ret);
  const avg = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - avg) ** 2, 0) / Math.max(1, n - 1));
  const t = avg / (sd / Math.sqrt(n));
  const prof = rets.filter((r) => r > 0).length / n;
  const tookHalf = res.filter((x) => x.r.tookHalf).length / n;
  const full = res.filter((x) => x.r.out === 'target').length / n;
  const stopped = res.filter((x) => x.r.out === 'stop').length / n;
  console.log(
    `${label.padEnd(26)} ${String(days.length).padStart(2)}d  ${String(n).padStart(3)} signals (${(n / days.length).toFixed(1)}/d)  ` +
    `first target ${(100 * tookHalf).toFixed(0).padStart(3)}%  full ${(100 * full).toFixed(0).padStart(3)}%  stopped ${(100 * stopped).toFixed(0).padStart(3)}%  ` +
    `profitable ${(100 * prof).toFixed(0).padStart(3)}%  avg ${((100 * avg >= 0 ? '+' : '') + (100 * avg).toFixed(1)).padStart(6)}%  t ${t.toFixed(2)}`,
  );
  return { sigs, res, avg, prof, tookHalf, n };
}

if (process.argv[1].endsWith('final.mjs')) {
  const ALL = U.days;
  const EARLY = ALL.filter((d) => d < '2026-07-30');
  const LATE = ALL.filter((d) => d >= '2026-07-30' && d < '2026-08-19');
  const HOLD = ALL.filter((d) => d >= '2026-08-19');
  console.log('Scale-out: half off at +30% on the option, stop to breakeven, rest to +80% or 15:15. Initial stop −50%.\n');
  report('all 35 sessions', ALL);
  report('  first half (unseen)', EARLY);
  report('  second half', LATE);
  report('  19-20 Aug holdout', HOLD);

  console.log('\nexit variants, all 35 sessions');
  for (const [tp1, tp2, sl] of [[0.25, 0.60, 0.40], [0.30, 0.80, 0.50], [0.30, 1.00, 0.50], [0.40, 1.00, 0.50], [0.35, 0.80, 0.45]]) {
    const sigs = scan(ALL);
    const rets = sigs.map((s) => scaleExit(s, tp1, tp2, sl)).filter(Boolean);
    const n = rets.length;
    const avg = rets.reduce((a, b) => a + b.ret, 0) / n;
    const prof = rets.filter((r) => r.ret > 0).length / n;
    const th = rets.filter((r) => r.tookHalf).length / n;
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r.ret - avg) ** 2, 0) / (n - 1));
    console.log(`  +${(100 * tp1).toFixed(0)}% then +${(100 * tp2).toFixed(0)}%, stop −${(100 * sl).toFixed(0)}%   first target ${(100 * th).toFixed(0)}%  profitable ${(100 * prof).toFixed(0)}%  avg ${((100 * avg >= 0 ? '+' : '') + (100 * avg).toFixed(1))}%  t ${(avg / (sd / Math.sqrt(n))).toFixed(2)}`);
  }
}
