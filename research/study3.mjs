import { U, FIT, run, report } from './setups.mjs';

const GRID = [[0.30, 0.30], [0.40, 0.35], [0.50, 0.40], [0.60, 0.40], [0.75, 0.50], [1.00, 0.50]];

// --- A. anything that has moved, as a control ------------------------------------------
const anyMove = (s) => {
  if (s.m < 30) return null;
  const dir = s.px > s.vwap ? 1 : -1;
  return { dir };
};

// --- B. gap and go: opens away from yesterday, never gives the gap back -----------------
const gapGo = (s) => {
  const dir = s.gap > 0 ? 1 : -1;
  if (Math.abs(s.gap) < 0.4) return null;
  if (s.m < 25) return null;
  if ((s.px - s.vwap) * dir <= 0) return null;              // still on the gap's side of VWAP
  if (s.crossings > 2) return null;                          // has not been fought over
  if (s.rvol < 1.3) return null;
  const beyondOr = dir === 1 ? s.px > s.orHigh : s.px < s.orLow;
  if (!beyondOr) return null;                                // opening range taken out
  return { dir };
};

// --- C. one-sided from the first bar, entered on the first dip to VWAP ------------------
const vwapDip = (s) => {
  const dir = s.aboveFrac > 0.9 ? 1 : s.aboveFrac < 0.1 ? -1 : 0;
  if (!dir) return null;
  if (s.m < 30) return null;
  if (s.crossings > 1) return null;
  if (s.rvol < 1.3) return null;
  if (s.atrUsed < 0.4) return null;
  const d = ((s.px - s.vwap) / s.atr) * dir;
  if (d < 0 || d > 0.18) return null;                        // price has come back to VWAP
  return { dir };
};

// --- D. prior-day range break on volume -------------------------------------------------
const priorBreak = (s) => {
  const up = s.px > s.prevHigh, dn = s.px < s.prevLow;
  if (!up && !dn) return null;
  const dir = up ? 1 : -1;
  if (s.m < 25) return null;
  if (s.rvol < 1.5) return null;
  if ((s.px - s.vwap) * dir <= 0) return null;
  return { dir };
};

// --- E. the current engine's shape, for comparison: fresh extreme, high pulse ------------
const chaseExtreme = (s) => {
  if (s.m < 25) return null;
  const dir = s.px >= s.dayHigh - 1e-9 ? 1 : s.px <= s.dayLow + 1e-9 ? -1 : 0;
  if (!dir) return null;
  if (s.rvol < 1.5) return null;
  if ((s.px - s.vwap) * dir <= 0) return null;
  return { dir };
};

// --- F. mean reversion from a stretched move -------------------------------------------
const stretched = (s) => {
  if (s.m < 30) return null;
  const d = (s.px - s.vwap) / s.atr;
  if (Math.abs(d) < 0.6) return null;
  return { dir: d > 0 ? -1 : 1 };                            // fade it
};

const tests = [
  ['A · control: anything above/below VWAP', anyMove],
  ['B · gap and go', gapGo],
  ['C · one-sided day, first dip to VWAP', vwapDip],
  ['D · prior-day range break on volume', priorBreak],
  ['E · chase the fresh session extreme (what the engine does today)', chaseExtreme],
  ['F · fade a stretch of 0.6+ ATR from VWAP', stretched],
];

for (const [name, fn] of tests) report(name, run(fn, FIT), FIT, GRID);
