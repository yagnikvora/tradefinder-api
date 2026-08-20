import { grade } from './lab.mjs';
import { optionReturn } from './option.mjs';

/**
 * Grade one signal in the instrument actually traded.
 *
 * The stock target/stop decide WHEN the position is closed; the option model decides what that
 * is worth. Time-outs are exited at the close of the hold window, which is where an option
 * buyer's decay actually lands.
 */
export function gradeOption(sig, T, S, holdMin) {
  const last = Math.min(365, sig.m + holdMin);
  const g = grade(sig.r.s, sig.m, sig.dir, sig.entry, sig.entry + sig.dir * T * sig.atr, sig.entry - sig.dir * S * sig.atr, last);
  const held = g.at - sig.m;
  const ret = optionReturn({
    spot: sig.entry, exitSpot: g.exit, atr: sig.atr,
    minutesHeld: held, isCall: sig.dir === 1, won: g.out === 'target',
  });
  return { ...g, held, optRet: ret, mfeAtr: g.mfe / sig.atr, maeAtr: g.mae / sig.atr };
}

export function summarise(name, signals, days, T, S, holdMin) {
  const n = signals.length;
  if (!n) { console.log(`${name.padEnd(46)} no signals`); return null; }
  let t = 0, st = 0, ti = 0, sum = 0, wins = 0;
  const rets = [];
  for (const s of signals) {
    const g = gradeOption(s, T, S, holdMin);
    if (g.out === 'target') t++; else if (g.out === 'stop') st++; else ti++;
    if (g.optRet > 0) wins++;
    sum += g.optRet;
    rets.push(g.optRet);
  }
  rets.sort((a, b) => a - b);
  const avg = sum / n;
  const med = rets[Math.floor(n / 2)];
  const perDay = n / days.length;
  console.log(
    `${name.padEnd(46)} ${String(n).padStart(4)}  ${perDay.toFixed(1).padStart(4)}/d  ` +
    `tgt ${((100 * t) / n).toFixed(0).padStart(3)}%  stop ${((100 * st) / n).toFixed(0).padStart(3)}%  time ${((100 * ti) / n).toFixed(0).padStart(3)}%  ` +
    `| option: profitable ${((100 * wins) / n).toFixed(0).padStart(3)}%  avg ${((100 * avg >= 0 ? '+' : '') + (100 * avg).toFixed(1)).padStart(6)}%  med ${((100 * med >= 0 ? '+' : '') + (100 * med).toFixed(1)).padStart(6)}%`,
  );
  return { n, perDay, hit: t / n, stop: st / n, time: ti / n, optWin: wins / n, avg, med };
}
