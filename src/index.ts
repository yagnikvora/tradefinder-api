// TradeFinder API — Express + TypeScript.
// Mirrors the real /api_be/* endpoints, backed by live NSE data with mock fallback.
import './env.js'; // must precede anything that reads process.env
import express from 'express';
import cors from 'cors';
import * as svc from './services.js';
import { overview } from './overview.js';
import * as clock from './clock.js';
import * as apex from './apex.js';
import { isTimeframe } from './candles.js';
import { mountMomentum } from './momentum/index.js';
import type { Result } from './services.js';

const app = express();
const PORT = Number(process.env.PORT) || 4100;
app.use(cors());

// Momentum Scanner, Trend Day, and the phone alerts. Self-contained under src/momentum — its own
// controller, services, repositories, config and cron. Mounting is one line because everything it
// needs from this app (the Upstox client, the instrument master) it imports directly.
//
// Its scheduler also drives the platform-level alerts in `src/alerts/`: the trend-day confirmation
// signals and the 09:15 / 15:30 session bells. Those used to hang off the EMA Pullback Scanner's
// cron, and moved here when that module was removed — it was the only other scheduler in the app.
//
// The scheduler is off without a token: its jobs would otherwise fail every 30 seconds on a
// clone that has not been configured, filling the log with the same error. Note the session bells
// are the exception inside it — they need no token and ring regardless.
//
// VIEWER MODE. `npm run viewer` passes --viewer and turns the scheduler off, which is how the
// reading machine runs: it serves the trade journal out of the shared database and never scans.
// Without it, an API booted at 22:00 finds a baseline that is not today's and immediately spends
// ~416 candle requests rebuilding one nobody is going to look at.
const viewer = process.argv.includes('--viewer');
mountMomentum(app, {
  path: '/momentum',
  scheduler: !viewer && process.env.MOMENTUM_SCHEDULER !== 'off',
});
if (viewer) console.log('viewer mode — scheduler off, serving stored records only');

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

/**
 * Every async route goes through here, and that is not tidiness.
 *
 * Express 4 does not catch a rejected async handler — the rejection is simply unhandled, and
 * Node has exited the process on that since v15. So one Upstox timeout eight layers down
 * (overview -> allQuotes -> call -> fetch) took the whole API off the air, killing the
 * scanners and every other page with it. Answering 502 for the one endpoint that failed is
 * the entire difference.
 *
 * Option data additionally has no mock: a fabricated OI ladder is indistinguishable from a
 * real one at a glance and would be read as a trading signal. Better to say it's unavailable.
 */
const serve = async <T>(req: express.Request, res: express.Response, run: () => Promise<Result<T>>) => {
  try { send(res, await run()); }
  catch (e) {
    const message = String((e as Error)?.message ?? e);
    console.error(`[api] ${req.method} ${req.originalUrl} -> ${message}`);
    if (!res.headersSent) res.status(502).json({ status: 'ERROR', error: message });
  }
};

app.get('/api_be/servertime', (_req, res) => res.json({ payload: { data: String(Date.now()) }, status: 'SUCCESS' }));
app.get('/api_be/data/overview', async (q, res) => serve(q, res, () => cached('ov', 15e3, overview)));
app.get('/api_be/data/market_pulse', async (q, res) => serve(q, res, () => cached('mp', 15e3, svc.marketPulse)));
app.get('/api_be/data/sector_scope', async (q, res) => serve(q, res, () => cached('ss', 60e3, svc.sectorScope)));
// Kept after the /index-mover PAGE was removed, because it is not only that page's endpoint:
// Option Apex embeds a point-contribution panel that reads it (see web/lib/apex.ts). Deleting
// it would not have thrown anything — that panel catches its own failure and renders as
// absent — so the symptom would have been Option Apex quietly losing a section.
app.get('/api_be/data/order/indice_point_movement', async (req, res) => {
  const idx = String(req.query.index || 'NIFTY 50');
  await serve(req, res, () => cached('im:' + idx, 60e3, () => svc.indexMover(idx)));
});

// ---- Option Clock ----
// The real endpoints take their parameters as base64-encoded JSON in ?data=, e.g.
// {"script":"NIFTY 50","exp":"07Jul26"} — mirrored here so the payloads line up too.
function params(q: unknown): Record<string, string> {
  try {
    const j = JSON.parse(Buffer.from(String(q ?? ''), 'base64').toString('utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

// Served by clock.ts, which reads the OI ladder — including its history through the
// session — straight from Upstox. The payload shapes are unchanged from when this was
// backed by NSE plus a local recording.
app.get('/api_be/index_analysis/get_running_expiry', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT } = params(req.query.data);
  await serve(req, res, () => cached('exp:' + script, 300e3, () => clock.runningExpiry(script)));
});

// Trading days the picker offers, newest first.
app.get('/api_be/index_analysis/trading_days', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp } = params(req.query.data);
  await serve(req, res, () => cached(`days:${script}:${exp}`, 60e3, () => clock.availableDays(script, exp)));
});

app.get('/api_be/index_analysis/live_oi', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, day } = params(req.query.data);
  await serve(req, res, () => cached(`oi:${script}:${exp}:${day ?? ''}`, 30e3, () => clock.liveOi(script, exp, day)));
});

// PCR through the session at a fixed step (default 10 minutes) — the trend table.
app.get('/api_be/index_analysis/pcr_series', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, step, day } = params(req.query.data);
  const every = Number(step) || 600;
  await serve(req, res, () =>
    cached(`pcr:${script}:${exp}:${every}:${day ?? ''}`, 30e3, () => clock.pcrSeries(script, exp, every, day)));
});

