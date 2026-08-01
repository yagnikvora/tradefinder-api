// TradeFinder API — Express + TypeScript.
// Mirrors the real /api_be/* endpoints, backed by live NSE data with mock fallback.
import './env.js'; // must precede anything that reads process.env
import express from 'express';
import cors from 'cors';
import * as svc from './services.js';
import * as clock from './clock.js';
import * as apex from './apex.js';
import { isTimeframe } from './candles.js';
import type { Result } from './services.js';

const app = express();
const PORT = Number(process.env.PORT) || 4100;
app.use(cors());

// In-memory cache so we don't hammer NSE. Every avoidable upstream hit is another
// chance to be tarpitted and drop to a fallback, so the window widens once the market
// shuts and the numbers stop moving. A result that had to fall back is held only
// briefly, so the next request retries NSE rather than serving it for the full window.
const CLOSED_TTL = 10 * 60e3;
const FALLBACK_TTL = 20e3;

const cache = new Map<string, { until: number; open: boolean; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, ttl: number, fn: () => Promise<Result<T>>): Promise<Result<T>> {
  const open = svc.marketOpen();
  const hit = cache.get(key);
  // Drop the entry when the session opens or closes, so a long closed-market window
  // can't keep serving yesterday's board into the first minutes of trading.
  if (hit && hit.open === open && Date.now() < hit.until) return hit.v as Result<T>;

  // Collapse concurrent misses onto one upstream call: a page render and its prefetch
  // land together, and duplicate bursts are exactly what gets us rate-limited.
  const pending = inflight.get(key);
  if (pending) return pending as Promise<Result<T>>;

  const p = (async () => {
    const v = await fn();
    const window = v.error ? FALLBACK_TTL : open ? ttl : Math.max(ttl, CLOSED_TTL);
    cache.set(key, { until: Date.now() + window, open, v });
    return v;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

const send = <T>(res: express.Response, r: Result<T>) =>
  res.json({ payload: { data: r.data }, status: 'SUCCESS', source: r.source, ...(r.error ? { note: r.error } : {}) });

app.get('/api_be/servertime', (_req, res) => res.json({ payload: { data: String(Date.now()) }, status: 'SUCCESS' }));
app.get('/api_be/data/market_pulse', async (_q, res) => send(res, await cached('mp', 15e3, svc.marketPulse)));
app.get('/api_be/data/sector_scope', async (_q, res) => send(res, await cached('ss', 60e3, svc.sectorScope)));
app.get('/api_be/data/swing_spectrum', async (_q, res) => send(res, await cached('sw', 60e3, svc.swing)));
app.get('/api_be/data/insider_stratergy', async (_q, res) => send(res, await cached('in', 60e3, svc.insider)));
app.get('/api_be/data/order/indice_point_movement', async (req, res) => {
  const idx = String(req.query.index || 'NIFTY 50');
  send(res, await cached('im:' + idx, 60e3, () => svc.indexMover(idx)));
});
app.get('/api_be/fii_dii_delivery/fetch_fii_dii_data', async (_q, res) => send(res, await cached('fd', 300e3, svc.fiiDii)));

// ---- Option Clock ----
// The real endpoints take their parameters as base64-encoded JSON in ?data=, e.g.
// {"script":"NIFTY 50","exp":"07Jul26"} — mirrored here so the payloads line up too.
function params(q: unknown): Record<string, string> {
  try {
    const j = JSON.parse(Buffer.from(String(q ?? ''), 'base64').toString('utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

// Option data has no mock: a fabricated OI ladder is indistinguishable from a real one
// at a glance and would be read as a trading signal. Better to say it's unavailable.
const sendOi = async <T>(res: express.Response, run: () => Promise<Result<T>>) => {
  try { send(res, await run()); }
  catch (e) { res.status(502).json({ status: 'ERROR', error: String((e as Error).message) }); }
};

// Served by clock.ts, which reads the OI ladder — including its history through the
// session — straight from Upstox. The payload shapes are unchanged from when this was
// backed by NSE plus a local recording.
app.get('/api_be/index_analysis/get_running_expiry', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT } = params(req.query.data);
  await sendOi(res, () => cached('exp:' + script, 300e3, () => clock.runningExpiry(script)));
});

// Trading days the picker offers, newest first.
app.get('/api_be/index_analysis/trading_days', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp } = params(req.query.data);
  await sendOi(res, () => cached(`days:${script}:${exp}`, 60e3, () => clock.availableDays(script, exp)));
});

app.get('/api_be/index_analysis/live_oi', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, day } = params(req.query.data);
  await sendOi(res, () => cached(`oi:${script}:${exp}:${day ?? ''}`, 30e3, () => clock.liveOi(script, exp, day)));
});

// PCR through the session at a fixed step (default 10 minutes) — the trend table.
app.get('/api_be/index_analysis/pcr_series', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, step, day } = params(req.query.data);
  const every = Number(step) || 600;
  await sendOi(res, () =>
    cached(`pcr:${script}:${exp}:${every}:${day ?? ''}`, 30e3, () => clock.pcrSeries(script, exp, every, day)));
});

