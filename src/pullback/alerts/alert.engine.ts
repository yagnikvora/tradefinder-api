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
  AlertEvent, AlertKind, ConfidenceBand, PullbackConfig, PullbackRow, PullbackSignal, SignalRecord,
  Timeframe, TrendContext,
} from '../types.js';
import { ALERT_LABEL, TIMEFRAME_LABEL } from '../types.js';
import { marketOpen } from '../../momentum/session.js';
import { trendContextStatus, trendFor } from '../data/trend-context.js';
import * as telegram from './telegram.js';
import * as discord from './discord.js';

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

/**
 * Confidence bands, weakest first — so "Strong or better" is an index comparison rather than four
 * hand-written cases that have to be kept in step with the band names.
 */
const BAND_ORDER: ConfidenceBand[] = ['Weak', 'Medium', 'Strong', 'Excellent'];

/** The band a score falls in, read against the SAME cutoffs the scorer used. */
const bandOf = (score: number, b: PullbackConfig['score']['bands']): ConfidenceBand =>
  score >= b.excellent ? 'Excellent' : score >= b.strong ? 'Strong' : score >= b.medium ? 'Medium' : 'Weak';

/* ------------------------------------------------------------------ the trend gate --- */

/** Why a push was held back, counted so a quiet channel can always be explained. */
const suppressed = { total: 0, wrongWay: 0, notOneSided: 0, tooWeak: 0, unknown: 0 };
let passedUnknown = 0;

const PHASE_RANK: Record<string, number> = { None: 0, Faded: 0, Forming: 1, Confirmed: 2 };

export interface TrendVerdict {
  /** Whether the push may go out. */
  ok: boolean;
  trend: TrendContext | null;
  /** Null when it agreed; otherwise the reason, in the words the message and status use. */
  reason: 'wrongWay' | 'notOneSided' | 'tooWeak' | 'unknown' | null;
}

/**
 * Does the session agree with this entry?
 *
 * The order of the tests is the order they matter in. Direction first: an entry taken AGAINST a
 * confirmed one-sided day is the worst row this gate can catch, and it is worse than an entry on
 * a stock with no trend at all — so it is separated in the counters rather than folded into a
 * single "no confluence" bucket that would hide it.
 */
export function trendVerdict(cfg: PullbackConfig, symbol: string, dir: 1 | -1, nowMs: number): TrendVerdict {
  const t = cfg.alerts.push?.trend;
  if (!t || t.mode === 'off') return { ok: true, trend: null, reason: null };

  const trend = trendFor(symbol, t.maxBoardAgeSec, nowMs);
  if (!trend) return { ok: t.allowWhenUnknown, trend: null, reason: 'unknown' };

  // `annotate` still computes the verdict — the message wants it — but never blocks.
  const blocking = t.mode === 'require';

  if (t.sameDirection && trend.direction !== 0 && trend.direction !== dir)
    return { ok: !blocking, trend, reason: 'wrongWay' };

  if (PHASE_RANK[trend.phase] < PHASE_RANK[t.minPhase])
    return { ok: !blocking, trend, reason: 'notOneSided' };

  // A same-direction phase with no displacement behind it: rare, since the phase machine already
  // gates on that, but the floor is here for anyone who wants to raise the bar past the phase.
  if (t.minScore > 0 && trend.score < t.minScore)
    return { ok: !blocking, trend, reason: 'tooWeak' };

  return { ok: true, trend, reason: null };
}

/** Whether this event has earned an interruption. Deliberately stricter than the in-app feed. */
function passesPush(cfg: PullbackConfig, e: AlertEvent, verdict: TrendVerdict): boolean {
  const p = cfg.alerts.push;
  if (!p?.enabled || !p.kinds.includes(e.kind)) return false;
  // No score means nothing to judge, and "unknown confidence" is not "high confidence".
  if (e.score == null) return false;
  if (BAND_ORDER.indexOf(bandOf(e.score, cfg.score.bands)) < BAND_ORDER.indexOf(p.minBand)) return false;

  if (!verdict.ok) {
    suppressed.total++;
    if (verdict.reason) suppressed[verdict.reason]++;
    return false;
  }
  // Counted separately: a push that only passed because the session was not measurable is not
  // the filtered alert the user thinks they configured, and a run of them means the momentum
  // scanner has stopped rather than that every setup happened to be confluent.
  if (verdict.reason === 'unknown') passedUnknown++;
  return true;
}

