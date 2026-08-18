// The live market feed — one WebSocket standing in for the quote endpoint.
//
// WHAT THIS REPLACES, AND WHAT IT DOES NOT.
//
// `/v2/market-quote/quotes` was the only endpoint the scanner called on a timer, three
// requests every fifteen seconds for the momentum universe plus one more for the overview
// board. Everything it served — last price, previous close, day OHLC, session VWAP, volume,
// open interest, the five-deep book — is on this feed, verified field by field against the
// REST answer before any of this was written (see `tools/ws-spike.ts`).
//
// Nothing else moves. The baseline still reads `/v3/historical-candle`, enrichment still
// reads `/v2/option/chain`, and the contract master is still a REST call — those are history,
// per-strike chains and reference data, none of which a live feed can serve. The rate-limit
// budget for those endpoints is unchanged, and so is the circuit breaker that protects it.
//
// WHY IT IS WORTH DOING, WHICH IS NOT THE OBVIOUS REASON.
//
// It is not the request budget. Upstox counts per API, so retiring the quote calls buys the
// candle endpoint nothing — the baseline is still ~416 requests and still the thing that
// earns a 429. It is LATENCY. The timing layer's resolution was its poll interval: a trigger
// could not be reported sooner than the reading that detected it, so an ignition was up to
// fifteen seconds old before the board was even built. Here the reading is already in memory
// when the scan runs.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: A DEGRADED FEED MUST LOOK LIKE A DEGRADED FEED.
//
// The failure that matters is not the socket dropping — that is loud and recoverable. It is
// the socket staying open and quietly going stale, because every downstream number would keep
// computing, the board would keep rendering, and a stock that stopped ticking at 10:40 would
// read as a stock that stopped MOVING at 10:40. That is a flat VWAP slope, a decaying pulse
// and a conviction that drifts up as the "chop" disappears — a confident, wrong board.
//
// So `feedUsable` is deliberately hard to satisfy: the socket must be open, the data must be
// fresh by the clock, and it must cover nearly every instrument that was asked for. Anything
// less and the caller falls back to REST for that cycle. Falling back costs three requests.
// Not falling back costs the alerts.

import { decodeFeed, subscribeFrame, type DepthLevel, type TickPatch } from './proto.js';

const AUTHORIZE = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';

const envNum = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * The master switch. `off` reverts every caller to REST with no other change.
 *
 * Worth having as an env flag rather than a config field: the reason to reach for it is that
 * the feed is misbehaving in production, and that is the worst moment to need a database
 * write and a config reload to turn something off.
 */
const enabled = (): boolean => (process.env.MOMENTUM_FEED ?? 'on').trim().toLowerCase() !== 'off';

/**
 * How long a reading stays usable once the packets stop.
 *
 * Generous against the 15-second scan: a liquid instrument ticks many times a second, so
 * thirty seconds of total silence across the whole subscription is not a quiet market, it is
 * a broken feed. Only applied while the market is open — after the close the feed legitimately
 * goes silent and the last print is the correct answer for the rest of the day.
 */
const STALE_MS = envNum(process.env.FEED_STALE_MS, 30_000);

/**
 * How much of the requested universe must be present before the feed is trusted for a cycle.
 *
 * High on purpose. A feed missing a tenth of the board is not a feed with a few gaps — it is
 * a subscription that did not fully land, and the rows it does serve would be scored against
 * a breadth and sector picture computed from a different, smaller universe.
 */
const MIN_COVERAGE = envNum(process.env.FEED_MIN_COVERAGE, 0.9);

/** Keys per subscribe frame. Upstox accepts far more; this keeps any one frame small. */
const SUB_CHUNK = 250;

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

/* ------------------------------------------------------------------------ the store --- */

