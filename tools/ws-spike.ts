// Upstox WebSocket feasibility spike.  Run: npm run spike-ws
//
// This answers the two questions that decide whether the live-quote tier can move off
// `/v2/market-quote/quotes` and onto the streaming feed. Neither is answerable from the
// documentation, which is why this exists rather than a design note.
//
//   1. DOES THE ANALYTICS TOKEN REACH THE FEED AT ALL?
//      Upstox's Analytics Token page lists "Websocket" among the scopes that need no static
//      IP. Several community reports say otherwise — a bare HTTP 403 from
//      /v3/feed/market-data-feed/authorize while every REST endpoint keeps working — and as
//      of 2026-08-18 that thread has no answer from Upstox:
//        community.upstox.com/t/analytics-token-works-for-rest-apis-but-market-data-feed-authorize-v3-returns-http-403/17110
//      If that is our token too, the whole migration is blocked, because the alternative is
//      the daily OAuth token that expires at 03:30 IST — which is exactly what `upstox.ts`
//      chose the Analytics Token to avoid. Phase 1 settles it in one request.
//
//   2. IS `atp` THE SAME NUMBER AS `average_price`?
//      The entire VWAP factor, and the VWAP-side share behind every conviction reading, rests
//      on `average_price` being the SESSION VWAP — verified once against candles and
//      documented in `momentum/data/quotes.ts`. The feed's equivalent is called "average
//      traded price" and the proto says nothing more. If it is a rolling or per-packet average
//      instead, swapping the source silently rewrites every VWAP-derived number on the board.
//      Phase 4 compares the two readings side by side, on the same instruments, seconds apart.
//
// It also confirms two things the schema already implies, because "the proto does not list it"
// and "the wire does not carry it" are different claims and only one of them is checked by
// reading a file:
//
//   - `Quote` has no order-count field, so `orderImbalance` in `liquidity.service.ts` has no
//     streaming equivalent and would have to be dropped or sourced separately.
//   - `IndexFullFeed` carries only LTPC and OHLC — no `atp`, no `vtt`. Harmless as the code
//     stands (indices are read for `changePct` alone) but it is a trap for anyone who later
//     asks an index for its VWAP and silently gets zero.
//
// NOTHING HERE IS WIRED INTO THE APP. It is a read-only probe: one authorize call, one socket,
// one REST quote, and it exits. It is safe to run during market hours or outside them — see
// the note above Phase 3 for what changes.

import '../src/env.js';
import { call, tokenSet } from '../src/upstox.js';
import { instruments, nearFuture } from '../src/equity.js';

/* ------------------------------------------------------------------ protobuf decode --- */
//
// Hand-rolled rather than `protobufjs`, because this project runs on two production
// dependencies and a throwaway probe is a bad reason to add a third. The schema is vendored at
// `src/feed/MarketDataFeedV3.proto` and is small enough to read in one sitting; only four wire
// types exist and this needs three of them.
//
// This decoder is deliberately NOT shared with `src/feed/proto.ts`. That one merged into the
// production path and reports field PRESENCE so the store can tell an omitted field from a
// zero; this one only has to print what arrived once. Keeping them apart means the probe can
// still be run to diagnose a feed whose decoder is the thing under suspicion.
//
// proto3 wire format: each field is a varint tag, `(fieldNumber << 3) | wireType`, then a
// payload whose shape the wire type gives.
//    0 varint            int64, enum
//    1 fixed64           double
//    2 length-delimited  string, bytes, embedded message, map entry
//    5 fixed32           (unused by this schema)

interface RawField { wire: number; value: bigint | number | Uint8Array }
type Message = Map<number, RawField[]>;

function readVarint(b: Uint8Array, p: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (p >= b.length) throw new Error('varint ran past the end of the buffer');
    const byte = b[p++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, p];
    shift += 7n;
    if (shift > 63n) throw new Error('varint longer than 64 bits');
  }
}

