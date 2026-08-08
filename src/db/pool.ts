// The Postgres connection — optional, lazy, and absent by default.
//
// THE WHOLE MODULE IS OPT-IN. With no `DATABASE_URL` set, `dbEnabled()` is false, nothing
// here ever opens a socket, and every repository keeps the JSON-file driver it has today.
// That is deliberate: this app's storage works, and a database is an ADDITION for the two
// tables that want querying (momentum history, pullback signals), not a replacement for the
// blob caches that are correctly files. See `db/wire.ts` for exactly what is swapped.
//
// WHY `pg` AND NOT `@neondatabase/serverless`. The serverless driver exists for functions
// that live for one request and cannot hold a socket. This is a long-running Node process
// with a 15-second scheduler, so an ordinary pooled TCP connection is both faster and
// simpler, and it keeps the code portable to any Postgres — Neon, Supabase, Aiven, or a
// local one — with no import change.
//
// THE POOL IS DELIBERATELY SMALL AND CLOSES ITS IDLE CONNECTIONS. Neon's free tier bills
// compute time and suspends after ~5 minutes of inactivity; NSE trades for 6.25 hours and
// this process idles for the other 17.75 plus weekends. A pool that held connections open
// around the clock would be spending the monthly compute allowance on a database nobody is
// querying. Thirty seconds of idle keep-alive is far longer than the 15-second scan tick, so
// nothing reconnects during a session, and everything closes shortly after the bell.

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

// Named `connectionUrl`, not `URL` — the obvious name shadows the global `URL` class that
// `sslConfig` below needs, and the failure is a confusing one: `new URL(...)` resolves to the
// arrow function and reports "target lacks a construct signature" from a line that looks fine.
const connectionUrl = () => process.env.DATABASE_URL ?? '';

/** True when a database is configured. Everything in this module checks this first. */
export const dbEnabled = (): boolean => !!connectionUrl();

let pool: Pool | null = null;

/**
 * Decide TLS ourselves, and take `sslmode` out of the connection string entirely.
 *
 * THIS IS NOT TIDYING. `pg` merges a parsed `connectionString` OVER the explicit options
 * beside it, so `sslmode=require` in the URL wins against an `ssl` object passed here — the
 * opposite of the precedence you would assume. Today that is harmless, because pg treats
 * `require` as `verify-full`. But pg warns on every boot that v9 will adopt libpq semantics,
 * where `require` means "encrypt but do NOT verify the certificate" — and on that day this
 * process would silently stop checking that the host receiving the database password is the
 * host we meant, with nothing in the diff to show for it.
 *
 * Stripping the parameter and stating the intent in code makes the posture independent of
 * which pg version is installed, and removes the boot warning so that real warnings are
 * visible. `rejectUnauthorized` stays TRUE: Neon, Supabase and Aiven all present certificates
 * from public CAs, so the `rejectUnauthorized: false` usually copied off a forum post buys
 * nothing but the loss of that check. `DATABASE_SSL_INSECURE=1` is for a self-hosted box with
 * a self-signed certificate and is the only route to the weaker behaviour.
 */
function sslConfig(raw: string): { connectionString: string; ssl: { rejectUnauthorized: boolean } | undefined } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { connectionString: raw, ssl: undefined }; // not a URL — hand it to pg unchanged
  }

  const mode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  // `disable` is the only value that means no TLS. Everything else — require, verify-ca,
  // verify-full, prefer — becomes a verified connection, which is the only sane default when
  // the credential travels over the public internet.
  const ssl = mode === 'disable' ? undefined : { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== '1' };
  return { connectionString: url.toString(), ssl };
}

/** The one pool. */
export function db(): Pool {
  if (pool) return pool;
  const raw = connectionUrl();
  if (!raw) throw new Error('DATABASE_URL is not set — db() must not be called; check dbEnabled() first');

  const { connectionString, ssl } = sslConfig(raw);
  pool = new Pool({
    connectionString,
    ssl,
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
    idleTimeoutMillis: 30_000,
    /**
     * Long enough for a scale-to-zero database to actually wake up.
     *
     * This was 10 seconds on the reasoning that a cold start is "a moment", and it failed every
     * single time against a suspended Neon compute in us-east-2 from India — reproducibly, at
     * 10.9s wall clock, with the misleading message "Connection terminated due to connection
     * timeout" that reads like an unreachable host rather than a slow wake. Provider docs quote
     * sub-second resume for the compute itself; what they do not include is the TLS handshake
     * and several round trips across a ~250ms link, on a connection that is also negotiating
     * from cold.
     *
     * Thirty seconds is the wrong number to tune finely. The failure this guards against is a
     * genuinely dead host, and thirty seconds still reports that inside one scan tick — while
     * ten seconds turned a working database into an outage every morning at 08:00 IST, when the
     * seed tick is the first thing to touch a connection that has been idle all night.
     */
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 30_000,
  });

  // A pool that emits 'error' with no listener takes the process down, and the errors it
  // emits are for IDLE clients — a connection the provider closed overnight, which is
  // routine and self-healing. Logged, not fatal.
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));

  return pool;
}

/** A parameterised query. Thin wrapper so call sites never touch the pool directly. */
export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query<T>(text, params);
  return res.rows;
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Close the pool. For tools and tests — the server holds it for its lifetime. */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end().catch(() => {});
}

/**
 * Prove the database is reachable and the schema is applied.
 *
 * Called once at boot by `wire.ts`. A misconfigured URL that is only discovered when the
 * first signal fires at 10:45 is the failure worth spending a round trip to avoid.
 */
export async function verifyDb(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const [row] = await query<{ v: string }>('SELECT version() AS v');
    await query('SELECT 1 FROM app_config LIMIT 1');
    return { ok: true, version: (row?.v ?? '').split(',')[0] };
  } catch (e) {
    return { ok: false, error: String((e as Error).message) };
  }
}
