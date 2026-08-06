// The alert engine — five events, and a hard rule about not repeating them.
//
// The brief asks for alerts on a fresh pullback, a trend resuming, an EMA rejection, a target
// hit and a stop hit. Four of those are derivable from one scan; `trendResume` and the two
// outcome events need to know what the PREVIOUS scan said, which is why this file holds state
// and the rest of the engine does not.
//
//   freshPullback  a row has just entered `AtZone` — price has reached the band and the turn has
//                  not happened yet. THE MOST USEFUL ALERT HERE, and the earliest: it fires
//                  before the confirmation candle, which is the only point at which a human has
//                  time to look at the chart before the entry is gone.
//   trendResume    a signal fired. The confirmation printed on volume.
//   emaRejection   a row that WAS at the zone has closed through it. The pullback failed, and
//                  anyone who entered on the touch is now wrong.
//   targetHit      \ from the outcome tracker, on the live price rather than on a bar close,
//   stopHit        / because that is how the order would have filled.
//
// DEDUPE IS NOT OPTIONAL AND IS THE HARDEST PART. The scan runs every thirty seconds and a row
// stays `AtZone` for up to eight bars — on a 15-minute chart that is two hours, or 240 scans. A
// naive implementation sends 240 identical alerts for one setup, and the immediate consequence
// is that the user turns alerts off, which costs them the one alert that mattered. So an event is
// keyed by symbol, timeframe, kind and DIRECTION, and suppressed for `dedupeMin` — and phase
// transitions are tracked so `freshPullback` fires on the ENTRY into the state rather than on the
// state being true.
//
// THE WEBHOOK IS FIRE-AND-FORGET, deliberately. An alert channel that can fail must never be
// able to fail the scan: a webhook host that hangs would hold the scan open past its own
// interval, the next tick would overlap it, and the request budget would double. Failures are
// counted and reported on `/pullback/status` rather than thrown.

import type {
  AlertEvent, AlertKind, PullbackConfig, PullbackRow, PullbackSignal, SignalRecord, Timeframe,
} from '../types.js';
import { ALERT_LABEL, TIMEFRAME_LABEL } from '../types.js';

/** The ring, newest last. Bounded by `alerts.keep`. */
let ring: AlertEvent[] = [];
/** Dedupe memory: `symbol|tf|kind|dir` -> when it last fired. */
const lastSent = new Map<string, number>();
/** Phase memory, so an alert can fire on a TRANSITION rather than on a state. */
const lastPhase = new Map<string, string>();

let seq = 0;
let webhookFailures = 0;
let lastWebhookError: string | null = null;

const key = (symbol: string, tf: Timeframe, kind: AlertKind, dir: 1 | -1): string =>
  `${symbol}|${tf}|${kind}|${dir}`;

const phaseKey = (symbol: string, tf: Timeframe): string => `${symbol}|${tf}`;

function emit(
  cfg: PullbackConfig,
  e: Omit<AlertEvent, 'id'>,
  dir: 1 | -1,
): AlertEvent | null {
  if (!cfg.alerts.enabled || !cfg.alerts.kinds.includes(e.kind)) return null;

  const k = key(e.symbol, e.timeframe, e.kind, dir);
  const prev = lastSent.get(k);
  if (prev !== undefined && e.at - prev < cfg.alerts.dedupeMin * 60_000) return null;
  lastSent.set(k, e.at);

  const event: AlertEvent = { ...e, id: `${e.at}-${++seq}` };
  ring.push(event);
  if (ring.length > cfg.alerts.keep) ring.splice(0, ring.length - cfg.alerts.keep);

  void post(cfg, event);
  return event;
}

/** POST the event, never throwing. A dead webhook must not be able to slow the scan. */
async function post(cfg: PullbackConfig, event: AlertEvent): Promise<void> {
  if (!cfg.alerts.webhookUrl) return;
  try {
    const res = await fetch(cfg.alerts.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`webhook -> ${res.status}`);
  } catch (e) {
    webhookFailures++;
    lastWebhookError = String((e as Error).message);
  }
}

const dirWord = (d: 1 | -1): string => (d === 1 ? 'long' : 'short');

/**
 * Fold one scan's rows into alerts.
 *
 * Called once per scan with the finished board. Returns only the events that were actually
 * emitted — the dedupe and the phase-transition tests swallow most of what is passed in, which
 * is the point.
 */