/** One instrument's current state, accumulated across every packet that mentioned it. */
export interface FeedTick {
  instrumentKey: string;
  isIndex: boolean;
  ltp: number;
  cp: number;
  atp: number;
  vtt: number;
  oi: number;
  /**
   * Session high and low of open interest, accumulated here.
   *
   * REST served these as `oi_day_high`/`oi_day_low` and the feed carries no equivalent — but
   * it streams `oi` itself, so watching the extremes is both cheaper and finer-grained than
   * the snapshot ever was. The one caveat is the same one `session-state.ts` carries: they
   * span from CONNECT, not from 09:15, so a process started at noon reports the range since
   * noon. Zero until the first non-zero reading, which is what equities stay at forever.
   */
  oiHigh: number;
  oiLow: number;
  tbq: number;
  tsq: number;
  iv: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  depth: DepthLevel[];
  /**
   * The IST session this reading belongs to.
   *
   * Here because this process runs overnight and the store does not: `oiHigh`/`oiLow` are
   * running extremes WE accumulate, and nothing in a packet says "new day". Without a stamp
   * to compare against, Tuesday's open-interest high survives into Wednesday and the futures
   * OI range reports a two-day spread as today's.
   */
  day: string;
  /** When this instrument last appeared in a packet, by our clock. */
  at: number;
  /** Upstox's own stamp from that packet, epoch ms. 0 when it carried none. */
  feedTs: number;
}

const ticks = new Map<string, FeedTick>();

const EMPTY: Omit<FeedTick, 'instrumentKey' | 'isIndex' | 'day' | 'at' | 'feedTs'> = {
  ltp: 0, cp: 0, atp: 0, vtt: 0, oi: 0, oiHigh: 0, oiLow: 0, tbq: 0, tsq: 0, iv: 0,
  dayOpen: 0, dayHigh: 0, dayLow: 0, depth: [],
};

/**
 * The IST calendar day for an epoch.
 *
 * Computed here rather than imported from `session.ts`, for the same reason `feedUsable` takes
 * `marketOpen` as an argument: that module re-exports from `services.ts`, which imports
 * `equity.ts`, which imports this file. Three lines of duplication is the cheaper price.
 */
const istDayOf = (ms: number): string => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

/**
 * Fold one packet's fields into what we already hold.
 *
 * MERGE, NOT REPLACE. proto3 omits a field whose value is the type's default, so an absent
 * `atp` is indistinguishable on the wire from `atp: 0`. Replacing would zero the session VWAP
 * of any instrument whose packet happened to carry only a price change — and a zero VWAP is
 * not a missing reading downstream, it is a stock trading infinitely far above its average.
 */
function applyPatch(patch: TickPatch, at: number, feedTs: number): void {
  const day = istDayOf(at);
  const held = ticks.get(patch.instrumentKey);
  // A reading from a previous session is not a starting point, it is yesterday. Carrying it
  // forward would keep yesterday's open-interest extremes, and — until the first packet of the
  // new day replaced them field by field — yesterday's volume and day range too.
  const prev = held && held.day === day ? held : undefined;
  const next: FeedTick = prev
    ? { ...prev, at, feedTs }
    : {
        ...EMPTY,
        instrumentKey: patch.instrumentKey,
        // What an instrument IS survives the rollover even though its readings do not — and a
        // bare LTPC packet cannot tell us, so re-deriving it from this patch alone would
        // demote an index to an equity on the first tick of the day.
        isIndex: patch.isIndex || (held?.isIndex ?? false),
        day, at, feedTs,
      };

  if (patch.ltp !== undefined) next.ltp = patch.ltp;
  if (patch.cp !== undefined) next.cp = patch.cp;
  if (patch.atp !== undefined) next.atp = patch.atp;
  if (patch.vtt !== undefined) next.vtt = patch.vtt;
  if (patch.oi !== undefined) {
    next.oi = patch.oi;
    // Only a real contract has open interest. Equities report 0 forever, and letting that
    // seed the low would report a range of "0 to today's OI" the moment a future first ticks.
    if (patch.oi > 0) {
      next.oiHigh = Math.max(next.oiHigh, patch.oi);
      next.oiLow = next.oiLow > 0 ? Math.min(next.oiLow, patch.oi) : patch.oi;
    }
  }
  if (patch.tbq !== undefined) next.tbq = patch.tbq;
  if (patch.tsq !== undefined) next.tsq = patch.tsq;
  if (patch.iv !== undefined) next.iv = patch.iv;
  if (patch.dayOpen !== undefined) next.dayOpen = patch.dayOpen;
  if (patch.dayHigh !== undefined) next.dayHigh = patch.dayHigh;
  if (patch.dayLow !== undefined) next.dayLow = patch.dayLow;
  if (patch.depth !== undefined) next.depth = patch.depth;
  // An index never becomes an equity, but the first packet for a key may be a bare LTPC
  // before a full one arrives, and that one cannot tell us which it is.
  if (patch.isIndex) next.isIndex = true;

  ticks.set(patch.instrumentKey, next);
}