function parse(b: Uint8Array): Message {
  const out: Message = new Map();
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;

  const push = (field: number, f: RawField) => {
    const list = out.get(field);
    if (list) list.push(f);
    else out.set(field, [f]);
  };

  while (p < b.length) {
    const [tag, next] = readVarint(b, p);
    p = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);

    if (wire === 0) {
      const [v, n] = readVarint(b, p);
      p = n;
      push(field, { wire, value: v });
    } else if (wire === 1) {
      push(field, { wire, value: view.getFloat64(p, true) });
      p += 8;
    } else if (wire === 2) {
      const [len, n] = readVarint(b, p);
      p = n;
      const size = Number(len);
      push(field, { wire, value: b.subarray(p, p + size) });
      p += size;
    } else if (wire === 5) {
      push(field, { wire, value: view.getFloat32(p, true) });
      p += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire} on field ${field}`);
    }
  }
  return out;
}

/** Last value wins, which is proto3's rule for a non-repeated field sent twice. */
const last = (m: Message, field: number): RawField | undefined => m.get(field)?.at(-1);

const sub = (m: Message, field: number): Message | null => {
  const f = last(m, field);
  return f && f.value instanceof Uint8Array ? parse(f.value) : null;
};

const repeated = (m: Message, field: number): Message[] =>
  (m.get(field) ?? [])
    .filter((f) => f.value instanceof Uint8Array)
    .map((f) => parse(f.value as Uint8Array));

/** A `double`. Absent reads 0, which is proto3's default and indistinguishable from a real 0. */
const dbl = (m: Message | null, field: number): number => {
  const f = m ? last(m, field) : undefined;
  return f && f.wire === 1 ? (f.value as number) : 0;
};

/** An `int64`. Returned as a JS number — every count here is far inside 2^53. */
const int = (m: Message | null, field: number): number => {
  const f = m ? last(m, field) : undefined;
  return f && f.wire === 0 ? Number(f.value as bigint) : 0;
};

const str = (m: Message | null, field: number): string => {
  const f = m ? last(m, field) : undefined;
  return f && f.value instanceof Uint8Array ? new TextDecoder().decode(f.value) : '';
};

/** Whether a field was actually on the wire, as opposed to defaulting to zero. */
const present = (m: Message | null, field: number): boolean => !!(m && m.has(field));

/* -------------------------------------------------------- the shape we care about --- */

interface FeedQuote {
  instrumentKey: string;
  kind: 'market' | 'index' | 'ltpc-only' | 'unknown';
  ltp: number;
  cp: number;
  atp: number;
  vtt: number;
  oi: number;
  tbq: number;
  tsq: number;
  /** Whether MarketFullFeed.atp / .vtt were on the wire at all. */
  hasAtp: boolean;
  hasVtt: boolean;
  depthLevels: number;
  bidP: number;
  askP: number;
  bidQ: number;
  askQ: number;
  /**
   * Every field number seen inside ANY depth `Quote`, unioned across all five levels.
   *
   * Unioned rather than read off the top level because proto3 omits zero-valued fields: a
   * one-sided book — which is what the post-close auction leaves behind — carries only {3,4},
   * and reading that alone would say nothing about whether a bid-side order count exists. The
   * union over every level is the widest evidence one packet can give.
   */
  quoteFields: number[];
  ohlcIntervals: string[];
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
}

/**
 * Decode one FeedResponse into the fields the scanner would need.
 *
 * `feeds` is a proto3 map, which on the wire is a repeated message of {1: key, 2: value} —
 * there is no map type in the encoding, only that convention.
 */
function decodeFeedResponse(
  bytes: Uint8Array,
): { type: number; ts: number; quotes: FeedQuote[]; segments: number } {
  const root = parse(bytes);
  const type = int(root, 1);
  const ts = int(root, 3);
  const info = sub(root, 4);
  const segments = info ? repeated(info, 1).length : 0;

  const quotes: FeedQuote[] = [];
  for (const entry of repeated(root, 2)) {
    const key = str(entry, 1);
    const feed = sub(entry, 2);
    if (!feed) continue;

    const fullFeed = sub(feed, 2);
    const marketFF = fullFeed ? sub(fullFeed, 1) : null;
    const indexFF = fullFeed ? sub(fullFeed, 2) : null;
    const bareLtpc = sub(feed, 1);

    const body = marketFF ?? indexFF;
    const ltpc = body ? sub(body, 1) : bareLtpc;

    // MarketFullFeed.marketOHLC is field 4; IndexFullFeed.marketOHLC is field 2.
    const marketOHLC = marketFF ? sub(marketFF, 4) : indexFF ? sub(indexFF, 2) : null;
    const ohlcRows = marketOHLC ? repeated(marketOHLC, 1) : [];
    // "1d" is the day candle — the equivalent of REST's `ohlc.open/high/low`.
    const day = ohlcRows.find((r) => str(r, 1) === '1d') ?? null;

    const marketLevel = marketFF ? sub(marketFF, 2) : null;
    const levels = marketLevel ? repeated(marketLevel, 1) : [];
    const top = levels[0] ?? null;

    quotes.push({
      instrumentKey: key,
      kind: marketFF ? 'market' : indexFF ? 'index' : bareLtpc ? 'ltpc-only' : 'unknown',
      ltp: dbl(ltpc, 1),
      cp: dbl(ltpc, 4),
      atp: dbl(marketFF, 5),
      vtt: int(marketFF, 6),
      oi: dbl(marketFF, 7),
      tbq: dbl(marketFF, 9),
      tsq: dbl(marketFF, 10),
      hasAtp: present(marketFF, 5),
      hasVtt: present(marketFF, 6),
      depthLevels: levels.length,
      bidP: dbl(top, 2),
      askP: dbl(top, 4),
      bidQ: int(top, 1),
      askQ: int(top, 3),
      quoteFields: [...new Set(levels.flatMap((l) => [...l.keys()]))].sort((a, b) => a - b),
      ohlcIntervals: ohlcRows.map((r) => str(r, 1)).filter(Boolean),
      dayOpen: dbl(day, 2),
      dayHigh: dbl(day, 3),
      dayLow: dbl(day, 4),
    });
  }
  return { type, ts, quotes, segments };
}

/* ------------------------------------------------------------------------- output --- */

const pad = (s: string, n: number) => s.padEnd(n);
const money = (n: number) => (n ? n.toFixed(2) : '—');
const bigNum = (n: number) => (n ? Math.round(n).toLocaleString('en-IN') : '—');
const TYPE_NAME: Record<number, string> = { 0: 'initial_feed', 1: 'live_feed', 2: 'market_info' };

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/* ----------------------------------------------------------------- phase 1: token --- */

if (!tokenSet()) {
  fail(
    'UPSTOX_ACCESS_TOKEN is not set.\n\n' +
    '  Put your Upstox Analytics Token in api/.env, the same one the REST tier uses:\n\n' +
    '      UPSTOX_ACCESS_TOKEN=<paste it here>\n',
  );
}

console.log('\n  UPSTOX WEBSOCKET SPIKE\n  ' + '='.repeat(70) + '\n');
console.log('  PHASE 1 — can this token open a feed at all?\n');

const AUTHORIZE = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';

let feedUrl = '';
{
  const res = await fetch(AUTHORIZE, {
    headers: { Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`, Accept: 'application/json' },
    // Deliberately NOT followed: the authorized URL is the thing being tested, and a client
    // that redirects automatically would hide whether we were handed one.
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  console.log(`  GET ${AUTHORIZE}`);
  console.log(`      -> HTTP ${res.status}`);

  if (res.status === 403) {
    fail(
      'BLOCKED. The Analytics Token is refused by the feed authorize endpoint.\n\n' +
      `      body: ${text.trim() || '(empty — which is the signature of the reported bug)'}\n\n` +
      '  This is the known, unresolved issue: REST works, the feed does not. It means the\n' +
      '  WebSocket migration cannot proceed on this token.\n\n' +
      '  Options, in the order worth trying:\n' +
      '    1. Ask Upstox to enable the feed scope on this app. The community thread has no\n' +
      '       answer, so a direct support ticket is the only route.\n' +
      '    2. Re-generate the Analytics Token — the scope list may be stamped at generation,\n' +
      '       in which case a token minted before Websocket was added would lack it.\n' +
      '    3. Do NOT fall back to the daily OAuth token. It expires 03:30 IST and would take\n' +
      '       the board dark every morning, which is the failure upstox.ts was built to avoid.',
    );
  }

  if (res.status === 401) {
    fail(
      'The token was rejected outright (401). An Analytics Token is revoked the moment a new\n' +
      '  one is generated — check api/.env holds the current one, then re-run.',
    );
  }

  // A 3xx here is success in a different shape: some clients are meant to follow it.
  const redirect = res.headers.get('location') ?? '';
  if (redirect.startsWith('wss://')) {
    feedUrl = redirect;
  } else {
    let parsed: { data?: { authorized_redirect_uri?: string; authorizedRedirectUri?: string } } | null = null;
    try { parsed = JSON.parse(text); } catch { /* reported below */ }
    feedUrl = parsed?.data?.authorized_redirect_uri ?? parsed?.data?.authorizedRedirectUri ?? '';
  }

  if (!feedUrl) {
    fail(`No wss:// URL came back, and this is neither a 401 nor a 403.\n\n      body: ${text.slice(0, 400)}`);
  }

  // The URL carries the credential in its query string. Printing it whole would put a live
  // feed token into a terminal log, so only its shape is shown.
  console.log(`      -> authorized: ${feedUrl.split('?')[0]}?<redacted>`);
  console.log('\n  PASS — the Analytics Token reaches the feed. The migration is not blocked.\n');
}

