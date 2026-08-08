// Fired signals, backed by Postgres.
//
// THE READ MODEL IS NOT OPTIONAL HERE, and this is the one place a naive migration would
// actually break the scanner rather than merely slow it. `lastFiredAt()` is called inside the
// per-member, per-timeframe loop in `scanner.engine.ts` — with ~212 members and up to four
// signal timeframes that is ~850 calls per scan, and the scan runs every thirty seconds. As
// queries against a hosted database at even 20ms round trip, one scan would spend seventeen
// seconds asking about cooldowns. So the recent window is warmed into memory once and every
// read is served from it; Postgres is the system of record, not the read path.
//
// WRITES FOLLOW THE FILE DRIVER'S RHYTHM, for the same reason it has one. `record()` inserts
// immediately because the cooldown has to survive a restart — losing it re-fires every signal
// already given, which on a trend day is four alerts for one trade. `settle()` only touches
// memory and marks the row dirty, because it runs every scan and moves the tracked extremes on
// every open trade; `flush()` then writes the whole dirty set in ONE statement. The scheduler
// already calls `flush()` on a 60-second tick, so this needs no new wiring.
//
// The outcome lives in columns rather than a JSONB blob because `state` is what every
// interesting question filters on — win rate by symbol, by timeframe, by hour of day — and
// that is the entire reason this table is in a database instead of a file.

import { istDay } from '../../momentum/session.js';
import { query } from '../../db/pool.js';
import { realisedR } from '../engine/risk.service.js';
import type { PullbackSignal, SignalRecord, SignalOutcome, Timeframe } from '../types.js';
import type { SignalRepository } from './signal.repository.js';

/** Sessions warmed into memory. Matches the file driver's retention window. */
const WARM_DAYS = 40;

interface Row {
  id: string;
  day: string;
  symbol: string;
  timeframe: number;
  direction: number;
  fired_at: string;
  entry: string;
  stop: string;
  target: string;
  score: string;
  band: string;
  entry_kind: string;
  option: { label: string; entryCost: number; delta: number } | null;
  outcome_state: string;
  max_favourable: string;
  max_adverse: string;
  realised_r: string | null;
  closed_at: string | null;
  note: string | null;
}

/** `pg` hands back NUMERIC and BIGINT as strings — parsed once, at the boundary. */
const num = (v: string | null): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toRecord = (r: Row): SignalRecord => ({
  id: r.id,
  day: typeof r.day === 'string' ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10),
  symbol: r.symbol,
  timeframe: r.timeframe as Timeframe,
  direction: r.direction === 1 ? 1 : -1,
  firedAt: num(r.fired_at) ?? 0,
  entry: num(r.entry) ?? 0,
  stop: num(r.stop) ?? 0,
  target: num(r.target) ?? 0,
  score: num(r.score) ?? 0,
  band: r.band as SignalRecord['band'],
  entryKind: r.entry_kind as SignalRecord['entryKind'],
  option: r.option,
  outcome: {
    state: r.outcome_state as SignalOutcome['state'],
    maxFavourable: num(r.max_favourable) ?? 0,
    maxAdverse: num(r.max_adverse) ?? 0,
    r: num(r.realised_r),
    closedAt: num(r.closed_at),
    ...(r.note ? { note: r.note } : {}),
  },
});

export class PgSignalRepository implements SignalRepository {
  /** day -> id -> record. The warmed read model, same shape the file driver holds. */
  private mem: Map<string, Map<string, SignalRecord>> | null = null;
  private loading: Promise<Map<string, Map<string, SignalRecord>>> | null = null;
  /** Ids whose outcome has moved in memory and not yet reached the table. */
  private dirty = new Set<string>();
  private flushing: Promise<void> | null = null;

