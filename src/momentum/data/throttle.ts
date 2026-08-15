// A circuit breaker for the Upstox request budget.
//
// This exists because of a failure that was caused by the fix for the previous failure.
//
// The daily baseline is ~416 requests against `/v3/historical-candle`, and Upstox allows
// 2000 per 30 minutes per endpoint. A burst of those comes back 429 — the first build lost
// 18 of 208 symbols that way — so the obvious fix was retry-with-backoff, and for a BURST
// that is the right fix.
//
// Running the build twice inside the same 30-minute window is a different failure. The
// quota is genuinely gone, every request 429s, and retry-with-backoff turns 208 doomed
// requests into 600 doomed requests — each sleeping through its backoff first. The second
// build covered 8 symbols out of 208 and took longer than the first. Retrying a quota is
// not resilience, it is amplification.
//
// So: retry the first few, then stop. Once `TRIP_AFTER` refusals have landed inside the
// window the breaker opens and every subsequent call fails immediately without touching the
// network, until the window has passed. The caller sees a clear error and keeps the
// baseline it already had, which is a far better outcome than an empty one.

/**
 * The breaker key for `/v3/historical-candle`. One budget per Upstox endpoint, so one breaker.
 *
 * Defined HERE rather than beside the candle helpers because two modules in different layers
 * spend this same budget — `momentum/data/candles.ts` and `equity.ts`'s `dailyBars` — and
 * importing it from either of those into the other closes an import cycle. This file imports
 * nothing, so it is the one place both can reach.
 */
export const CANDLE_ENDPOINT = 'historical-candle';

/** Refusals inside the window before the breaker opens. */
const TRIP_AFTER = 12;
/** How long the breaker stays open. Upstox's window is 30 minutes; this re-probes sooner. */
const OPEN_MS = 5 * 60_000;
/** Refusals older than this stop counting toward the trip. */
const WINDOW_MS = 60_000;

interface Breaker {
  refusals: number[];
  openedAt: number;
}

const breakers = new Map<string, Breaker>();

const breaker = (endpoint: string): Breaker => {
  let b = breakers.get(endpoint);
  if (!b) breakers.set(endpoint, (b = { refusals: [], openedAt: 0 }));
  return b;
};

export class ThrottledError extends Error {
  readonly status = 429;
  constructor(endpoint: string, readonly retryAfterMs: number) {
    super(
      `Upstox ${endpoint} is rate limited — the circuit is open for another ` +
      `${Math.ceil(retryAfterMs / 1000)}s. Upstox allows 2000 requests per 30 minutes per endpoint; ` +
      'a full baseline build is ~416 of them, so two builds in one window will do this.',
    );
    this.name = 'ThrottledError';
  }
}

/** Milliseconds until the breaker closes, or 0 when it is shut. */
export function throttledFor(endpoint: string, nowMs = Date.now()): number {
  const b = breaker(endpoint);
  if (!b.openedAt) return 0;
  const left = b.openedAt + OPEN_MS - nowMs;
  if (left <= 0) {
    b.openedAt = 0;
    b.refusals = [];
    return 0;
  }
  return left;
}

/** Throw rather than make a request the endpoint has already said no to. */
export function assertNotThrottled(endpoint: string, nowMs = Date.now()): void {
  const left = throttledFor(endpoint, nowMs);
  if (left > 0) throw new ThrottledError(endpoint, left);
}

/** Record a 429. Opens the breaker once they cluster. */
export function noteRefusal(endpoint: string, nowMs = Date.now()): void {
  const b = breaker(endpoint);
  b.refusals = b.refusals.filter((t) => nowMs - t < WINDOW_MS);
  b.refusals.push(nowMs);
  if (b.refusals.length >= TRIP_AFTER) b.openedAt = nowMs;
}

/** Record a success. A working request is evidence the burst has passed. */
export function noteSuccess(endpoint: string): void {
  const b = breakers.get(endpoint);
  if (b && !b.openedAt) b.refusals = [];
}

export function breakerState(endpoint: string): { open: boolean; refusals: number; retryAfterMs: number } {
  const b = breaker(endpoint);
  return { open: !!b.openedAt, refusals: b.refusals.length, retryAfterMs: throttledFor(endpoint) };
}

/** Test seam. */
export const resetBreakers = (): void => breakers.clear();