/* ----------------------------------------------------------------- connection state --- */

type Phase = 'idle' | 'connecting' | 'open' | 'closed';

let socket: WebSocket | null = null;
let phase: Phase = 'idle';
/** Set while the feed is meant to be running. Cleared by `stopFeed` so retries stop. */
let wanted = false;
let attempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

/** Everything we have asked the feed for, so a reconnect can restore the subscription. */
const subscribed = new Set<string>();

let lastPacketAt = 0;
let lastConnectedAt = 0;
let packets = 0;
let decodeErrors = 0;
let connects = 0;
let lastError: { at: number; message: string } | null = null;

const note = (message: string): void => {
  lastError = { at: Date.now(), message };
};

/* --------------------------------------------------------------------- the socket --- */

async function authorize(): Promise<string> {
  const token = process.env.UPSTOX_ACCESS_TOKEN ?? '';
  if (!token) throw new Error('UPSTOX_ACCESS_TOKEN is not set');

  const res = await fetch(AUTHORIZE, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });

  const redirect = res.headers.get('location') ?? '';
  if (redirect.startsWith('wss://')) return redirect;

  const text = await res.text();
  if (res.status === 403)
    throw new Error(
      'the feed refused this token (403). An Analytics Token must be entitled to Websocket; ' +
      'run `npm run spike-ws` for the full diagnosis',
    );
  if (res.status === 401) throw new Error('the feed rejected this token (401) — it is revoked or mistyped');

  let parsed: { data?: { authorized_redirect_uri?: string; authorizedRedirectUri?: string } } | null = null;
  try { parsed = JSON.parse(text); } catch { /* handled below */ }
  const url = parsed?.data?.authorized_redirect_uri ?? parsed?.data?.authorizedRedirectUri ?? '';
  if (!url) throw new Error(`no wss:// URL in the authorize response (HTTP ${res.status})`);
  return url;
}

/** Send the current subscription in chunks. Used on connect and whenever keys are added. */
function sendSubscribe(keys: string[]): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || !keys.length) return;
  for (let i = 0; i < keys.length; i += SUB_CHUNK) {
    socket.send(subscribeFrame('sub', keys.slice(i, i + SUB_CHUNK), 'full'));
  }
}

function scheduleReconnect(): void {
  if (!wanted || reconnectTimer) return;
  const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, wait);
  reconnectTimer.unref?.();
}

async function connect(): Promise<void> {
  if (!wanted || phase === 'connecting' || phase === 'open') return;
  phase = 'connecting';

  let url: string;
  try {
    url = await authorize();
  } catch (e) {
    phase = 'closed';
    note(`authorize failed: ${(e as Error).message}`);
    scheduleReconnect();
    return;
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    phase = 'closed';
    note(`socket construction failed: ${(e as Error).message}`);
    scheduleReconnect();
    return;
  }

  ws.binaryType = 'arraybuffer';
  socket = ws;

  ws.onopen = () => {
    phase = 'open';
    attempt = 0;
    connects++;
    lastConnectedAt = Date.now();
    // Everything, not just the new keys: a reconnect is a fresh session upstream and the
    // previous subscription did not survive it.
    sendSubscribe([...subscribed]);
  };

  ws.onmessage = (ev: MessageEvent) => {
    packets++;
    const now = Date.now();
    try {
      const decoded = decodeFeed(new Uint8Array(ev.data as ArrayBuffer));
      // market_info carries segment statuses and no instrument data. It must NOT refresh the
      // freshness clock, or a feed sending nothing but status would read as healthy.
      if (!decoded.patches.length) return;
      for (const p of decoded.patches) applyPatch(p, now, decoded.currentTs);
      lastPacketAt = now;
    } catch (e) {
      decodeErrors++;
      note(`decode failed: ${(e as Error).message}`);
    }
  };

  ws.onerror = () => {
    note('socket error');
  };

  ws.onclose = (ev: CloseEvent) => {
    if (socket === ws) socket = null;
    phase = 'closed';
    if (wanted) {
      note(`socket closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`);
      scheduleReconnect();
    }
  };
}