/* ------------------------------------------------------ phase 2: what to subscribe --- */

console.log('  PHASE 2 — resolving instruments\n');

const master = await instruments();

// Three equities the VWAP claim was originally verified on (see quotes.ts), plus an index and
// a future — one of each feed shape the union can produce, so the decode is exercised across
// MarketFullFeed and IndexFullFeed rather than only the common case.
const WANTED = ['RELIANCE', 'SBIN', 'TATASTEEL'];

const targets = new Map<string, string>(); // instrument key -> label
for (const sym of WANTED) {
  const key = master.equity[sym];
  if (key) targets.set(key, sym);
  else console.log(`  ! ${sym} has no equity key in the master — skipped`);
}
const niftyKey = master.indices['NIFTY'];
if (niftyKey) targets.set(niftyKey, 'NIFTY (index)');
const niftyFut = await nearFuture('NIFTY');
if (niftyFut) targets.set(niftyFut.instrumentKey, 'NIFTY FUT');

if (!targets.size) fail('Could not resolve a single instrument key from the master.');

for (const [key, label] of targets) console.log(`  ${pad(label, 15)}${key}`);
console.log(`\n  ${targets.size} instruments, mode "full".\n`);

/* -------------------------------------------------------------- phase 3: the feed --- */
//
// WHAT CHANGES OUTSIDE MARKET HOURS. The feed still sends a snapshot on connect — the last
// print of the session — so the atp/average_price comparison is still valid, both sides simply
// being frozen at their closing values. What goes quiet is `live_feed`: no further packets
// arrive, and the depth is five levels of zeros because there is no book. That is the same
// absence `hasBook` already models on the REST side, and it is reported rather than treated as
// a failure.

