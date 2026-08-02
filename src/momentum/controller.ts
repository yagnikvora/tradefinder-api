// The HTTP surface. An Express Router, mounted at /momentum by `momentum/index.ts`.
//
// Response envelope matches the rest of this API — `{ payload: { data }, status, source }` —
// so the web client's existing `fetchData` works against it unchanged.
//
// `source` is load-bearing and is one of:
//   'upstox' a board computed from a live scan
//   'stale'  a real board from an earlier scan, re-served because Upstox is unreachable.
//            Carries `note` with its age. NEVER invented data — see snapshot.repository.ts.
//
// There is no mock. A fabricated momentum score is indistinguishable from a real one on
// screen and would be read as a trading signal, which is the one failure this module must
// not have.

import express, { type Request, type Response } from 'express';
import type { MomentumBoard, MomentumRow } from './types.js';
import { configRepository } from './config/config.repository.js';
import { runScan } from './engine/momentum.engine.js';
import { snapshotRepository, ageLabel } from './data/snapshot.repository.js';
import { ensureBaseline, getBaseline } from './data/baseline.js';
import { CANDLE_ENDPOINT } from './data/candles.js';
import { breakerState } from './data/throttle.js';
import { historyRepository } from './data/history.repository.js';
import { scanOnce, schedulerStatus } from './scheduler.js';
import { cache, single } from './cache.js';
import { isValidationError, parseBoardQuery, parseConfigPatch, parseSymbol } from './dto.js';
import { marketOpen } from './session.js';
import { tokenSet } from '../upstox.js';

const BOARD_KEY = 'momentum:board';
/** Once the market is shut the numbers are frozen; re-scanning would spend budget for free. */
const CLOSED_TTL_MS = 10 * 60_000;

type Source = 'upstox' | 'stale';

const send = <T>(res: Response, data: T, source: Source, note?: string) =>
  res.json({ payload: { data }, status: 'SUCCESS', source, ...(note ? { note } : {}) });

const fail = (res: Response, status: number, message: string, extra?: Record<string, unknown>) =>
  res.status(status).json({ status: 'ERROR', error: message, ...extra });

/**
 * The current board, from cache, then a live scan, then the last good one on disk.
 *
 * The scheduler is normally the thing that fills the cache; this path exists for the first
 * request after a boot and for a deployment running without the scheduler.
 */
async function currentBoard(): Promise<{ board: MomentumBoard; source: Source; note?: string }> {
  const cfg = await configRepository.get();
  const ttl = marketOpen() ? cfg.refresh.quoteMs : CLOSED_TTL_MS;

  try {
    const board = await single(BOARD_KEY, ttl, async () => {
      const fresh = await runScan(cfg);
      await snapshotRepository.save(fresh);
      return fresh;
    });
    return { board, source: 'upstox' };
  } catch (e) {
    const last = await snapshotRepository.last();
    if (!last) throw e;
    return {
      board: last.board,
      source: 'stale',
      note: `Upstox unreachable, showing the last live scan (${ageLabel(last.ageMs)} old): ${String((e as Error).message)}`,
    };
  }
}

/**
 * Drop the cached board after a configuration change.
 *
 * Both write paths must do this, and one of them originally did not: after a reset the API
 * reported the new config version while the board it served was still ranked under the old
 * weights, which is the worst of both — the screen says the model changed and the ranking
 * says it did not. Sharing one function is what stops the next endpoint forgetting.
 */
async function invalidateBoard(): Promise<void> {
  await cache.del(BOARD_KEY);
}

/** Rows carry their full eleven-factor breakdown; the list view does not need it. */
const slim = (r: MomentumRow): Omit<MomentumRow, 'factors'> => {
  const { factors: _factors, ...rest } = r;
  return rest;
};

