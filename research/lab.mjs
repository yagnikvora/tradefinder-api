// Strategy research harness.
//
// Loads the cached 1-minute universe once, derives every per-minute reading a rule could want,
// and grades every candidate the same way. Nothing here talks to Upstox: the data pull is
// fetch-minutes.ts, run once.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = join(HERE, 'data', 'min');
const DAILY = join(HERE, '..', '.cache', 'momentum', 'daily_bars.json');
const DAILY_REAL = join(HERE, 'data', 'daily-real.json');

const istDay = (secs) => new Date(secs * 1000 + 330 * 60000).toISOString().slice(0, 10);

/**
 * Daily bars, preferring Upstox's own over anything synthesised.
 *
 * The first version of this study had the cached daily history stopping several sessions short of
 * the window, and filled the gap by deriving a daily bar from each 1-minute session. That is not
 * the same number: the synthesised close is the 15:29 minute close and the official one is the
 * closing-auction print. Measured on 2026-08-20 the resulting ATR differed by a median 1.3% and
 * by up to 17% on individual names — enough to move a reading across a threshold and delete a
 * signal. Since every gate in the rule is ATR-scaled, the study now reads the same bars the
 * production baseline does, fetched by `fetch-daily.ts`.
 */
function loadDaily() {
  const out = new Map();
  if (existsSync(DAILY_REAL)) {
    const real = JSON.parse(readFileSync(DAILY_REAL, 'utf8')).symbols;
    for (const [sym, bars] of Object.entries(real))
      out.set(sym, bars.map((b) => ({ day: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] || 0 })));
    return out;
  }
  const raw = JSON.parse(readFileSync(DAILY, 'utf8')).symbols;
  for (const [sym, rec] of Object.entries(raw)) {
    out.set(sym, (rec.bars || []).map((b) => ({
      day: istDay(b[0]), open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] || 0,
    })));
  }
  return out;
}

// Wilder ATR over completed daily bars, the same definition baseline.ts uses.
function wilderAtr(bars, period) {
  if (bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], c = bars[i];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr /= period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

const OR_MIN = 15;

function session(bars) {
  const n = 375;
  const close = new Float64Array(n), high = new Float64Array(n), low = new Float64Array(n);
  const vol = new Float64Array(n), vwap = new Float64Array(n), cumVol = new Float64Array(n);
  const dayHigh = new Float64Array(n), dayLow = new Float64Array(n);
  const byMin = new Map(bars.map((b) => [b[0], b]));
  let pv = 0, cv = 0, hi = -Infinity, lo = Infinity, last = null;
  for (let m = 0; m < n; m++) {
    const b = byMin.get(m);
    if (b) {
      last = b;
      pv += ((b[2] + b[3] + b[4]) / 3) * b[5];
      cv += b[5];
      hi = Math.max(hi, b[2]);
      lo = Math.min(lo, b[3]);
    }
    if (!last) { close[m] = NaN; high[m] = NaN; low[m] = NaN; vwap[m] = NaN; dayHigh[m] = NaN; dayLow[m] = NaN; continue; }
    close[m] = b ? b[4] : last[4];
    high[m] = b ? b[2] : last[4];
    low[m] = b ? b[3] : last[4];
    vol[m] = b ? b[5] : 0;
    cumVol[m] = cv; dayHigh[m] = hi; dayLow[m] = lo;
    vwap[m] = cv > 0 ? pv / cv : close[m];
  }
  let orHigh = -Infinity, orLow = Infinity;
  for (const b of bars) if (b[0] < OR_MIN) { orHigh = Math.max(orHigh, b[2]); orLow = Math.min(orLow, b[3]); }
  return { close, high, low, vol, vwap, cumVol, dayHigh, dayLow, open: bars.length ? bars[0][1] : NaN, orHigh, orLow, bars: bars.length };
}

export function loadUniverse(opts) {
  const minPrior = (opts && opts.minPriorSessions) || 8;
  const dailyBySym = loadDaily();
  const files = readdirSync(MIN).filter((f) => f.endsWith('.json'));
  const byDay = new Map();
  let nifty = null;

  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(MIN, f), 'utf8'));
    const sym = raw.symbol;
    const days = Object.keys(raw.days).sort();
    const sessions = new Map();
    for (const d of days) sessions.set(d, session(raw.days[d]));
    if (sym === '_NIFTY') { nifty = { days, sessions }; continue; }

    const daily = dailyBySym.get(sym) || [];
    const haveDaily = new Set(daily.map((b) => b.day));

    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      if (i < minPrior) continue;
      const s = sessions.get(day);
      if (!s || s.bars < 300) continue;

      const hist = daily.filter((b) => b.day < day).slice(-45);
      // Only ever fills a genuine hole in the real series. See loadDaily for why a synthesised
      // bar is a last resort rather than a convenience.
      for (let j = 0; j < i; j++) {
        const d2 = days[j];
        if (haveDaily.has(d2)) continue;
        const s2 = sessions.get(d2);
        if (s2 && s2.bars > 100) hist.push({ day: d2, open: s2.open, high: s2.dayHigh[374], low: s2.dayLow[374], close: s2.close[374], volume: s2.cumVol[374] });
      }
      hist.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      const uniq = [];
      for (const b of hist) if (!uniq.length || uniq[uniq.length - 1].day !== b.day) uniq.push(b);
      const atr = wilderAtr(uniq, 14);
      const prev = uniq[uniq.length - 1];
      if (!atr || !prev || !(atr > 0)) continue;

      const priors = days.slice(Math.max(0, i - 20), i).map((d) => sessions.get(d)).filter((x) => x && x.bars > 300);
      if (priors.length < minPrior) continue;
      const profile = new Float64Array(375);
      for (let m = 0; m < 375; m++) {
        const arr = priors.map((p) => p.cumVol[m]).sort((a, b) => a - b);
        profile[m] = arr[Math.floor(arr.length / 2)] || 1;
      }
      const turn = priors.map((p) => (p.close[374] * p.cumVol[374]) / 1e7).sort((a, b) => a - b);
      const medTurnoverCr = turn[Math.floor(turn.length / 2)] || 0;

      let bucket = byDay.get(day);
      if (!bucket) byDay.set(day, (bucket = new Map()));
      bucket.set(sym, { symbol: sym, day, s, atr, prev, profile, medTurnoverCr });
    }
  }
  const days = Array.from(byDay.keys()).sort();
  return { byDay, nifty, days };
}

// Both levels breached inside one minute counts as the STOP: a 1-minute bar cannot say which
// came first, and grading it the other way is how a backtest invents an edge it does not have.
export function grade(s, m, dir, entry, targetPx, stopPx, lastMin) {
  const end = lastMin === undefined ? 359 : lastMin;
  let mfe = 0, mae = 0;
  for (let k = m + 1; k <= end; k++) {
    const h = s.high[k], l = s.low[k];
    if (!Number.isFinite(h)) continue;
    mfe = Math.max(mfe, dir === 1 ? h - entry : entry - l);
    mae = Math.max(mae, dir === 1 ? entry - l : h - entry);
    if (dir === 1 ? l <= stopPx : h >= stopPx) return { out: 'stop', at: k, mfe, mae, exit: stopPx };
    if (dir === 1 ? h >= targetPx : l <= targetPx) return { out: 'target', at: k, mfe, mae, exit: targetPx };
  }
  return { out: 'time', at: end, mfe, mae, exit: s.close[end] };
}

export const clock = (m) => {
  const t = 555 + m;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
};
