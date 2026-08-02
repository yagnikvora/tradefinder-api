// MomentumSnapshot — the last board that was successfully computed.
//
// This exists for the same reason `snapshot.ts` exists for Market Pulse: when Upstox is
// unreachable, re-serving real numbers that are two minutes old is better than serving
// invented ones, and far better than serving nothing. A momentum score is read as a trading
// signal — a fabricated one is indistinguishable from a real one on screen.
//
// The distinction the payload makes is `source: 'stale'` with an age, so a reader can see
// that the board is not current. It never falls back to mock data: there is no plausible
// synthetic momentum board, and the option pages in this app already take the same line.

import type { MomentumBoard } from '../types.js';
import { store, STORE_KEYS } from '../store.js';

export interface SnapshotRepository {
  save(board: MomentumBoard): Promise<void>;
  last(): Promise<{ board: MomentumBoard; ageMs: number } | null>;
}

export class StoredSnapshotRepository implements SnapshotRepository {
  private mem: MomentumBoard | null = null;

  async save(board: MomentumBoard): Promise<void> {
    this.mem = board;
    await store.write(STORE_KEYS.snapshot, board);
  }

  async last(): Promise<{ board: MomentumBoard; ageMs: number } | null> {
    const board = this.mem ?? (await store.read<MomentumBoard>(STORE_KEYS.snapshot));
    if (!board) return null;
    this.mem = board;
    return { board, ageMs: Date.now() - board.asOf };
  }
}

export const snapshotRepository: SnapshotRepository = new StoredSnapshotRepository();

/** "2m 30s" — the age a stale board reports. */
export function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