export function momentumRouter(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // ---------------------------------------------------------------- GET /momentum ----
  router.get('/', async (req: Request, res: Response) => {
    if (!tokenSet())
      return fail(res, 503, 'UPSTOX_ACCESS_TOKEN is not set — put your Upstox Analytics Token in api/.env');

    try {
      const cfg = await configRepository.get();
      const q = parseBoardQuery(req.query as Record<string, unknown>, cfg);
      const { board, source, note } = await currentBoard();

      let rows = board.rows.filter((r) => r.score >= q.minScore);
      if (q.direction) rows = rows.filter((r) => r.direction === q.direction);
      if (q.tradeType) rows = rows.filter((r) => r.tradeType === q.tradeType);
      if (q.confidence) rows = rows.filter((r) => r.confidence === q.confidence);
      if (q.sector) rows = rows.filter((r) => (r.sector ?? '').toUpperCase() === q.sector);

      send(
        res,
        {
          ...board,
          returned: Math.min(rows.length, q.limit),
          matched: rows.length,
          rows: rows.slice(0, q.limit).map((r) => (q.includeFactors ? r : slim(r))),
        },
        source,
        note,
      );
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  // --------------------------------------------------------- GET /momentum/config ----
  // Declared before /:symbol, or "config" is parsed as a stock.
  router.get('/config', async (_req, res) => {
    send(res, await configRepository.get(), 'upstox');
  });

  // --------------------------------------------------------- PUT /momentum/config ----
  router.put('/config', async (req: Request, res: Response) => {
    try {
      const patch = parseConfigPatch(req.body);
      const by = String(req.header('x-admin-user') ?? 'admin');
      const next = await configRepository.save(patch, by);
      await invalidateBoard();
      send(res, next, 'upstox');
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 500, String((e as Error).message));
    }
  });

  // ------------------------------------------------------- POST /momentum/config/reset
  router.post('/config/reset', async (req: Request, res: Response) => {
    const by = String(req.header('x-admin-user') ?? 'admin');
    const next = await configRepository.reset(by);
    await invalidateBoard();
    send(res, next, 'upstox');
  });

  // --------------------------------------------------------- GET /momentum/status ----
  router.get('/status', async (_req, res) => {
    const [status, baseline, cfg] = await Promise.all([schedulerStatus(), getBaseline(), configRepository.get()]);
    send(res, {
      ...status,
      marketOpen: marketOpen(),
      // Surfaced because a tripped breaker is the difference between "the baseline is
      // building" and "the baseline cannot build for another four minutes", and those look
      // identical from the outside.
      rateLimit: breakerState(CANDLE_ENDPOINT),
      configVersion: cfg.version,
      configUpdatedAt: cfg.updatedAt,
      shortlistSize: cfg.universe.shortlistSize,
      refresh: cfg.refresh,
      baseline: baseline.baseline
        ? {
            day: baseline.baseline.day,
            stale: baseline.stale,
            symbols: Object.keys(baseline.baseline.symbols).length,
            failures: Object.keys(baseline.baseline.failures).length,
          }
        : null,
    }, 'upstox');
  });

  // ----------------------------------------------- POST /momentum/baseline/rebuild ----
  // ~416 upstream requests, so it answers immediately and builds behind the response
  // rather than holding a connection open for the couple of minutes it takes.
  router.post('/baseline/rebuild', async (_req, res) => {
    const cfg = await configRepository.get();
    void ensureBaseline({
      atrPeriod: cfg.thresholds.atrExpansion.period,
      trendLookback: cfg.thresholds.trendStructure.lookbackSessions,
    }).catch(() => {});
    send(res, { started: true, note: 'building — poll GET /momentum/status for progress' }, 'upstox');
  });

  // --------------------------------------------------- POST /momentum/scan (manual) ----
  router.post('/scan', async (_req, res) => {
    await cache.del(BOARD_KEY);
    await scanOnce();
    const { board, source, note } = await currentBoard();
    send(res, { asOf: board.asOf, scored: board.scored, shortlisted: board.shortlisted }, source, note);
  });

  // -------------------------------------------------------- GET /momentum/:symbol ----
  router.get('/:symbol', async (req: Request, res: Response) => {
    if (!tokenSet())
      return fail(res, 503, 'UPSTOX_ACCESS_TOKEN is not set — put your Upstox Analytics Token in api/.env');

    try {
      const symbol = parseSymbol(req.params.symbol);
      const { board, source, note } = await currentBoard();
      const row = board.rows.find((r) => r.symbol === symbol);

      if (!row)
        return fail(res, 404, `${symbol} is not in the current momentum board`, {
          hint: 'it may be outside the F&O universe, below the configured price/turnover floor, or below minCoverage',
        });

      const history = await historyRepository.forSymbol(symbol);

      send(
        res,
        {
          asOf: board.asOf,
          configVersion: board.configVersion,
          market: board.market,
          row,
          // The score's own trail through past sessions, for the detail page's sparkline.
          history: history.slice(-60).map((h) => ({
            day: h.day, score: h.score, close: h.close, direction: h.direction,
            rvol: h.rvol, atmIv: h.atmIv, hv20: h.hv20,
          })),
          warnings: board.warnings,
        },
        source,
        note,
      );
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  return router;
}
