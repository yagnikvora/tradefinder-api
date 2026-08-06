// Fired signals — the log, the cooldown's memory, and the outcome tracker.
//
// This exists for three jobs that all need the same records and would otherwise each keep their
// own copy:
//
//   THE COOLDOWN needs to know when this symbol/timeframe last fired. Without persistence a
//   restart would re-fire every signal already given, which on a trend day is four alerts for
//   one trade.
//
//   THE OUTCOME TRACKER needs the entry, stop and target of every open signal so the live price
//   can be tested against them. Target-hit and stop-hit alerts are impossible without it, and
//   so is any honest statement about how the scanner actually did today.
//
//   THE HISTORY TABLE is the same records, read.
//
// A SIGNAL IS TRACKED WITH ITS RECOMMENDED STOP, NOT ITS TIGHTEST. Whichever stop
// `risk.service.ts` recommended is the one an outcome is measured against, because that is the
// trade that was published. Tracking against the ATR stop when the plan named the swing stop
// would report a stop-out on a trade nobody was in.
//
// TOUCH, NOT CLOSE. A target or stop is hit when the live price REACHES it, not when a bar
// closes past it. That is how the order would have filled, and it is the conservative reading
// for the stop and the optimistic one for the target — so the two errors point in opposite
// directions and the tracker cannot be systematically flattering. What it cannot know is which
// came first inside one poll interval when both were touched; that case is resolved as the STOP,
// which is the assumption that never overstates a result.

import { istDay } from '../../momentum/session.js';
import { store } from '../../momentum/store.js';
import { PULLBACK_KEYS } from '../config/config.repository.js';
import { realisedR } from '../engine/risk.service.js';
import type { PullbackSignal, SignalRecord, SignalOutcome, Timeframe } from '../types.js';

/** Sessions of signal history kept. Enough for a month of review without unbounded growth. */
const MAX_DAYS = 40;

interface SignalFile {
  /** day -> id -> record. Keyed by id so a re-scan of the same confirmation replaces it. */
  byDay: Record<string, Record<string, SignalRecord>>;
}

export interface SignalRepository {
  /** Every signal for a day, oldest first. Today by default. */
  forDay(day?: string): Promise<SignalRecord[]>;
  /** Signals still open, across days — a position held over lunch is still open at 14:00. */
  open(): Promise<SignalRecord[]>;
  /** Record a fired signal. Idempotent on `id`. */
  record(signal: PullbackSignal, nowMs?: number): Promise<SignalRecord>;
  /** When this symbol/timeframe last fired, for the cooldown. Null when it has not. */
  lastFiredAt(symbol: string, timeframe: Timeframe): Promise<number | null>;
  /** Advance every open signal against the live price. Returns the ones that just settled. */
  settle(prices: Map<string, number>, nowMs?: number): Promise<SignalRecord[]>;
}

export class StoredSignalRepository implements SignalRepository {
  private mem: SignalFile | null = null;
  private loading: Promise<SignalFile> | null = null;
  private dirty = false;
  private flushing: Promise<void> | null = null;