app.get('/api_be/index_analysis/index_analysis', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, ts1, ts2, day } = params(req.query.data);
  // 0 means "whole session"; clock.ts clamps a window wider than the day to its ends, so
  // the default needs no date of its own — which keeps it right when the day the session
  // resolves to isn't today's date.
  const from = Number(ts1) || 0;
  const to = Number(ts2) || Number.MAX_SAFE_INTEGER;
  await serve(req, res, () =>
    cached(`ia:${script}:${exp}:${from}:${to}:${day ?? ''}`, 30e3, () => clock.indexAnalysis(script, exp, from, to, day)));
});

// ---- Option Apex ----
// Same ?data= base64 convention, under the real page's money_flux namespace. The expiry
// list is the identical call the clock makes, mirrored here because the real site serves
// it under both namespaces and the page shouldn't have to know that.
app.get('/api_be/money_flux/get_running_expiry', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT } = params(req.query.data);
  await serve(req, res, () => cached('exp:' + script, 300e3, () => clock.runningExpiry(script)));
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
  await serve(req, res, () => cached(`ch:${script}:${iv}`, 30e3, () => apex.chart(script, iv, exp)));
});

app.get('/api_be/money_flux/op_histogram', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, tf: t, day } = params(req.query.data);
  const iv = tf(t);
  await serve(req, res, () => cached(`fx:${script}:${exp ?? ''}:${iv}:${day ?? ''}`, 30e3, () => apex.flux(script, exp, iv, day)));
});

app.get('/api_be/money_flux/op_dial', async (req, res) => {
  const { script = clock.DEFAULT_SCRIPT, exp, tf: t, day } = params(req.query.data);
  const iv = tf(t);
  await serve(req, res, () =>
    cached(`dl:${script}:${exp ?? ''}:${iv}:${day ?? ''}`, 30e3, () => apex.dial(script, exp, day, iv)));
});

app.get('/health', (_q, res) => res.json({ ok: true }));

// Diagnostics: how many trading days of volume history we've backfilled for RVOL.
app.get('/health/volume', async (_q, res) => {
  const { historyDepth, avgDailyVolumes, volumeBaselineStatus } = await import('./volume.js');
  const avg = await avgDailyVolumes();
  res.json({
    ok: true,
    historyDays: await historyDepth(),
    symbolsWithAvg: Object.keys(avg).length,
    // This rebuild shares the `/v3/historical-candle` budget with the morning ATR baseline, and
    // used to spend it silently. `lastFailure` is the field to read when the momentum baseline
    // reports a 429 it cannot explain.
    baseline: volumeBaselineStatus(),
  });
});


// A backstop, not a strategy: every route above already turns a failure into a 502. This
// catches what no route can — a rejection from a background job (the two schedulers, a
// fire-and-forget snapshot write) — because Node's default for an unhandled rejection is to
// exit, and a market-data server going dark is a far worse outcome than a logged error.
process.on('unhandledRejection', (e) => console.error('[api] unhandled rejection:', e));

/**
 * WHICH INTERFACE THE API ANSWERS ON, and why the default is loopback rather than 0.0.0.0.
 *
 * `app.listen(PORT)` binds every interface. On a laptop that is harmless; on a public host it
 * publishes an API that has no authentication of any kind — `app.use(cors())` above is open to
 * every origin — and nine of its routes MUTATE. `POST /momentum/baseline/rebuild` spends ~416
 * Upstox candle requests per call against a 2000-per-30-minute budget, so a stranger with curl
 * can empty the quota that the 08:00 baseline build needs; `PATCH /momentum/journal/:id` and
 * `POST /momentum/journal/settle` edit the one record in this app that cannot be rebuilt.
 *
 * Binding to 127.0.0.1 costs nothing here because NOTHING REACHES THIS DIRECTLY. Every consumer
 * is server-side: the Next pages import `lib/api.ts` from server components, and `lib/proxy.ts`
 * exists so the browser polls the web app's own origin instead of this port. So the deployment is
 * nginx -> Next (3000) -> here (4100) over loopback, and only nginx is ever public.
 *
 * HOST is still an env var rather than a constant: a container needs 0.0.0.0 to be reachable from
 * outside its namespace, and that is a legitimate setup. It is opt-in because the safe choice
 * should be the one you get by forgetting to make a choice.
 */
const HOST = process.env.HOST || '127.0.0.1';

/**
 * A NAMED PIPE IN `PORT`, which is how IIS hands a Node app its socket.
 *
 * Under iisnode — Plesk on Windows, and IIS generally — `process.env.PORT` is not a number. It is
 * a pipe path like `\\.\pipe\5f3a...`, and IIS is already listening on the other end of it. Two
 * things then go wrong with the plain numeric path above, and both fail QUIETLY:
 *
 *   `Number('\\\\.\\pipe\\...')` is NaN, so `Number(...) || 4100` falls back to 4100 and the
 *   process binds a TCP port nothing is connected to. The app logs a clean startup line and IIS
 *   answers 500 for every request, because the pipe it is waiting on never got a listener.
 *
 *   `listen(path, host)` is not a valid overload. A pipe has no interface to bind, so the host
 *   argument has to be omitted rather than passed as loopback.
 *
 * Hence the branch: if PORT is set and is not a finite number, treat it as a pipe and listen on it
 * directly. Everything else — a laptop, a VPS, a container — is unchanged.
 */
const rawPort = process.env.PORT ?? '';
const isPipe = rawPort !== '' && !Number.isFinite(Number(rawPort));

if (isPipe) {
  app.listen(rawPort, () => console.log(`\n  Trinetra API  →  ${rawPort} (iisnode)\n`));
} else {
  app.listen(PORT, HOST, () => console.log(`\n  Trinetra API  →  http://${HOST}:${PORT}\n`));
}
