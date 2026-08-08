// MomentumHistory, backed by Postgres.
//
// Same interface as `StoredHistoryRepository`, different durability. The two differences that
// matter are both about NOT regressing what the file driver does well:
//
//   1. THE READ PATH STAYS IN MEMORY. `forSymbol()` is called once per shortlisted symbol
//      inside the enrichment pass (`momentum.engine.ts`), so a driver that issued a query per
//      call would put ~40 network round trips on a scan that runs every 15 seconds. The
//      trailing window is warmed once and served from a Map; Postgres is the system of
//      record and the analytics surface, not the hot path. This is the same read model the
//      file driver has — it is just no longer the same thing as the storage.
//
//   2. THE WHOLE FILE IS NO LONGER REWRITTEN PER WRITE. `upsertMany` on the file driver
//      serialises every symbol's entire history on every scan that records one. Here it is
//      one multi-row INSERT touching only the rows that changed, which is the actual reason
//      this table wanted a database.
//
// WARMING IS BOUNDED to `WARM_DAYS`. IV Rank reads at most 252 sessions and nothing else
// reads deeper, so holding the full table would be memory spent on rows no code path can
// reach. The TABLE keeps everything — the 520-day trim in the file driver exists because
// rewriting a growing file gets slower, which is not a problem Postgres has.

import type { MomentumHistoryRecord } from '../types.js';
import type { HistoryRepository } from './history.repository.js';
import { query } from '../../db/pool.js';

/** Sessions warmed into memory. Comfortably past the 252 IV Rank reads. */
const WARM_DAYS = 400;

interface Row {
  symbol: string;
  day: string;
  close: string;
  score: string;
  direction: string;
  rvol: string | null;
  atm_iv: string | null;
  hv20: string | null;
  futures_oi: string | null;
}

/**
 * `pg` returns NUMERIC and BIGINT as STRINGS, not numbers.
 *
 * That is correct of it — both can hold values JavaScript's number cannot represent exactly —
 * and it is also the single most common way a Postgres migration goes quietly wrong: `"12.5"`
 * flows into arithmetic, `+` concatenates instead of adding, and a score becomes `"012.5"`
 * somewhere three functions away. Parsed once, here, at the boundary.
 */
const num = (v: string | null): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toRecord = (r: Row): MomentumHistoryRecord => ({
  symbol: r.symbol,
  // DATE comes back as a JS Date under `pg`'s default parser; the app's day is 'YYYY-MM-DD'.
  day: typeof r.day === 'string' ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10),
  close: num(r.close) ?? 0,
  score: num(r.score) ?? 0,
  direction: r.direction as MomentumHistoryRecord['direction'],
  rvol: num(r.rvol),
  atmIv: num(r.atm_iv),
  hv20: num(r.hv20),
  futuresOi: num(r.futures_oi),
});

export class PgHistoryRepository implements HistoryRepository {
  /** symbol -> day -> record. The warmed read model. */
  private mem: Map<string, Map<string, MomentumHistoryRecord>> | null = null;
  private loading: Promise<Map<string, Map<string, MomentumHistoryRecord>>> | null = null;

  private async load(): Promise<Map<string, Map<string, MomentumHistoryRecord>>> {
    if (this.mem) return this.mem;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const rows = await query<Row>(
        `SELECT symbol, day, close, score, direction, rvol, atm_iv, hv20, futures_oi
           FROM momentum_history
          WHERE day >= CURRENT_DATE - $1::int
          ORDER BY symbol, day`,
        [WARM_DAYS],
      );
      const map = new Map<string, Map<string, MomentumHistoryRecord>>();
      for (const r of rows) {
        const rec = toRecord(r);
        let bucket = map.get(rec.symbol);
        if (!bucket) map.set(rec.symbol, (bucket = new Map()));
        bucket.set(rec.day, rec);
      }
      this.mem = map;
      return map;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async forSymbol(symbol: string): Promise<MomentumHistoryRecord[]> {
    const m = await this.load();
    const days = m.get(symbol);
    if (!days) return [];
    return [...days.keys()].sort().map((d) => days.get(d)!);
  }

  async depth(symbol: string): Promise<number> {
    const m = await this.load();
    return m.get(symbol)?.size ?? 0;
  }

  async upsert(record: MomentumHistoryRecord): Promise<void> {
    return this.upsertMany([record]);
  }

  async upsertMany(records: MomentumHistoryRecord[]): Promise<void> {
    if (!records.length) return;
    const m = await this.load();

    // One statement for the whole batch. Built as ($1,$2,...),($10,$11,...) rather than looped
    // inserts because the batch is one row per scored symbol — up to ~208 of them — and 208
    // round trips on the scan path would cost more than the scan.
    const cols = 9;
    const values: unknown[] = [];
    const tuples = records.map((r, i) => {
      values.push(r.symbol, r.day, r.close, r.score, r.direction, r.rvol, r.atmIv, r.hv20, r.futuresOi);
      const b = i * cols;
      return `($${b + 1},$${b + 2}::date,$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
    });

    await query(
      `INSERT INTO momentum_history
         (symbol, day, close, score, direction, rvol, atm_iv, hv20, futures_oi)
       VALUES ${tuples.join(',')}
       ON CONFLICT (symbol, day) DO UPDATE SET
         close       = EXCLUDED.close,
         score       = EXCLUDED.score,
         direction   = EXCLUDED.direction,
         rvol        = EXCLUDED.rvol,
         atm_iv      = EXCLUDED.atm_iv,
         hv20        = EXCLUDED.hv20,
         futures_oi  = EXCLUDED.futures_oi,
         recorded_at = now()`,
      values,
    );

    // The read model follows the write. Re-reading to confirm would double the round trips to
    // learn what we just sent.
    for (const r of records) {
      let bucket = m.get(r.symbol);
      if (!bucket) m.set(r.symbol, (bucket = new Map()));
      bucket.set(r.day, r);
    }
  }

  /** Test seam — drops the read model so the next call re-warms. */
  reset(): void {
    this.mem = null;
  }
}
