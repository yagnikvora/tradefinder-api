// Entering the break versus entering the rest, graded on the option.
import { U, FIT, run, state } from './setups.mjs';
import { summarise } from './grade-option.mjs';

// Shared "this is a real move" filter, from study4's lift table.
const bigDay = (s) => s.rvol >= 2.0 && s.atrUsed >= 0.7;

const dirOf = (s) => (s.px > s.vwap ? 1 : -1);

const breakEntry = (s) => {
  if (s.m < 25) return null;
  if (!bigDay(s)) return null;
  const dir = dirOf(s);
  if (((s.px - s.open) / s.atr) * dir < 0.5) return null;
  const atExtreme = dir === 1 ? s.px >= s.dayHigh - 1e-9 : s.px <= s.dayLow + 1e-9;
  if (!atExtreme) return null;
  return { dir };
};

function restEntry(minOff, maxOff, needTurn) {
  return (s, r) => {
    if (s.m < 25) return null;
    if (!bigDay(s)) return null;
    const dir = dirOf(s);
    if (((s.px - s.open) / s.atr) * dir < 0.5) return null;
    const off = (dir === 1 ? s.dayHigh - s.px : s.px - s.dayLow) / s.atr;
    if (off < minOff || off > maxOff) return null;
    if (needTurn) {
      const back = r.s.close[s.m - 3];
      if (!Number.isFinite(back)) return null;
      if ((s.px - back) * dir <= 0) return null;             // the dip has stopped dipping
    }
    return { dir };
  };
}

const GRIDS = [[0.4, 0.35], [0.5, 0.4], [0.6, 0.45], [0.75, 0.5], [1.0, 0.6]];

for (const [T, S] of GRIDS) {
  console.log(`\n=== target ${T} ATR / stop ${S} ATR / hold to 15:15 ===`);
  summarise('break: enter at the fresh extreme', run(breakEntry, FIT), FIT, T, S, 999);
  summarise('rest: 0.15-0.60 ATR off extreme', run(restEntry(0.15, 0.6, false), FIT), FIT, T, S, 999);
  summarise('rest + turning back', run(restEntry(0.15, 0.6, true), FIT), FIT, T, S, 999);
  summarise('deeper rest 0.3-0.8 + turning', run(restEntry(0.3, 0.8, true), FIT), FIT, T, S, 999);
}