  private async load(): Promise<Map<string, Map<string, SignalRecord>>> {
    if (this.mem) return this.mem;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const rows = await query<Row>(
        `SELECT id, day, symbol, timeframe, direction, fired_at, entry, stop, target,
                score, band, entry_kind, option, outcome_state, max_favourable,
                max_adverse, realised_r, closed_at, note
           FROM pullback_signal
          WHERE day >= CURRENT_DATE - $1::int
          ORDER BY fired_at`,
        [WARM_DAYS],
      );
      const map = new Map<string, Map<string, SignalRecord>>();
      for (const row of rows) {
        const rec = toRecord(row);
        let bucket = map.get(rec.day);
        if (!bucket) map.set(rec.day, (bucket = new Map()));
        bucket.set(rec.id, rec);
      }
      this.mem = map;
      return map;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async forDay(day = istDay()): Promise<SignalRecord[]> {
    const m = await this.load();
    return [...(m.get(day)?.values() ?? [])].sort((a, b) => a.firedAt - b.firedAt);
  }

  async open(): Promise<SignalRecord[]> {
    const m = await this.load();
    const out: SignalRecord[] = [];
    for (const bucket of m.values()) for (const r of bucket.values()) if (r.outcome.state === 'Open') out.push(r);
    return out.sort((a, b) => a.firedAt - b.firedAt);
  }

  async lastFiredAt(symbol: string, timeframe: Timeframe): Promise<number | null> {
    const m = await this.load();
    let latest: number | null = null;
    // Across days rather than today only, matching the file driver: a cooldown that reset at
    // midnight would let the first scan of a session re-fire a signal from 15:29 the previous
    // evening, whose confirmation bar is still inside the ring the scanner just seeded.
    for (const bucket of m.values()) {
      for (const r of bucket.values()) {
        if (r.symbol !== symbol || r.timeframe !== timeframe) continue;
        if (latest === null || r.firedAt > latest) latest = r.firedAt;
      }
    }
    return latest;
  }

  async record(signal: PullbackSignal, nowMs = Date.now()): Promise<SignalRecord> {
    const m = await this.load();
    const day = istDay(nowMs);
    let bucket = m.get(day);
    if (!bucket) m.set(day, (bucket = new Map()));

    // Already logged. The scan runs every thirty seconds and a confirmation stays valid across
    // several of them, so this is the COMMON path — and returning the original rather than
    // overwriting is what keeps `firedAt` and the tracked extremes from being reset to the
    // current price on every cycle.
    const existing = bucket.get(signal.id);
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

    // Written through immediately rather than deferred to `flush()`: this is what the cooldown
    // reads after a restart, and a signal that fired at 10:45 and was lost to a 10:46 crash
    // re-fires the moment the process comes back.
    await query(
      `INSERT INTO pullback_signal
         (id, day, symbol, timeframe, direction, fired_at, entry, stop, target, score, band,
          entry_kind, option, outcome_state, max_favourable, max_adverse, realised_r, closed_at, note)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (id) DO NOTHING`,
      [
        record.id, record.day, record.symbol, record.timeframe, record.direction, record.firedAt,
        record.entry, record.stop, record.target, record.score, record.band, record.entryKind,
        record.option ? JSON.stringify(record.option) : null,
        record.outcome.state, record.outcome.maxFavourable, record.outcome.maxAdverse,
        record.outcome.r, record.outcome.closedAt, record.outcome.note ?? null,
      ],
    );

    bucket.set(record.id, record);
    return record;
  }

  /**
   * Advance every open signal against the live price.
   *
   * The arithmetic is copied from the file driver deliberately rather than shared through a
   * helper: it is the definition of what an outcome MEANS — touch not close, stop wins a tie —
   * and two drivers that could ever disagree about that would produce two different trading
   * records from the same session. Keeping it identical and adjacent is what makes the
   * equivalence checkable by reading.
   */
  async settle(prices: Map<string, number>, nowMs = Date.now()): Promise<SignalRecord[]> {
    const m = await this.load();
    const settled: SignalRecord[] = [];
    const today = istDay(nowMs);

    for (const [day, bucket] of m) {
      for (const r of bucket.values()) {
        if (r.outcome.state !== 'Open') continue;

        // A signal from an earlier session is expired, not open. An intraday pullback trade does
        // not survive the close: the option decays overnight, the gap is unhedged, and reporting
        // it as still running would put yesterday's unresolved trades in today's statistics.
        if (day !== today) {
          r.outcome = { ...r.outcome, state: 'Expired', closedAt: nowMs, note: 'session ended with the trade open' };
          this.dirty.add(r.id);
          settled.push(r);
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
        this.dirty.add(r.id);
        if (o.state !== 'Open') settled.push(r);
      }
    }

    await this.flush();
    return settled;
  }

  /**
   * Write every moved outcome, in one statement.
   *
   * `unnest` over parallel arrays rather than a built-up VALUES list: the parameter count stays
   * at seven however many rows are dirty, so there is no tuple arithmetic to get wrong and no
   * risk of brushing Postgres's parameter ceiling on a busy day.
   */
  async flush(): Promise<void> {
    if (!this.dirty.size || !this.mem) return;
    if (this.flushing) return this.flushing;

    const ids = [...this.dirty];
    this.dirty.clear();

    const rows: SignalRecord[] = [];
    for (const bucket of this.mem.values()) for (const id of ids) {
      const r = bucket.get(id);
      if (r) rows.push(r);
    }
    if (!rows.length) return;

    this.flushing = query(
      `UPDATE pullback_signal AS s SET
         outcome_state  = v.state,
         max_favourable = v.mf,
         max_adverse    = v.ma,
         realised_r     = v.r,
         closed_at      = v.closed_at,
         note           = v.note
       FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[],
                   $5::numeric[], $6::bigint[], $7::text[])
         AS v(id, state, mf, ma, r, closed_at, note)
       WHERE s.id = v.id`,
      [
        rows.map((r) => r.id),
        rows.map((r) => r.outcome.state),
        rows.map((r) => r.outcome.maxFavourable),
        rows.map((r) => r.outcome.maxAdverse),
        rows.map((r) => r.outcome.r),
        rows.map((r) => r.outcome.closedAt),
        rows.map((r) => r.outcome.note ?? null),
      ],
    )
      .then(() => {})
      // Put them back rather than losing the update — the next flush retries. Dropping them
      // would leave memory and the table permanently disagreeing about a settled trade.
      .catch((e: Error) => { for (const id of ids) this.dirty.add(id); throw e; })
      .finally(() => { this.flushing = null; });

    return this.flushing;
  }

  /** Test seam. */
  reset(): void {
    this.mem = null;
    this.dirty.clear();
  }
}