/* ------------------------------------------------------------------- public surface --- */

/** Begin connecting, and keep reconnecting until `stopFeed`. Idempotent. */
export function startFeed(): void {
  if (!enabled() || wanted) return;
  wanted = true;
  attempt = 0;
  void connect();
}

/** Stop, and stay stopped. Clears the store so nothing stale can be served afterwards. */
export function stopFeed(): void {
  wanted = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try { socket?.close(); } catch { /* already closing */ }
  socket = null;
  phase = 'idle';
  ticks.clear();
  subscribed.clear();
  lastPacketAt = 0;
}

/**
 * Ask the feed for these instruments. Idempotent and cheap — only the keys not already
 * subscribed produce a frame, so a caller can pass its whole universe every cycle.
 *
 * That is what makes an expiry roll take care of itself: the new futures contract appears in
 * the universe, is not in `subscribed`, and is subscribed on the next scan without anything
 * having to notice that the roll happened.
 */
export function subscribeKeys(keys: Iterable<string>): void {
  if (!enabled()) return;
  const fresh: string[] = [];
  for (const k of keys) {
    if (k && !subscribed.has(k)) {
      subscribed.add(k);
      fresh.push(k);
    }
  }
  if (fresh.length && phase === 'open') sendSubscribe(fresh);
}

export const feedTick = (key: string): FeedTick | null => ticks.get(key) ?? null;

/** How many of `keys` the feed currently holds a reading for. */
export function feedCoverage(keys: string[]): number {
  if (!keys.length) return 0;
  let seen = 0;
  for (const k of keys) if (ticks.has(k)) seen++;
  return seen / keys.length;
}

/**
 * Whether this cycle may be served from the feed.
 *
 * `marketOpen` is passed in rather than imported: `session.ts` re-exports it from
 * `services.ts`, which imports `equity.ts`, which imports this module — reaching for it here
 * would close an import cycle. Both call sites already have the answer in hand.
 */
export function feedUsable(keys: string[], marketOpen: boolean, nowMs = Date.now()): boolean {
  if (!enabled() || phase !== 'open' || !lastPacketAt) return false;
  // Only while trading. After the close the feed stops sending because nothing is happening,
  // and the last print it sent is the correct answer until tomorrow.
  if (marketOpen && nowMs - lastPacketAt > STALE_MS) return false;
  return feedCoverage(keys) >= MIN_COVERAGE;
}

export interface FeedStatus {
  enabled: boolean;
  phase: Phase;
  subscribed: number;
  instruments: number;
  packets: number;
  decodeErrors: number;
  connects: number;
  lastPacketAt: number;
  lastConnectedAt: number;
  ageMs: number | null;
  lastError: { at: number; message: string } | null;
}

export function feedStatus(nowMs = Date.now()): FeedStatus {
  return {
    enabled: enabled(),
    phase,
    subscribed: subscribed.size,
    instruments: ticks.size,
    packets,
    decodeErrors,
    connects,
    lastPacketAt,
    lastConnectedAt,
    ageMs: lastPacketAt ? nowMs - lastPacketAt : null,
    lastError,
  };
}

/** Test seam — drop all state without touching the socket lifecycle. */
export function resetFeedStore(): void {
  ticks.clear();
  subscribed.clear();
  lastPacketAt = 0;
  packets = 0;
  decodeErrors = 0;
}

/** Test seam — inject a decoded packet as though it had arrived on the wire. */
export function injectPatches(patches: TickPatch[], at = Date.now(), feedTs = 0): void {
  for (const p of patches) applyPatch(p, at, feedTs);
  if (patches.length) lastPacketAt = at;
}

/** Test seam — pretend the socket is open, so `feedUsable` can be exercised. */
export function setPhaseForTest(p: Phase): void {
  phase = p;
}
