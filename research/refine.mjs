import { U, FIT, state } from './setups.mjs';
import { bs, ivFromAtr } from './option.mjs';

const TD = 12, COST = 0.025;

export function collect(days, F) {
  const perDay = new Map();
  for (const day of days) {
    const found = [];
    for (const r of U.byDay.get(day).values()) {
      if (r.medTurnoverCr < F.turn) continue;
      for (let m = F.from; m <= F.to; m++) {
        const s = state(r, m);
        if (!s) continue;
        const dir = s.px > s.vwap ? 1 : -1;
        if (s.rvol < F.rvol || s.atrUsed < F.range) continue;
        if (((s.px - s.open) / s.atr) * dir < F.open) continue;
        const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
        if (off > F.maxOff) continue;
        const em = m + 1;                                  // one full minute to get filled
        const entry = r.s.close[em];
        if (!Number.isFinite(entry) || entry <= 0) break;
        found.push({ day, symbol: r.symbol, signalMin: m, m: em, dir, entry, atr: r.atr, r, s, rvol: s.rvol });
        break;
      }
    }
    // Cap the day at the strongest N by relative volume, so a market-wide morning cannot put
    // twenty positions on at once.
    found.sort((a, b) => b.rvol - a.rvol);
    perDay.set(day, found.slice(0, F.maxPerDay));
  }
  return [].concat(...[...perDay.values()]);
}

export function optionExit(sig, tpPct, slPct, cost = COST, lastMin = 365) {
  const iv = ivFromAtr(sig.atr, sig.entry);
  const isCall = sig.dir === 1;
  const e0 = bs(sig.entry, sig.entry, iv, TD / 252, isCall).price;
  if (!(e0 > 0)) return null;
  const paid = e0 * (1 + cost);
  for (let k = sig.m + 1; k <= lastMin; k++) {
    const yr = Math.max(0, (TD - (k - sig.m) / 375) / 252);
    const adverse = isCall ? sig.r.s.low[k] : sig.r.s.high[k];
    const favour = isCall ? sig.r.s.high[k] : sig.r.s.low[k];
    if (!Number.isFinite(adverse)) continue;
    if ((bs(adverse, sig.entry, iv, yr, isCall).price * (1 - cost) - paid) / paid <= -slPct)
      return { ret: -slPct, at: k, out: 'stop' };
    if ((bs(favour, sig.entry, iv * 0.96, yr, isCall).price * (1 - cost) - paid) / paid >= tpPct)
      return { ret: tpPct, at: k, out: 'target' };
  }
  const yr = Math.max(0, (TD - (lastMin - sig.m) / 375) / 252);
  const v = bs(sig.r.s.close[lastMin], sig.entry, iv, yr, isCall).price * (1 - cost);
  return { ret: (v - paid) / paid, at: lastMin, out: 'close' };
}

export const stat = (res) => {
  const n = res.length;
  if (!n) return { n: 0, avg: 0, win: 0, hit: 0, stop: 0, tot: 0 };
  const sum = res.reduce((a, r) => a + r.ret, 0);
  return {
    n, avg: sum / n, tot: sum,
    win: res.filter((r) => r.ret > 0).length / n,
    hit: res.filter((r) => r.out === 'target').length / n,
    stop: res.filter((r) => r.out === 'stop').length / n,
  };
};

if (process.argv[1].endsWith('refine.mjs')) {
  const BASE = { turn: 40, from: 12, to: 45, rvol: 6, range: 1.0, open: 0.6, maxOff: 0.25, maxPerDay: 99 };

  console.log('A. TURNOVER FLOOR — the option has to be quotable');
  console.log('   floor     n   /day  hit%  profitable%   avg');
  for (const turn of [40, 80, 150, 300]) {
    const s = collect(FIT, { ...BASE, turn });
    const t = stat(s.map((x) => optionExit(x, 0.5, 0.4)).filter(Boolean));
    console.log(`   ${String(turn + 'cr').padEnd(7)} ${String(t.n).padStart(4)}  ${(t.n / FIT.length).toFixed(1).padStart(4)}  ${(100 * t.hit).toFixed(0).padStart(3)}%     ${(100 * t.win).toFixed(0).padStart(4)}%    ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`);
  }

  console.log('\nB. DAILY CAP — take only the strongest N of the morning');
  console.log('   cap       n   /day  hit%  profitable%   avg');
  for (const maxPerDay of [1, 2, 3, 4, 5, 99]) {
    const s = collect(FIT, { ...BASE, turn: 80, maxPerDay });
    const t = stat(s.map((x) => optionExit(x, 0.5, 0.4)).filter(Boolean));
    console.log(`   ${String(maxPerDay === 99 ? 'none' : maxPerDay).padEnd(7)} ${String(t.n).padStart(4)}  ${(t.n / FIT.length).toFixed(1).padStart(4)}  ${(100 * t.hit).toFixed(0).padStart(3)}%     ${(100 * t.win).toFixed(0).padStart(4)}%    ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%`);
  }

  console.log('\nC. THE EXIT PAIR, on the final entry rule (turnover 80cr, best 4 a day)');
  console.log('   take-profit  stop     n   /day  hit-target%  stopped%  profitable%    avg     total');
  const sig = collect(FIT, { ...BASE, turn: 80, maxPerDay: 4 });
  for (const [tp, sl] of [[0.15, 0.25], [0.20, 0.25], [0.20, 0.30], [0.25, 0.30], [0.30, 0.30],
                          [0.35, 0.35], [0.40, 0.35], [0.50, 0.40], [0.60, 0.45], [0.80, 0.50]]) {
    const t = stat(sig.map((x) => optionExit(x, tp, sl)).filter(Boolean));
    console.log(`   +${(100 * tp).toFixed(0).padStart(3)}%      −${(100 * sl).toFixed(0).padStart(3)}%  ${String(t.n).padStart(4)}  ${(t.n / FIT.length).toFixed(1).padStart(4)}     ${(100 * t.hit).toFixed(0).padStart(3)}%      ${(100 * t.stop).toFixed(0).padStart(3)}%       ${(100 * t.win).toFixed(0).padStart(3)}%     ${((100 * t.avg >= 0 ? '+' : '') + (100 * t.avg).toFixed(1)).padStart(6)}%  ${((100 * t.tot >= 0 ? '+' : '') + (100 * t.tot).toFixed(0)).padStart(6)}%`);
  }
}
