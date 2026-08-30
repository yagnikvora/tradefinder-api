// Minute candles for a contract whose series has already expired.
//
// `/v3/historical-candle` stops serving an instrument the moment its series expires — it answers
// `400 UDAPI100011 Invalid Instrument key`, not an empty array. Upstox keeps the data behind a
// separate endpoint, addressed with a different key, and gated on an Upstox Plus subscription:
//
//     live     NSE_FO|121245                 dies at expiry
//     expired  NSE_FO|121245|25-08-2026      the same contract, plus its expiry, DD-MM-YYYY
//
// TWO SHAPES, ONE PARSER. The expired endpoint does not return what the live one returns:
//
//     v3       [1753848540, ...]                          epoch SECONDS, ascending
//     expired  ["2026-07-30T15:29:00+05:30", ...]         ISO string,   DESCENDING
//
// Reading the ISO form as an epoch yields NaN, so every bar lands with a null minute and the whole
// path is silently empty — indistinguishable from "the contract never traded". That failure cost a
// full backfill run once; hence one parser, here, used by everything that reads expired candles.

const BASE = 'https://api.upstox.com';
const SESSION_OPEN_MIN = 9 * 60 + 15;
const BARS_PER_SESSION = 375;

export interface ExpiredBar { minute: number; open: number; high: number; low: number; close: number }

/**
 * `NSE_FO|121245` + `2026-08-25` -> `NSE_FO|121245|25-08-2026`.
 *
 * IDEMPOTENT, and that is load-bearing rather than defensive. Keys reach this from two places in
 * different shapes: a map captured live before expiry holds the bare `NSE_FO|121245`, while a map
 * recovered afterwards holds whatever the expired-contract endpoint returned — which is ALREADY
 * `NSE_FO|121245|30-03-2026`. Appending unconditionally produces a key with the expiry twice, and
 * Upstox answers `400 UDAPI1021 invalid format`, which reads as "bad contract" rather than "bad
 * caller". A whole backfill priced nothing that way.
 */
export function expiredKey(instrumentKey: string, expiry: string): string {
  if (/\|\d{2}-\d{2}-\d{4}$/.test(instrumentKey)) return instrumentKey;
  const [y, m, d] = expiry.split('-');
  return `${instrumentKey}|${d}-${m}-${y}`;
}

/** Thrown when the account lacks the Upstox Plus entitlement, so callers can stop rather than retry. */
export class PlanRequiredError extends Error {
  constructor() { super('Upstox Plus is required for expired-instrument data'); this.name = 'PlanRequiredError'; }
}

/**
 * One expired contract's session, as minute-of-session bars.
 *
 * The clock is read straight out of the ISO string: the `+05:30` offset means the text is already
 * IST, so parsing to a Date and converting back would be two conversions to arrive where it started
 * — and would break on any host whose local zone is not IST.
 */
export async function expiredSession(
  instrumentKey: string,
  expiry: string,
  day: string,
  token = process.env.UPSTOX_ACCESS_TOKEN,
): Promise<ExpiredBar[]> {
  if (!token) throw new Error('UPSTOX_ACCESS_TOKEN is not set');
  const key = expiredKey(instrumentKey, expiry);
  const url = `${BASE}/v2/expired-instruments/historical-candle/${encodeURIComponent(key)}/1minute/${day}/${day}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const text = await res.text();

  if (!res.ok) {
    let code = '';
    try { code = (JSON.parse(text) as { errors?: { errorCode?: string }[] })?.errors?.[0]?.errorCode ?? ''; } catch { /* raw */ }
    if (code === 'UDAPI1149') throw new PlanRequiredError();
    throw new Error(`expired candles ${res.status} ${code || text.slice(0, 80)}`);
  }

  const raw = (JSON.parse(text) as { data?: { candles?: unknown[][] } })?.data?.candles ?? [];
  const out: ExpiredBar[] = [];
  for (const c of raw) {
    const at = /T(\d{2}):(\d{2})/.exec(String(c[0]));
    if (!at) continue;
    const minute = Number(at[1]) * 60 + Number(at[2]) - SESSION_OPEN_MIN;
    const open = Number(c[1]), high = Number(c[2]), low = Number(c[3]), close = Number(c[4]);
    if (minute < 0 || minute >= BARS_PER_SESSION) continue;
    if (![open, high, low, close].every(Number.isFinite)) continue;
    out.push({ minute, open, high, low, close });
  }
  return out.sort((a, b) => a.minute - b.minute);
}