  private async load(): Promise<SignalFile> {
    if (this.mem) return this.mem;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.mem = (await store.read<SignalFile>(PULLBACK_KEYS.signals)) ?? { byDay: {} };
      return this.mem;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async forDay(day = istDay()): Promise<SignalRecord[]> {
    const f = await this.load();
    return Object.values(f.byDay[day] ?? {}).sort((a, b) => a.firedAt - b.firedAt);
  }

  async open(): Promise<SignalRecord[]> {
    const f = await this.load();
    const out: SignalRecord[] = [];
    for (const day of Object.keys(f.byDay)) {
      for (const r of Object.values(f.byDay[day])) if (r.outcome.state === 'Open') out.push(r);
    }
    return out.sort((a, b) => a.firedAt - b.firedAt);
  }

  async record(signal: PullbackSignal, nowMs = Date.now()): Promise<SignalRecord> {
    const f = await this.load();
    const day = istDay(nowMs);
    const bucket = (f.byDay[day] ??= {});

    const existing = bucket[signal.id];
    // Already logged. The scan runs every thirty seconds and a confirmation stays valid for
    // several of them, so this is the common path — and returning the ORIGINAL record rather
    // than overwriting it is what keeps `firedAt` and the tracked extremes from being reset to
    // the current price on every cycle.
    if (existing) return existing;

    const record: SignalRecord = {
      id: signal.id,
      day,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      direction: signal.direction,
      firedAt: signal.firedAt,
      entry: signal.entry,
      stop: signal.stop.recommended.price,
      target: signal.target.primary.price,
      score: signal.score.total,
      band: signal.score.band,
      entryKind: signal.entryKind,
      option: signal.option
        ? { label: signal.option.label, entryCost: signal.option.entryCost, delta: signal.option.delta }
        : null,
      outcome: { ...signal.outcome },
    };
    bucket[signal.id] = record;

    // Trim whole days from the front, so the file cannot grow without bound over a year.
    const days = Object.keys(f.byDay).sort();
    for (const d of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete f.byDay[d];

    this.dirty = true;
    await this.flush();
    return record;
  }

  async lastFiredAt(symbol: string, timeframe: Timeframe): Promise<number | null> {
    const f = await this.load();
    let latest: number | null = null;
    // Across days rather than today only: a cooldown that reset at midnight would let the first
    // scan of a session re-fire a signal from 15:29 the previous evening, whose confirmation bar
    // is still inside the ring the scanner just seeded.
    for (const day of Object.keys(f.byDay)) {
      for (const r of Object.values(f.byDay[day])) {
        if (r.symbol !== symbol || r.timeframe !== timeframe) continue;
        if (latest === null || r.firedAt > latest) latest = r.firedAt;
      }
    }
    return latest;
  }

  async settle(prices: Map<string, number>, nowMs = Date.now()): Promise<SignalRecord[]> {
    const f = await this.load();
    const settled: SignalRecord[] = [];
    const today = istDay(nowMs);

    for (const day of Object.keys(f.byDay)) {
      for (const r of Object.values(f.byDay[day])) {
        if (r.outcome.state !== 'Open') continue;

        // A signal from an earlier session is expired, not open. An intraday pullback trade does
        // not survive the close: the option decays overnight, the gap is unhedged, and reporting
        // it as still running would put yesterday's unresolved trades in today's statistics.
        if (day !== today) {
          r.outcome = { ...r.outcome, state: 'Expired', closedAt: nowMs, note: 'session ended with the trade open' };
          settled.push(r);
          this.dirty = true;
          continue;
        }

        const price = prices.get(r.symbol);
        if (price === undefined || !(price > 0)) continue;

        const o: SignalOutcome = { ...r.outcome };
        if (r.direction === 1) {
          o.maxFavourable = Math.max(o.maxFavourable, price);
          o.maxAdverse = Math.min(o.maxAdverse, price);
        } else {
          o.maxFavourable = Math.min(o.maxFavourable, price);
          o.maxAdverse = Math.max(o.maxAdverse, price);
        }

        const hitStop = r.direction === 1 ? o.maxAdverse <= r.stop : o.maxAdverse >= r.stop;
        const hitTarget = r.direction === 1 ? o.maxFavourable >= r.target : o.maxFavourable <= r.target;

        // Stop wins a tie. Inside one poll interval there is no way to know which was touched
        // first, and this is the assumption that never overstates a result.
        if (hitStop) {
          o.state = 'StopHit';
          o.r = realisedR(r.entry, r.stop, r.stop, r.direction);
          o.closedAt = nowMs;
          if (hitTarget) o.note = 'both levels were reached inside one poll — resolved as the stop, which cannot flatter the record';
        } else if (hitTarget) {
          o.state = 'TargetHit';
          o.r = realisedR(r.entry, r.target, r.stop, r.direction);
          o.closedAt = nowMs;
        }

        r.outcome = o;
        this.dirty = true;
        if (o.state !== 'Open') settled.push(r);
      }
    }

    await this.flush();
    return settled;
  }

  /** One write per call at most; concurrent callers share the in-flight one. */
  async flush(): Promise<void> {
    if (!this.dirty || !this.mem) return;
    if (this.flushing) return this.flushing;
    this.dirty = false;
    const payload = this.mem;
    this.flushing = store.write(PULLBACK_KEYS.signals, payload).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Test seam. */
  reset(): void {
    this.mem = null;
    this.dirty = false;
  }
}

export const signalRepository = new StoredSignalRepository();

/** Aggregate today's log into the board's headline counters. */
export function summarise(records: SignalRecord[]): {
  fired: number; targetHit: number; stopHit: number; open: number; winRatePct: number | null;
} {
  const targetHit = records.filter((r) => r.outcome.state === 'TargetHit').length;
  const stopHit = records.filter((r) => r.outcome.state === 'StopHit').length;
  const decided = targetHit + stopHit;
  return {
    fired: records.length,
    targetHit,
    stopHit,
    open: records.filter((r) => r.outcome.state === 'Open').length,
    // Null rather than 0 when nothing has resolved. A win rate of "0%" on a morning where two
    // signals are still running is a false statement, and it is the kind that gets screenshotted.
    winRatePct: decided > 0 ? +((targetHit / decided) * 100).toFixed(1) : null,
  };
}
