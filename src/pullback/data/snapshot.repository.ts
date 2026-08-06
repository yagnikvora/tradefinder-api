// The last board that was successfully scanned.
//
// Same reasoning as `momentum/data/snapshot.repository.ts`: when Upstox is unreachable,
// re-serving REAL numbers that are two minutes old is better than serving nothing, and far
// better than serving invented ones. This module's output is an option order, so a fabricated
// board is indistinguishable from a real one on screen and would be acted on.
//
// The distinction the payload makes is `source: 'stale'` with an age. There is no mock tier and
// there will not be one — there is no plausible synthetic pullback signal, and the option pages
// in this app already take the same line.

import { store } from '../../momentum/store.js';
import { PULLBACK_KEYS } from '../config/config.repository.js';
import type { PullbackBoard } from '../types.js';

export interface SnapshotRepository {
  save(board: PullbackBoard): Promise<void>;
  last(): Promise<{ board: PullbackBoard; ageMs: number } | null>;
}

export class StoredSnapshotRepository implements SnapshotRepository {
  private mem: PullbackBoard | null = null;

  async save(board: PullbackBoard): Promise<void> {
    this.mem = board;
    await store.write(PULLBACK_KEYS.snapshot, board);
  }

  async last(): Promise<{ board: PullbackBoard; ageMs: number } | null> {
    const board = this.mem ?? (await store.read<PullbackBoard>(PULLBACK_KEYS.snapshot));
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
