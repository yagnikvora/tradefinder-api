// The HTTP surface. An Express Router, mounted at /pullback by `pullback/index.ts`.
//
// Response envelope matches the rest of this API — `{ payload: { data }, status, source }` — so
// the web client's existing `fetchData` works against it unchanged.
//
// `source` is load-bearing and is one of:
//   'upstox' a board from a live scan
//   'stale'  a real board from an earlier scan, re-served because Upstox is unreachable. Carries
//            `note` with its age. NEVER invented data — see `data/snapshot.repository.ts`.
//
// THE ENDPOINTS ARE SPLIT BY QUESTION, NOT BY FILTER, and that is deliberate. `/pullback` is
// browsed; `/pullback/signals` is polled at a much shorter interval; `/pullback/watch` is left
// open on a second monitor. They return different shapes at different cadences, and collapsing
// them into one endpoint with query parameters would force the heaviest payload on the caller
// that polls hardest.

import express, { type Request, type Response } from 'express';
import { tokenSet } from '../upstox.js';
import { marketOpen, istDay } from '../momentum/session.js';
import { cache, single } from '../momentum/cache.js';
import { CANDLE_ENDPOINT } from '../momentum/data/candles.js';
import { breakerState } from '../momentum/data/throttle.js';
import { alertStatus, alerts } from './alerts/alert.engine.js';
import {
  sendTelegram, telegramConfigured, telegramStatus, signalMessage as telegramSignalMessage,
} from './alerts/telegram.js';
import {
  sendDiscord, discordConfigured, discordStatus, signalMessage as discordSignalMessage,
} from './alerts/discord.js';
import { sampleAlert } from './alerts/sample.js';
import { renderBell, sessionBellStatus } from './alerts/session-bell.js';
import { schedulerStatus } from './scheduler.js';
import { backtest } from './backtest/backtest.engine.js';
import { configRepository } from './config/config.repository.js';
import { barsOf, ensureSeed, frameStore, framesFor, readFrames } from './data/frames.js';
import { signalRepository, summarise } from './data/signal.repository.js';
import { ageLabel, snapshotRepository } from './data/snapshot.repository.js';
import { universe } from './data/universe.js';
import { runScan } from './engine/scanner.engine.js';
import {
  applyFilters, isValidationError, parseAlertQuery, parseBacktestRequest, parseBoardQuery,
  parseConfigPatch, parseSymbol, slim,
} from './dto.js';
import type { PullbackBoard, Timeframe } from './types.js';
import { TIMEFRAMES, DEFAULT_CHART_TIMEFRAME } from './types.js';

const BOARD_KEY = 'pullback:board';
/** Once the market is shut the bars are frozen; re-scanning would spend budget for nothing. */
const CLOSED_TTL_MS = 10 * 60_000;

type Source = 'upstox' | 'stale';

const send = <T>(res: Response, data: T, source: Source, note?: string) =>
  res.json({ payload: { data }, status: 'SUCCESS', source, ...(note ? { note } : {}) });

const fail = (res: Response, status: number, message: string, extra?: Record<string, unknown>) =>
  res.status(status).json({ status: 'ERROR', error: message, ...extra });

const NO_TOKEN = 'UPSTOX_ACCESS_TOKEN is not set — put your Upstox Analytics Token in api/.env';

/**
 * The current board, from cache, then a live scan, then the last good one on disk.
 *
 * The scheduler normally fills the cache; this path exists for the first request after a boot and
 * for a deployment running without the scheduler.
 */