app.get('/api_be/index_analysis/index_analysis', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, ts1, ts2, day } = params(req.query.data);
  // 0 means "whole session"; clock.ts clamps a window wider than the day to its ends, so
  // the default needs no date of its own — which keeps it right when the day the session
  // resolves to isn't today's date.
  const from = Number(ts1) || 0;
  const to = Number(ts2) || Number.MAX_SAFE_INTEGER;
  await sendOi(res, () =>
    cached(`ia:${script}:${exp}:${from}:${to}:${day ?? ''}`, 30e3, () => clock.indexAnalysis(script, exp, from, to, day)));
});

// ---- Option Apex ----
// Same ?data= base64 convention, under the real page's money_flux namespace. The expiry
// list is the identical call the clock makes, mirrored here because the real site serves
// it under both namespaces and the page shouldn't have to know that.
app.get('/api_be/money_flux/get_running_expiry', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT } = params(req.query.data);
  await sendOi(res, () => cached('exp:' + script, 300e3, () => clock.runningExpiry(script)));
});

// Timeframe in minutes, off the page's Time selector. Anything unrecognised falls back
// to the real page's own default rather than erroring the chart out.
const tf = (v: unknown): apex.Timeframe => {
  const n = Number(v);
  return isTimeframe(n) ? n : 3;
};

app.get('/api_be/money_flux/chart', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, tf: t } = params(req.query.data);
  const iv = tf(t);
  await sendOi(res, () => cached(`ch:${script}:${iv}`, 30e3, () => apex.chart(script, iv, exp)));
});

app.get('/api_be/money_flux/op_histogram', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, tf: t, day } = params(req.query.data);
  const iv = tf(t);
  await sendOi(res, () => cached(`fx:${script}:${exp ?? ''}:${iv}:${day ?? ''}`, 30e3, () => apex.flux(script, exp, iv, day)));
});

app.get('/api_be/money_flux/op_dial', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, tf: t, day } = params(req.query.data);
  const iv = tf(t);
  await sendOi(res, () =>
    cached(`dl:${script}:${exp ?? ''}:${iv}:${day ?? ''}`, 30e3, () => apex.dial(script, exp, day, iv)));
});

app.get('/health', (_q, res) => res.json({ ok: true }));

// Diagnostics: how many trading days of volume history we've backfilled for RVOL.
app.get('/health/volume', async (_q, res) => {
  const { historyDepth, avgDailyVolumes } = await import('./volume.js');
  const avg = await avgDailyVolumes();
  res.json({ ok: true, historyDays: await historyDepth(), symbolsWithAvg: Object.keys(avg).length });
});


app.listen(PORT, () => console.log(`\n  TradeFinder API  →  http://localhost:${PORT}\n`));