console.log('  PHASE 3 — connecting\n');

const COLLECT_MS = 20_000;

const socket = new WebSocket(feedUrl);
socket.binaryType = 'arraybuffer';

const latest = new Map<string, FeedQuote>();
let packets = 0;
let liveFeeds = 0;
let marketInfoSeen = false;
let decodeError = '';

await new Promise<void>((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    try { socket.close(); } catch { /* already closing */ }
    resolve();
  };

  const deadline = setTimeout(finish, COLLECT_MS);
  deadline.unref?.();

  socket.onopen = () => {
    console.log('  socket open — subscribing\n');
    const frame = {
      guid: `spike-${Date.now().toString(36)}`,
      method: 'sub',
      data: { mode: 'full', instrumentKeys: [...targets.keys()] },
    };
    // The feed takes the subscribe frame as BINARY, not text. Sent as a string it is accepted
    // by the socket and then silently ignored, which looks exactly like a feed that has
    // nothing to say.
    socket.send(new TextEncoder().encode(JSON.stringify(frame)));
  };

  socket.onmessage = (ev: MessageEvent) => {
    packets++;
    try {
      const decoded = decodeFeedResponse(new Uint8Array(ev.data as ArrayBuffer));
      if (decoded.type === 2) {
        marketInfoSeen = true;
        console.log(`  packet ${pad(String(packets), 4)}market_info — ${decoded.segments} segment statuses`);
      } else {
        if (decoded.type === 1) liveFeeds++;
        for (const q of decoded.quotes) latest.set(q.instrumentKey, q);
        console.log(
          `  packet ${pad(String(packets), 4)}${pad(TYPE_NAME[decoded.type] ?? `type ${decoded.type}`, 14)}` +
          `${decoded.quotes.length} instrument(s), ${latest.size}/${targets.size} seen`,
        );
      }
    } catch (e) {
      decodeError ||= (e as Error).message;
      console.log(`  packet ${pad(String(packets), 4)}DECODE FAILED — ${(e as Error).message}`);
    }
    // Everything asked for has reported and at least one live update has landed: nothing
    // further is learned by holding the socket open.
    if (latest.size >= targets.size && liveFeeds > 0) finish();
  };

  socket.onerror = () => { console.log('  socket error'); };

  socket.onclose = (ev: CloseEvent) => {
    // Only worth reporting when the far end hung up on us. A close we asked for arrives after
    // the run has already moved on, and logging it there interleaves into the next phase.
    if (!settled) console.log(`\n  socket closed by peer (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`);
    finish();
  };
});

