// TradeFinder API — Express + TypeScript.
// Mirrors the real /api_be/* endpoints, backed by live NSE data with mock fallback.
import express from 'express';
import cors from 'cors';
import * as svc from './services.js';
import type { Result } from './services.js';

const app = express();
const PORT = Number(process.env.PORT) || 4100;
app.use(cors());

// 60s in-memory cache so we don't hammer NSE.
const cache = new Map<string, { t: number; v: unknown }>();
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v as T;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
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

app.get('/health', (_q, res) => res.json({ ok: true }));

// Diagnostics: how many trading days of volume history we've backfilled for RVOL.
app.get('/health/volume', async (_q, res) => {
  const { historyDepth, avgDailyVolumes } = await import('./volume.js');
  const avg = await avgDailyVolumes();
  res.json({ ok: true, historyDays: await historyDepth(), symbolsWithAvg: Object.keys(avg).length });
});

app.listen(PORT, () => console.log(`\n  TradeFinder API  →  http://localhost:${PORT}\n`));
