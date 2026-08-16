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

/* -------------------------------------------------------------------- the governor --- */

// THE BREAKER WAS ONLY EVER THE SECOND HALF OF THE ANSWER.
//
// Everything above is REACTIVE: it counts refusals that have already happened and stops the
// bleeding. Nothing was stopping the build from earning those refusals in the first place, and
// it earned them every single time — because Upstox's published ceiling is not one number, it
// is three, and the binding one is not the one this file was written against:
//
//     50 per second · 500 per MINUTE · 2000 per 30 minutes     (per API, per user)
//
// A baseline build is ~625 requests and `inBatches` fires them with no pacing at all: five
// symbols at a time, three requests each, fifteen in flight, the next fifteen the instant those
// land. At a few hundred milliseconds a request that is 2,000–4,000 per minute — four to eight
// times over the per-minute cap — so it is refused after roughly 500 requests, every time,
// wherever the 30-minute budget happens to stand.
//
// That is exactly what the 2026-08-16 build did: 128 symbols × 3 ≈ 385 requests, plus the
// refusals themselves, and then the breaker opened. It was never close to the 30-minute
// ceiling. Waiting half an hour and trying again could not have helped, because the very next
// build blew the per-minute cap inside its first sixty seconds.
//
// So the requests are now PACED. 625 requests at 450 a minute is 83 seconds — slower than the
// burst, and it finishes, which the burst never did.

/** Per-second ceiling. Upstox publishes 50; the margin absorbs clock skew and retries. */
const PER_SECOND = 40;
/** Per-minute ceiling. Upstox publishes 500. This is the one that was being blown. */
const PER_MINUTE = 450;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Breaker {
  refusals: number[];
  openedAt: number;
  /** Timestamps of requests let through in the last minute, oldest first. */
  sent: number[];
  /**
   * Serialises the reservations.
   *
   * Without it fifteen concurrent callers each read the same history, each conclude there is
   * room, and all fifteen go — which is the burst this is here to prevent. Chained, each one
   * reserves against what the previous one actually took.
   */
  gate: Promise<void>;
}

const breakers = new Map<string, Breaker>();

const breaker = (endpoint: string): Breaker => {
  let b = breakers.get(endpoint);
  if (!b) breakers.set(endpoint, (b = { refusals: [], openedAt: 0, sent: [], gate: Promise.resolve() }));
  return b;
};

/**
 * Wait until this endpoint has room, then claim a slot.
 *
 * Await it immediately before the request. Returns at once while there is headroom, so a lone
 * call pays nothing; only a burst is slowed, and only to the published rate.
 */
export function acquire(endpoint: string, nowFn: () => number = Date.now): Promise<void> {
  const b = breaker(endpoint);
  const next = b.gate.then(async () => {
    for (;;) {
      const now = nowFn();
      // Only the last minute can constrain anything, so nothing older is worth keeping.
      b.sent = b.sent.filter((t) => now - t < 60_000);

      const inSecond = b.sent.filter((t) => now - t < 1_000);
      // The wait is until the OLDEST relevant stamp leaves its window — the exact moment a slot
      // frees, rather than a fixed sleep that would either overshoot or spin.
      if (inSecond.length >= PER_SECOND) {
        await sleep(Math.max(1, 1_000 - (now - inSecond[0])));
        continue;
      }
      if (b.sent.length >= PER_MINUTE) {
        await sleep(Math.max(1, 60_000 - (now - b.sent[0])));
        continue;
      }

      b.sent.push(now);
      return;
    }
  });
  // The chain must not inherit a rejection, or every later caller fails on someone else's error.
  b.gate = next.catch(() => {});
  return next;
}

/** What the governor is currently holding back, for `/momentum/status`. */
export function paceState(endpoint: string, nowMs = Date.now()): { lastSecond: number; lastMinute: number; perSecond: number; perMinute: number } {
  const b = breaker(endpoint);
  return {
    lastSecond: b.sent.filter((t) => nowMs - t < 1_000).length,
    lastMinute: b.sent.filter((t) => nowMs - t < 60_000).length,
    perSecond: PER_SECOND,
    perMinute: PER_MINUTE,
  };
}

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