async function currentBoard(): Promise<{ board: PullbackBoard; source: Source; note?: string }> {
  const cfg = await configRepository.get();
  const ttl = marketOpen() ? cfg.refresh.scanMs : CLOSED_TTL_MS;

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
 * Both write paths must do this. Without it the API reports the new config version while the
 * board it serves was scanned under the old thresholds — the worst of both, because the screen
 * says the strategy changed and the signals say it did not.
 */
const invalidateBoard = (): Promise<void> => cache.del(BOARD_KEY);

export function pullbackRouter(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // ---------------------------------------------------------------- GET /pullback ----
  router.get('/', async (req: Request, res: Response) => {
    if (!tokenSet()) return fail(res, 503, NO_TOKEN);
    try {
      const cfg = await configRepository.get();
      const q = parseBoardQuery(req.query as Record<string, unknown>, cfg);
      const { board, source, note } = await currentBoard();
      const rows = applyFilters(board.rows, q);

      send(res, {
        ...board,
        matched: rows.length,
        returned: Math.min(rows.length, q.limit),
        rows: rows.slice(0, q.limit).map((r) => (q.includeFrames ? r : slim(r))),
      }, source, note);
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  // -------------------------------------------------------- GET /pullback/signals ----
  //
  // The entry feed: fired signals only, freshest first. Polled rather than browsed, so it carries
  // the smallest useful payload and no per-timeframe indicator blocks.
  //
  // Ordered by AGE, not by confidence, which is the opposite of the board's default. A pullback
  // signal's value decays with every bar — the stop was drawn from a low that is receding — so the
  // most recent entry is the one at the top even when a better-scoring one fired forty minutes ago.
  router.get('/signals', async (req: Request, res: Response) => {
    if (!tokenSet()) return fail(res, 503, NO_TOKEN);
    try {
      const cfg = await configRepository.get();
      const q = parseBoardQuery(req.query as Record<string, unknown>, cfg);
      const { board, source, note } = await currentBoard();

      const rows = applyFilters(board.rows.filter((r) => r.signal !== null), q)
        .sort((a, b) => (b.signal?.firedAt ?? 0) - (a.signal?.firedAt ?? 0));

      const today = await signalRepository.forDay(istDay());

      send(res, {
        asOf: board.asOf,
        configVersion: board.configVersion,
        market: board.market,
        bullishSignals: board.bullishSignals,
        bearishSignals: board.bearishSignals,
        today: summarise(today),
        matched: rows.length,
        returned: Math.min(rows.length, q.limit),
        rows: rows.slice(0, q.limit).map(slim),
        warnings: board.warnings,
      }, source, note);
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  // ---------------------------------------------------------- GET /pullback/watch ----
  //
  // Upcoming pullbacks — rows at or approaching the zone with no confirmation yet. This is the
  // feed that is actually actionable: by the time a confirmation candle has closed, the entry is
  // already a bar old, and a human needs the warning before that.
  router.get('/watch', async (req: Request, res: Response) => {
    if (!tokenSet()) return fail(res, 503, NO_TOKEN);
    try {
      const cfg = await configRepository.get();
      const q = parseBoardQuery(req.query as Record<string, unknown>, cfg);
      const { board, source, note } = await currentBoard();

      const rows = applyFilters(board.rows.filter((r) => r.signal === null && r.watch !== null), q);

      send(res, {
        asOf: board.asOf,
        configVersion: board.configVersion,
        market: board.market,
        watching: board.watching,
        matched: rows.length,
        returned: Math.min(rows.length, q.limit),
        rows: rows.slice(0, q.limit).map(slim),
        warnings: board.warnings,
      }, source, note);
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  // -------------------------------------------------------- GET /pullback/history ----
  // The signal log, with outcomes. `?day=` for an earlier session.
  router.get('/history', async (req: Request, res: Response) => {
    const day = String(req.query.day ?? istDay());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail(res, 400, 'day must be a YYYY-MM-DD date');
    const records = await signalRepository.forDay(day);
    send(res, { day, summary: summarise(records), records }, 'upstox');
  });

  // --------------------------------------------------------- GET /pullback/alerts ----
  //
  // Polled with `?since=<last id timestamp>`, which is deliberately a long-poll-free design: the
  // ring is bounded and in-process, so a client that missed ten minutes asks for ten minutes and
  // gets exactly the events it missed, in order, with no subscription to lose across a restart.
  router.get('/alerts', async (req: Request, res: Response) => {
    const q = parseAlertQuery(req.query as Record<string, unknown>);
    send(res, { events: alerts(q), status: alertStatus() }, 'upstox');
  });

  // --------------------------------------------------------- GET /pullback/config ----
  // Declared before /:symbol, or "config" is parsed as a stock.
  router.get('/config', async (_req, res) => {
    send(res, await configRepository.get(), 'upstox');
  });

  // --------------------------------------------------------- PUT /pullback/config ----
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

  // ------------------------------------------------- POST /pullback/config/reset ----
  router.post('/config/reset', async (req: Request, res: Response) => {
    const by = String(req.header('x-admin-user') ?? 'admin');
    const next = await configRepository.reset(by);
    await invalidateBoard();
    send(res, next, 'upstox');
  });

  // --------------------------------------------------------- GET /pullback/status ----
  router.get('/status', async (_req, res) => {
    const cfg = await configRepository.get();
    const store = frameStore();
    const symbols = [...store.symbols.values()];
    send(res, {
      marketOpen: marketOpen(),
      // Whether the background jobs are actually ticking, and when they last did.
      //
      // `schedulerStatus()` has always existed and was never reported, which left the one question
      // that matters unanswerable from outside: a scanner whose timers never started looks exactly
      // like a market with no setups — both are an empty board and a silent phone. `lastScanAt`
      // going stale during a session is the symptom to watch for.
      scheduler: schedulerStatus(),
      configVersion: cfg.version,
      configUpdatedAt: cfg.updatedAt,
      seed: {
        day: symbols.find((f) => f.seededThrough)?.seededThrough ?? null,
        builtAt: store.seedBuiltAt || null,
        symbols: symbols.filter((f) => f.seededThrough !== null).length,
        caughtUp: symbols.filter((f) => f.caughtUp).length,
        failures: Object.keys(store.seedFailures).length,
      },
      // Surfaced because a tripped breaker is the difference between "the seed is building" and
      // "the seed cannot build for another four minutes", and those look identical from outside.
      rateLimit: breakerState(CANDLE_ENDPOINT),
      alerts: alertStatus(),
      // The 09:15 and 15:30 messages. Carries which of today's bells have already gone out, so a
      // morning with no greeting can be told apart from a morning the process slept through.
      sessionBell: await sessionBellStatus(),
      timeframes: cfg.timeframes,
      refresh: cfg.refresh,
    }, 'upstox');
  });

  // ------------------------------------------------ POST /pullback/alerts/test ----
  //
  // Sends one message to the phone, so the channel can be proved end to end without waiting for a
  // live signal — which, outside market hours, would mean waiting until tomorrow. It bypasses the
  // market-hours gate on purpose: this is a plumbing check, not an alert.
  router.post('/alerts/test', async (req, res) => {
    if (!telegramConfigured() && !discordConfigured())
      return fail(res, 503, 'No phone channel is configured', {
        hint: 'set PULLBACK_TELEGRAM_BOT_TOKEN + PULLBACK_TELEGRAM_CHAT_ID and/or PULLBACK_DISCORD_WEBHOOK_URL in api/.env, then restart the API',
      });

    const cfg = await configRepository.get();
    const t = cfg.alerts.push.trend;

    // `?sample=signal` sends a full entry message instead of the summary — same layout, same
    // renderer, real symbol and real conviction — so the FORMAT can be checked before a session
    // rather than discovered during one. Marked as a sample on its first line.
    let sampleBasis: string | null = null;
    let render: (html: boolean) => string;

    const sample = String(req.query.sample ?? '');
    /** Every sample says so on its first line, so nothing sent from here can be read as real. */
    const banner = (html: boolean, what: string) =>
      html ? `🧪 <b>SAMPLE — ${what}</b>\n\n` : `🧪 **SAMPLE — ${what}**\n\n`;

    if (sample === 'signal') {
      const { signal, trend, basis } = await sampleAlert();
      sampleBasis = basis;
      render = (html) =>
        banner(html, 'not a live signal') +
        (html ? telegramSignalMessage(signal, trend) : discordSignalMessage(signal, trend));
    } else if (sample === 'open' || sample === 'close') {
      // `?sample=open` and `?sample=close` render the session bells exactly as they will go out,
      // today's date and today's quote included. Without this the only way to check either message
      // is to wait for 09:15, and the only way to check an edit to one is to wait until tomorrow.
      sampleBasis = sample === 'open' ? 'the 09:15 good-morning bell' : 'the 15:30 session-closed bell';
      render = (html) => banner(html, 'not the real bell') + renderBell(sample, html);
    } else {
      const lines = (b: (s: string) => string) => [
        `✅ ${b('Trinetra alerts are wired up.')}`,
        '',
        `You will be messaged on: ${b(cfg.alerts.push.kinds.join(', '))}`,
        `Confidence floor: ${b(`${cfg.alerts.push.minBand} or better`)}`,
        t.mode === 'off'
          ? 'Trend-day filter: off — every qualifying setup is sent.'
          : `Trend-day filter: ${b(t.mode)} — the session must be ${b(`${t.minPhase.toLowerCase()} one-sided`)}` +
            `${t.sameDirection ? ' in the same direction' : ''}.`,
        'Only during market hours, 09:15 AM – 03:30 PM IST.',
      ].join('\n');
      render = (html) => lines((s) => (html ? `<b>${s}</b>` : `**${s}**`));
    }

    // Both are attempted even if the first fails — the point of two channels is that they are
    // independent, and a test that stopped at the first failure could not show you that.
    const [tg, dc] = await Promise.all([
      telegramConfigured() ? sendTelegram(render(true)) : Promise.resolve(null),
      discordConfigured() ? sendDiscord(render(false)) : Promise.resolve(null),
    ]);

    const result = {
      ...(sampleBasis ? { sample: sampleBasis } : {}),
      telegram: tg === null ? { skipped: 'not configured' } : { sent: tg, ...telegramStatus() },
      discord: dc === null ? { skipped: 'not configured' } : { sent: dc, ...discordStatus() },
    };
    // Any configured channel failing is a failure: a half-delivered test is exactly the state
    // this endpoint exists to reveal.
    if (tg === false || dc === false) return fail(res, 502, 'A configured channel refused the message', result);
    send(res, result, 'upstox');
  });

  // ~215 upstream requests, so it answers immediately and builds behind the response rather than
  // holding a connection open for the minute or so it takes.
  router.post('/seed/rebuild', async (_req, res) => {
    if (!tokenSet()) return fail(res, 503, NO_TOKEN);
    const cfg = await configRepository.get();
    const uni = await universe(cfg.universe);
    void ensureSeed(uni.members, cfg).catch(() => {});
    send(res, { started: true, symbols: uni.members.length, note: 'building — poll GET /pullback/status for progress' }, 'upstox');
  });

  // ------------------------------------------------------- POST /pullback/scan ----
  router.post('/scan', async (_req, res) => {
    if (!tokenSet()) return fail(res, 503, NO_TOKEN);
    try {
      await invalidateBoard();
      const { board, source, note } = await currentBoard();
      send(res, {
        asOf: board.asOf, scanned: board.scanned, enriched: board.enriched,
        bullishSignals: board.bullishSignals, bearishSignals: board.bearishSignals,
        watching: board.watching,
      }, source, note);
    } catch (e) {
      fail(res, 502, String((e as Error).message));
    }
  });

  // ------------------------------------------------------ POST /pullback/backtest ----
  //
  // Synchronous, because a backtest is a handful of candle requests and the caller wants the
  // answer. The 180-day ceiling in the DTO is what keeps that true.
  router.post('/backtest', async (req: Request, res: Response) => {
    if (!tokenSet()) return fail(res, 503, NO_TOKEN);
    try {
      const cfg = await configRepository.get();
      const request = parseBacktestRequest(req.body, cfg);
      const uni = await universe(cfg.universe);
      const member = uni.bySymbol.get(request.symbol);
      if (!member)
        return fail(res, 404, `${request.symbol} is not in the scanned universe`, {
          hint: 'it must be an F&O stock or one of the configured index underlyings',
        });

      const result = await backtest(request, member.seriesKey, member.lotSize, cfg);
      send(res, result, 'upstox');
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  // -------------------------------------------------------- GET /pullback/:symbol ----
  //
  // The detail view, including the raw bars the chart is drawn from. `?timeframe=` picks which
  // series comes back; every timeframe's indicator read comes back regardless, because the
  // multi-timeframe disagreement is the most useful thing on the page.
  router.get('/:symbol', async (req: Request, res: Response) => {
    if (!tokenSet()) return fail(res, 503, NO_TOKEN);
    try {
      const symbol = parseSymbol(req.params.symbol);
      const cfg = await configRepository.get();
      const uni = await universe(cfg.universe);
      const member = uni.bySymbol.get(symbol);
      if (!member)
        return fail(res, 404, `${symbol} is not in the scanned universe`, {
          hint: 'it must be an F&O stock or one of the configured index underlyings',
        });

      const { board, source, note } = await currentBoard();
      const row = board.rows.find((r) => r.symbol === symbol);

      const requested = Number(req.query.timeframe);
      // Only an explicit `?timeframe=` overrides the default, and it still has to be a frame this
      // config actually computes — otherwise `bars` comes back empty and the page charts nothing.
      const computed = cfg.timeframes.computed;
      const tf: Timeframe = TIMEFRAMES.includes(requested as Timeframe) && computed.includes(requested as Timeframe)
        ? (requested as Timeframe)
        : computed.includes(DEFAULT_CHART_TIMEFRAME)
          ? DEFAULT_CHART_TIMEFRAME
          : (computed[0] ?? cfg.timeframes.signal[0]);

      const f = framesFor(symbol, member.seriesKey);
      const { reads } = readFrames(f, cfg);
      const history = (await signalRepository.forDay(istDay())).filter((r) => r.symbol === symbol);

      send(res, {
        asOf: board.asOf,
        configVersion: board.configVersion,
        market: board.market,
        symbol,
        name: member.name,
        kind: member.kind,
        /**
         * For an index this is the FUTURE, not the spot — the index publishes no volume, so
         * there is no VWAP and no volume gate on the spot series. Said in the payload rather
         * than left to be inferred from prices that are a few points off the index everyone
         * quotes.
         */
        seriesNote: member.kind === 'index'
          ? 'Charted on the near-month future: the index itself publishes no volume, so VWAP and the volume gate are only computable there. Option strikes are on spot.'
          : null,
        timeframe: tf,
        row: row ?? null,
        frames: reads,
        bars: barsOf(f, tf),
        history,
        warnings: board.warnings,
      }, source, note);
    } catch (e) {
      if (isValidationError(e)) return fail(res, 400, e.message, { issues: e.issues });
      fail(res, 502, String((e as Error).message));
    }
  });

  return router;
}