function emit(
  cfg: PullbackConfig,
  e: Omit<AlertEvent, 'id'>,
  dir: 1 | -1,
  /**
   * The signal behind this event, when there is one. Carried rather than a pre-rendered string
   * because each channel renders it in its own markup — and because the phone message needs the
   * option contract and the per-lot figures, which the `AlertEvent` does not hold.
   */
  signal?: PullbackSignal,
): AlertEvent | null {
  if (!cfg.alerts.enabled || !cfg.alerts.kinds.includes(e.kind)) return null;

  // NOTHING IS ALERTED OUTSIDE MARKET HOURS, and this is the single point that guarantees it.
  //
  // The scheduler already gates its scans on `marketOpen`, but it is not the only thing that
  // scans: `currentBoard()` runs a full scan on demand for any HTTP request whose cached board has
  // expired, at any hour. So opening the scanner page at 10pm ran a scan, and because phase memory
  // is per-process, a scan after a restart sees `previous === undefined` for every row and treats
  // the entire board's resting state as a fresh transition. That fired one alert per row at once,
  // six hours after the close — harmless in a strip you can scroll past, and the fastest possible
  // way to get a phone channel muted.
  //
  // Gating on the event's own timestamp rather than on the caller means no future call path can
  // reintroduce it.
  if (!marketOpen(e.at)) return null;

  const k = key(e.symbol, e.timeframe, e.kind, dir);
  const prev = lastSent.get(k);
  if (prev !== undefined && e.at - prev < cfg.alerts.dedupeMin * 60_000) return null;
  lastSent.set(k, e.at);

  // Read once and carried, so the feed, the webhook, the phone message and the suppression
  // counters can never disagree about what the session was doing when this fired.
  const verdict = trendVerdict(cfg, e.symbol, dir, e.at);

  const event: AlertEvent = { ...e, id: `${e.at}-${++seq}`, trend: verdict.trend };
  ring.push(event);
  if (ring.length > cfg.alerts.keep) ring.splice(0, ring.length - cfg.alerts.keep);

  void post(cfg, event);
  if (passesPush(cfg, event, verdict)) void pushAll(event, signal);
  return event;
}

/**
 * Fan the event out to every configured phone channel.
 *
 * Each renders the SAME content in its own markup, and each is awaited only by its own catch — one
 * channel being down or slow must not stop the other from delivering. That redundancy is the whole
 * reason for having two: a single channel that fails silently is a missed trade you never hear
 * about, and both have to fail together for that to happen now.
 */
function pushAll(event: AlertEvent, signal?: PullbackSignal): void {
  const trend = event.trend ?? null;
  if (telegram.telegramConfigured())
    void telegram.sendTelegram(signal ? telegram.signalMessage(signal, trend) : telegram.eventMessage(event));
  if (discord.discordConfigured())
    void discord.sendDiscord(
      signal ? discord.signalMessage(signal, trend) : discord.eventMessage(event),
      event.direction,
    );
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
    // The phone gets the full trade — contract, cost per lot, and what a lot makes or loses —
    // because the whole point of the notification is to be actionable without opening the app.
  }, signal.direction, signal);
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

export const alertStatus = () => ({
  held: ring.length,
  webhookFailures,
  lastWebhookError,
  // The trend gate, in the open. A drop in alerts should always be explainable as a number
  // here rather than as a suspicion that the channel broke — and `passedUnknown` climbing is
  // how you find out the momentum scanner stopped without the phone going silent to tell you.
  trendGate: {
    ...suppressed,
    passedUnknown,
    context: trendContextStatus(),
  },
  // A push channel that has quietly stopped working looks exactly like a quiet market, so its
  // health is reported rather than left to be inferred from an absence of notifications.
  telegram: telegram.telegramStatus(),
  discord: discord.discordStatus(),
});

/** Test seam, and what the day roll calls so yesterday's phases cannot fire today's alerts. */
export const resetAlerts = (): void => {
  ring = [];
  lastSent.clear();
  lastPhase.clear();
  webhookFailures = 0;
  lastWebhookError = null;
  suppressed.total = 0;
  suppressed.wrongWay = 0;
  suppressed.notOneSided = 0;
  suppressed.tooWeak = 0;
  suppressed.unknown = 0;
  passedUnknown = 0;
};