export function fromRows(rows: PullbackRow[], cfg: PullbackConfig, nowMs: number): AlertEvent[] {
  const out: AlertEvent[] = [];

  for (const row of rows) {
    for (const tfStr of Object.keys(row.pullbacks)) {
      const tf = Number(tfStr) as Timeframe;
      const pb = row.pullbacks[tf];
      if (!pb || pb.direction === 0) continue;

      const pk = phaseKey(row.symbol, tf);
      const previous = lastPhase.get(pk);
      lastPhase.set(pk, pb.phase);
      const entered = previous !== undefined && previous !== pb.phase;
      const dir = pb.direction as 1 | -1;

      // Fresh pullback: fires on ENTERING the zone, not on being in it. A row can sit at the
      // zone for eight bars, and alerting on the state rather than the transition is how one
      // setup becomes 240 notifications.
      if (pb.phase === 'AtZone' && (entered || previous === undefined)) {
        const trend = row.trends[tf];
        const e = emit(cfg, {
          kind: 'freshPullback',
          at: nowMs,
          symbol: row.symbol,
          timeframe: tf,
          direction: dir,
          price: row.price,
          title: `${row.symbol} — pullback to the ${pb.touch.nearest === 'vwap' ? 'VWAP' : pb.touch.nearest === 'ema9' ? '9 EMA' : '20 EMA'} on ${TIMEFRAME_LABEL[tf]}`,
          detail:
            `${dirWord(dir)} setup forming. Retraced ${((pb.retracement ?? 0) * 100).toFixed(0)}% ` +
            `(${(pb.depthAtr ?? 0).toFixed(2)} ATR) into the zone. ` +
            `${trend ? `Trend strength ${trend.strength}/100. ` : ''}Waiting for a ${dir === 1 ? 'bullish' : 'bearish'} candle on volume.`,
          signalId: null,
          score: row.watch?.score.total ?? null,
        }, dir);
        if (e) out.push(e);
      }

      // EMA rejection: it WAS at the zone and has closed through it. Gated on the previous phase
      // so a stock that was never at the zone — one that simply broke down from an impulse —
      // does not produce a rejection alert for a level it never tested.
      if (pb.phase === 'Failed' && (previous === 'AtZone' || previous === 'Resuming')) {
        const e = emit(cfg, {
          kind: 'emaRejection',
          at: nowMs,
          symbol: row.symbol,
          timeframe: tf,
          direction: dir,
          price: row.price,
          title: `${row.symbol} — rejected at the EMA zone on ${TIMEFRAME_LABEL[tf]}`,
          detail: `${pb.note ?? 'the pullback failed'}. Anyone filled on the touch is now on the wrong side of the structure.`,
          signalId: null,
          score: null,
        }, dir);
        if (e) out.push(e);
      }
    }
  }

  return out;
}

/** A fired signal. Separate from `fromRows` because it carries the plan and the contract. */
export function fromSignal(signal: PullbackSignal, cfg: PullbackConfig, nowMs: number): AlertEvent | null {
  return emit(cfg, {
    kind: 'trendResume',
    at: nowMs,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    price: signal.entry,
    title: `${signal.symbol} ${signal.side} — ${signal.score.band.toLowerCase()} pullback entry on ${TIMEFRAME_LABEL[signal.timeframe]}`,
    detail:
      `Confidence ${signal.score.total.toFixed(0)}/100. Entry ${signal.entry.toFixed(2)}, ` +
      `stop ${signal.stop.recommended.price.toFixed(2)} (${signal.stop.recommended.kind}), ` +
      `target ${signal.target.primary.price.toFixed(2)} at ${signal.target.rewardRisk.toFixed(2)}R` +
      (signal.option ? `. ${signal.option.label} at ₹${signal.option.entryCost.toFixed(2)}, delta ${Math.abs(signal.option.delta).toFixed(2)}` : '') +
      '.',
    signalId: signal.id,
    score: signal.score.total,
  }, signal.direction);
}

/** A settled outcome, from the tracker. */
export function fromOutcome(record: SignalRecord, cfg: PullbackConfig, nowMs: number): AlertEvent | null {
  if (record.outcome.state !== 'TargetHit' && record.outcome.state !== 'StopHit') return null;
  const kind: AlertKind = record.outcome.state === 'TargetHit' ? 'targetHit' : 'stopHit';
  const level = record.outcome.state === 'TargetHit' ? record.target : record.stop;

  return emit(cfg, {
    kind,
    at: nowMs,
    symbol: record.symbol,
    timeframe: record.timeframe,
    direction: record.direction,
    price: level,
    title: `${record.symbol} — ${ALERT_LABEL[kind].toLowerCase()} at ${level.toFixed(2)}`,
    detail:
      `${record.direction === 1 ? 'Long' : 'Short'} from ${record.entry.toFixed(2)} on ` +
      `${TIMEFRAME_LABEL[record.timeframe]}, ${record.outcome.r?.toFixed(2) ?? '?'}R` +
      (record.outcome.note ? `. ${record.outcome.note}` : '.'),
    signalId: record.id,
    score: record.score,
  }, record.direction);
}

/** The feed, newest first. `since` returns only events after that timestamp. */
export function alerts(opts: { since?: number; kind?: AlertKind | null; limit?: number } = {}): AlertEvent[] {
  let out = [...ring].reverse();
  if (opts.since !== undefined) out = out.filter((e) => e.at > (opts.since as number));
  if (opts.kind) out = out.filter((e) => e.kind === opts.kind);
  return out.slice(0, opts.limit ?? 100);
}

export const alertStatus = (): { held: number; webhookFailures: number; lastWebhookError: string | null } => ({
  held: ring.length,
  webhookFailures,
  lastWebhookError,
});

/** Test seam, and what the day roll calls so yesterday's phases cannot fire today's alerts. */
export const resetAlerts = (): void => {
  ring = [];
  lastSent.clear();
  lastPhase.clear();
  webhookFailures = 0;
  lastWebhookError = null;
};