if (!latest.size) {
  fail(
    'The socket connected but no instrument data arrived.\n\n' +
    `      packets seen: ${packets}${marketInfoSeen ? ' (market_info only)' : ''}\n` +
    (decodeError ? `      first decode error: ${decodeError}\n` : '') +
    '\n  If packets were zero, the subscribe frame was refused — check the instrument keys.\n' +
    '  If only market_info arrived, the keys were accepted but matched nothing.',
  );
}

/* -------------------------------------------------------- phase 4: the comparison --- */

console.log('\n  PHASE 4 — feed vs REST, same instruments\n');

interface RestQuote {
  instrument_token?: string;
  last_price?: number;
  average_price?: number | null;
  volume?: number | null;
  oi?: number | null;
  depth?: { buy?: Array<{ price?: number; quantity?: number; orders?: number }> };
}

const rest = new Map<string, RestQuote>();
{
  const keys = [...targets.keys()];
  const data = await call<Record<string, RestQuote>>(
    `/v2/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(','))}`,
  );
  for (const q of Object.values(data ?? {})) if (q.instrument_token) rest.set(String(q.instrument_token), q);
}

const drift = (a: number, b: number) => (b > 0 ? Math.abs(a - b) / b : a === b ? 0 : 1);
const pct = (n: number) => `${(n * 100).toFixed(4)}%`;

console.log(
  `  ${pad('instrument', 15)}${pad('kind', 9)}${pad('ltp  ws / rest', 22)}` +
  `${pad('atp vs average_price', 30)}vtt vs volume`,
);
console.log('  ' + '-'.repeat(100));

let atpChecked = 0;
let atpWorst = 0;
let vttMismatch = 0;

for (const [key, label] of targets) {
  const ws = latest.get(key);
  const rq = rest.get(key);
  if (!ws) { console.log(`  ${pad(label, 15)}(no feed data)`); continue; }
  if (!rq) { console.log(`  ${pad(label, 15)}(no REST data)`); continue; }

  const restAtp = rq.average_price ?? 0;
  const restVol = rq.volume ?? 0;
  const restLtp = rq.last_price ?? 0;

  let atpCell: string;
  if (!ws.hasAtp) {
    atpCell = 'absent on feed';
  } else if (restAtp <= 0) {
    atpCell = `${money(ws.atp)} / REST 0`;
  } else {
    const d = drift(ws.atp, restAtp);
    atpChecked++;
    atpWorst = Math.max(atpWorst, d);
    atpCell = `${money(ws.atp)} / ${money(restAtp)}  ${pct(d)}`;
  }

  let vttCell: string;
  if (!ws.hasVtt) {
    vttCell = 'absent on feed';
  } else {
    if (restVol > 0 && drift(ws.vtt, restVol) > 0.02) vttMismatch++;
    vttCell = `${bigNum(ws.vtt)} / ${bigNum(restVol)}`;
  }

  console.log(
    `  ${pad(label, 15)}${pad(ws.kind, 9)}${pad(`${money(ws.ltp)} / ${money(restLtp)}`, 22)}` +
    `${pad(atpCell, 30)}${vttCell}`,
  );
}

/* -------------------------------------------------------------- phase 5: the gaps --- */

console.log('\n  PHASE 5 — fields the scanner reads that the feed may not carry\n');

const anyMarket = [...latest.values()].find((q) => q.kind === 'market');
const anyIndex = [...latest.values()].find((q) => q.kind === 'index');
// Open interest has to be read off a DERIVATIVE. An equity's `oi` is legitimately 0 — which is
// exactly why `universe.ts` routes the OI factor to the future — so checking it on the share
// would report a working field as missing.
const anyFuture = [...latest.values()].find((q) => q.instrumentKey.startsWith('NSE_FO|'));

