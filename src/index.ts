// TradeFinder API — Express + TypeScript.
// Mirrors the real /api_be/* endpoints, backed by live NSE data with mock fallback.
import express from 'express';
import cors from 'cors';
import * as svc from './services.js';
import * as oi from './oiclock.js';
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
app.get('/api_be/index_analysis/option', async (req, res) => {
  const sym = String(req.query.symbol || 'NIFTY');
  send(res, await cached('opt:' + sym, 60e3, () => svc.optionAnalysis(sym)));
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

app.get('/api_be/index_analysis/get_running_expiry', async (req, res) => {
  const { script = oi.DEFAULT_SCRIPT } = params(req.query.data);
  await sendOi(res, () => cached('exp:' + script, 300e3, () => oi.runningExpiry(script)));
});

app.get('/api_be/index_analysis/live_oi', async (req, res) => {
  const { script = oi.DEFAULT_SCRIPT, exp } = params(req.query.data);
  await sendOi(res, () => cached(`oi:${script}:${exp}`, 30e3, () => oi.liveOi(script, exp)));
});

// PCR through the session at a fixed step (default 10 minutes) — the trend table.
app.get('/api_be/index_analysis/pcr_series', async (req, res) => {
  const { script = oi.DEFAULT_SCRIPT, exp, step } = params(req.query.data);
  const every = Number(step) || 600;
  await sendOi(res, () => cached(`pcr:${script}:${exp}:${every}`, 30e3, () => oi.pcrSeries(script, exp, every)));
});

app.get('/api_be/index_analysis/index_analysis', async (req, res) => {
  const { script = oi.DEFAULT_SCRIPT, exp, ts1, ts2 } = params(req.query.data);
  const from = Number(ts1) || oi.sessionOpenEpoch();
  const to = Number(ts2) || oi.sessionCloseEpoch();
  await sendOi(res, () =>
    cached(`ia:${script}:${exp}:${from}:${to}`, 30e3, () => oi.indexAnalysis(script, exp, from, to)));
});

app.get('/health', (_q, res) => res.json({ ok: true }));

// Diagnostics: how many trading days of volume history we've backfilled for RVOL.
app.get('/health/volume', async (_q, res) => {
  const { historyDepth, avgDailyVolumes } = await import('./volume.js');
  const avg = await avgDailyVolumes();
  res.json({ ok: true, historyDays: await historyDepth(), symbolsWithAvg: Object.keys(avg).length });
});

// Option Clock's PCR trend is a time series, and NSE only ever serves "right now" — so
// the session is taped on a timer rather than only when a page happens to be open.
// Matches oistore's five-minute slot, and does nothing outside market hours because the
// numbers are frozen then.
const RECORD_MS = 5 * 60e3;
setInterval(() => { if (svc.marketOpen()) void oi.recordActive(); }, RECORD_MS).unref();

app.listen(PORT, () => console.log(`\n  TradeFinder API  →  http://localhost:${PORT}\n`));
