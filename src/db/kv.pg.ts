// A KeyValueStore backed by `app_config` — the driver the config repositories take.
//
// Both config repositories already accept a `KeyValueStore` in their constructor, so config
// needs no new repository class at all: it needs a different driver behind the same three
// methods. That is the seam working as intended.
//
// WHY CONFIG IS A DOCUMENT AND NOT COLUMNS is argued in `schema.sql`; the short version is
// that `MomentumConfig` has grown three top-level sections since the original sketch and a
// fixed-column table would have made each of those a migration, while a config saved before a
// section existed would read back missing it — which is the exact failure the repositories
// merge-over-defaults to avoid.
//
// WRITES APPEND A VERSION rather than updating in place. The version is taken from the
// document, because both config types already carry and increment one, so the table's history
// lines up exactly with what the API reports. A write that arrives with a version already
// present overwrites that row: that is `reset()` re-issuing a number, and the newest write
// under a given version is the one that happened.

import type { KeyValueStore } from '../momentum/store.js';
import { query } from './pool.js';

export class PgKeyValueStore implements KeyValueStore {
  async read<T>(key: string): Promise<T | null> {
    const rows = await query<{ value: T }>(
      'SELECT value FROM app_config WHERE key = $1 ORDER BY version DESC LIMIT 1',
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async write<T>(key: string, value: T): Promise<void> {
    const doc = value as unknown as { version?: number; updatedBy?: string };
    const version = Number.isFinite(doc?.version) ? Number(doc.version) : 1;
    await query(
      `INSERT INTO app_config (key, version, value, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (key, version) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, version, JSON.stringify(value), doc?.updatedBy ?? 'unknown'],
    );
  }

  async remove(key: string): Promise<void> {
    await query('DELETE FROM app_config WHERE key = $1', [key]);
  }
}