// The order-count question, answered off the wire rather than off the schema. `Quote` in
// MarketDataFeedV3.proto declares exactly four fields; anything beyond {1,2,3,4} appearing here
// would mean the wire carries more than the schema admits.
let orderCountsOnFeed = false;
if (anyMarket) {
  orderCountsOnFeed = anyMarket.quoteFields.some((f) => f > 4);
  const restDepth = rest.get(anyMarket.instrumentKey)?.depth?.buy?.[0];
  const hasRestOrders = typeof restDepth?.orders === 'number';
  console.log(`  depth levels on feed        ${anyMarket.depthLevels}`);
  console.log(
    `  fields in a depth Quote     {${anyMarket.quoteFields.join(', ')}}` +
    '   (proto: 1=bidQ 2=bidP 3=askQ 4=askP)',
  );
  console.log(
    `  order counts                feed: ${orderCountsOnFeed ? 'PRESENT (undocumented!)' : 'ABSENT'}` +
    `   REST: ${hasRestOrders ? `present (${restDepth?.orders})` : 'absent'}`,
  );
  console.log(
    `  day OHLC on feed            open ${money(anyMarket.dayOpen)}  ` +
    `high ${money(anyMarket.dayHigh)}  low ${money(anyMarket.dayLow)}`,
  );
  console.log(`  OHLC intervals offered      ${anyMarket.ohlcIntervals.join(', ') || '(none)'}`);
  console.log(`  tbq / tsq                   ${bigNum(anyMarket.tbq)} / ${bigNum(anyMarket.tsq)}`);
  console.log(
    `  top of book                 ${anyMarket.bidQ} @ ${money(anyMarket.bidP)}  /  ` +
    `${money(anyMarket.askP)} @ ${anyMarket.askQ}` +
    (anyMarket.bidP > 0 && anyMarket.askP > 0 ? '' : '   (one-sided — no live book)'),
  );
}

if (anyFuture) {
  console.log(`  oi (on the future)          ${bigNum(anyFuture.oi)}`);
}

if (anyIndex) {
  console.log(
    `\n  index feed shape            atp ${anyIndex.hasAtp ? 'present' : 'ABSENT'}, ` +
    `vtt ${anyIndex.hasVtt ? 'present' : 'ABSENT'}, ` +
    `ohlc [${anyIndex.ohlcIntervals.join(', ') || 'none'}]`,
  );
  console.log('                              (harmless as the code stands — indices are read for changePct only)');
}

/* ---------------------------------------------------------------- the conclusion --- */

console.log('\n  ' + '='.repeat(70));
console.log('  VERDICT\n');

const atpOk = atpChecked > 0 && atpWorst < 0.001;
const notes: string[] = [];

console.log('  authorize            PASS — Analytics Token opens the feed');
console.log(`  packets decoded      ${packets} (${liveFeeds} live_feed)${decodeError ? '  [with errors]' : ''}`);

if (atpChecked === 0) {
  console.log('  atp == average_price UNPROVEN — no instrument had a non-zero average_price');
  notes.push(
    're-run during market hours: before the first trade of the day `average_price` is 0 on\n' +
    '    both sides, so the comparison has nothing to compare.',
  );
} else if (atpOk) {
  console.log(`  atp == average_price PASS — worst drift ${pct(atpWorst)} across ${atpChecked} instruments`);
} else {
  console.log(`  atp == average_price FAIL — worst drift ${pct(atpWorst)} across ${atpChecked} instruments`);
  notes.push(
    '`atp` is NOT the session VWAP. Do not swap the VWAP source: every VWAP-derived reading\n' +
    '    — the factor, the side share, the conviction behind the alerts — would move.',
  );
}

if (vttMismatch) {
  notes.push(
    `${vttMismatch} instrument(s) disagreed on volume by more than 2%. Expected if the two\n` +
    '    readings straddled a burst of trades; worth a second run if it persists.',
  );
}
if (anyMarket && !orderCountsOnFeed) {
  notes.push(
    'no order counts on the feed, as the schema said. `orderImbalance` in\n' +
    '    liquidity.service.ts has no streaming equivalent — drop it, or keep a slow REST\n' +
    '    quote purely to feed it.',
  );
}
if (!liveFeeds) {
  notes.push(
    'no live_feed packets arrived — only the connect snapshot. Outside market hours that is\n' +
    '    correct and expected; during market hours it would mean the subscription is not\n' +
    '    actually streaming.',
  );
}

if (notes.length) {
  console.log('\n  NOTES\n');
  for (const n of notes) console.log(`  - ${n}`);
}

console.log('');
process.exit(atpChecked > 0 && !atpOk ? 1 : 0);
