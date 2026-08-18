// The Upstox Market Data Feed V3 wire format, decoded.
//
// Hand-rolled rather than `protobufjs`, and that is a deliberate trade. The schema is
// vendored beside this file as MarketDataFeedV3.proto, it is sixty lines long, and it has
// changed once in the life of the V3 feed. Against that, `protobufjs` is a production
// dependency in a service that currently has two, plus a build step to generate bindings, or
// a runtime .proto load that can fail at boot on a file this is perfectly capable of
// parsing itself. Only three of the four proto3 wire types occur here.
//
// proto3 wire format: each field is a varint tag, `(fieldNumber << 3) | wireType`, then a
// payload whose shape the wire type gives.
//
//     0  varint            int64, enum
//     1  fixed64           double
//     2  length-delimited  string, bytes, embedded message, map entry
//     5  fixed32           (declared for completeness; this schema never uses it)
//
// THE ONE THING THAT IS NOT OBVIOUS. proto3 does not transmit a field whose value is the
// type's default, so a `double` of 0 and an absent `double` are the same bytes on the wire.
// That is why this module reports PRESENCE rather than values — see `TickPatch` — and why
// the store merges patches instead of replacing ticks. Reading an omitted `atp` as 0 would
// zero the session VWAP for an instrument that simply had nothing new to say, and the VWAP
// factor would price it as if the stock had never traded.

/* --------------------------------------------------------------------- wire format --- */

interface RawField {
  wire: number;
  value: bigint | number | Uint8Array;
}
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
      if (p + size > b.length) throw new Error('length-delimited field ran past the end of the buffer');
      push(field, { wire, value: b.subarray(p, p + size) });
      p += size;
    } else if (wire === 5) {
      push(field, { wire, value: view.getFloat32(p, true) });
      p += 4;
    } else {
      // Not skippable: without knowing the payload length there is no way to find the next
      // tag, so the rest of the buffer is unreadable. Better to fail this packet loudly.
      throw new Error(`unsupported protobuf wire type ${wire} on field ${field}`);
    }
  }
  return out;
}

/** Last value wins, which is proto3's rule for a non-repeated field sent twice. */
const last = (m: Message, field: number): RawField | undefined => m.get(field)?.at(-1);

const sub = (m: Message | null, field: number): Message | null => {
  const f = m ? last(m, field) : undefined;
  return f && f.value instanceof Uint8Array ? parse(f.value) : null;
};

const repeated = (m: Message | null, field: number): Message[] =>
  (m?.get(field) ?? [])
    .filter((f) => f.value instanceof Uint8Array)
    .map((f) => parse(f.value as Uint8Array));

/** A `double`, or undefined when the field was not on the wire at all. */
const dbl = (m: Message | null, field: number): number | undefined => {
  const f = m ? last(m, field) : undefined;
  return f && f.wire === 1 ? (f.value as number) : undefined;
};

/** An `int64`. Returned as a JS number — every count in this schema is far inside 2^53. */
const int = (m: Message | null, field: number): number | undefined => {
  const f = m ? last(m, field) : undefined;
  return f && f.wire === 0 ? Number(f.value as bigint) : undefined;
};

const str = (m: Message | null, field: number): string => {
  const f = m ? last(m, field) : undefined;
  return f && f.value instanceof Uint8Array ? new TextDecoder().decode(f.value) : '';
};

/* ------------------------------------------------------------------- what we keep --- */

export interface DepthLevel {
  bidP: number;
  bidQ: number;
  askP: number;
  askQ: number;
}

/**
 * One instrument's fields as they arrived in ONE packet.
 *
 * Every field is optional, and that is the whole point: `undefined` means "this packet did
 * not carry it", which is different from zero. The store keeps the previous value for those.
 */
export interface TickPatch {
  instrumentKey: string;
  /** True when the feed answered with an IndexFullFeed, which has no atp/vtt/oi/depth. */
  isIndex: boolean;
  ltp?: number;
  /** Previous session's close, from LTPC. The base for `changePct`. */
  cp?: number;
  /** Last-traded quantity and time, straight off LTPC. */
  ltq?: number;
  ltt?: number;
  /** Average traded price — verified identical to REST `average_price`, i.e. session VWAP. */
  atp?: number;
  /** Volume traded today. */
  vtt?: number;
  oi?: number;
  tbq?: number;
  tsq?: number;
  iv?: number;
  dayOpen?: number;
  dayHigh?: number;
  dayLow?: number;
  /** Five levels a side. Absent when the packet carried no MarketLevel at all. */
  depth?: DepthLevel[];
}

export const FEED_TYPE = { initial: 0, live: 1, marketInfo: 2 } as const;

export interface DecodedFeed {
  /** 0 initial_feed, 1 live_feed, 2 market_info. */
  type: number;
  /** Upstox's own stamp for the packet, epoch ms. 0 when absent. */
  currentTs: number;
  patches: TickPatch[];
  /** Segment count from a market_info packet, for logging. */
  segments: number;
}

/**
 * Decode one FeedResponse.
 *
 * `feeds` is a proto3 map, which on the wire is a repeated message of `{1: key, 2: value}` —
 * the encoding has no map type, only that convention.
 *
 * Throws on a malformed buffer. The caller is expected to catch and count, not to die: one
 * bad packet must not take down a feed that is otherwise healthy.
 */
export function decodeFeed(bytes: Uint8Array): DecodedFeed {
  const root = parse(bytes);
  const type = int(root, 1) ?? 0;
  const currentTs = int(root, 3) ?? 0;
  const segments = repeated(sub(root, 4), 1).length;

  const patches: TickPatch[] = [];

  for (const entry of repeated(root, 2)) {
    const instrumentKey = str(entry, 1);
    if (!instrumentKey) continue;
    const feed = sub(entry, 2);
    if (!feed) continue;

    // Feed.FeedUnion — 1 ltpc, 2 fullFeed, 3 firstLevelWithGreeks.
    const fullFeed = sub(feed, 2);
    const marketFF = sub(fullFeed, 1);
    const indexFF = sub(fullFeed, 2);
    const greeksFF = sub(feed, 3);
    const isIndex = !!indexFF;

    // LTPC sits at field 1 of every one of those shapes, and is the bare union member too.
    const body = marketFF ?? indexFF ?? greeksFF;
    const ltpc = body ? sub(body, 1) : sub(feed, 1);

    // MarketFullFeed.marketOHLC is field 4; IndexFullFeed.marketOHLC is field 2.
    const marketOHLC = marketFF ? sub(marketFF, 4) : indexFF ? sub(indexFF, 2) : null;
    // "1d" is the day candle — the equivalent of REST's `ohlc.open/high/low`. The feed also
    // offers "I1" one-minute candles, which nothing reads yet.
    const day = marketOHLC ? repeated(marketOHLC, 1).find((r) => str(r, 1) === '1d') ?? null : null;

    const patch: TickPatch = { instrumentKey, isIndex };

    const set = <K extends keyof TickPatch>(k: K, v: TickPatch[K] | undefined) => {
      if (v !== undefined) patch[k] = v;
    };

    set('ltp', dbl(ltpc, 1));
    set('ltt', int(ltpc, 2));
    set('ltq', int(ltpc, 3));
    set('cp', dbl(ltpc, 4));

    if (marketFF) {
      set('atp', dbl(marketFF, 5));
      set('vtt', int(marketFF, 6));
      set('oi', dbl(marketFF, 7));
      set('iv', dbl(marketFF, 8));
      set('tbq', dbl(marketFF, 9));
      set('tsq', dbl(marketFF, 10));
    } else if (greeksFF) {
      // FirstLevelWithGreeks: vtt 4, oi 5, iv 6. No atp — option_greeks mode is not used by
      // the quote tier, but decoding it keeps the mode usable without a second decoder.
      set('vtt', int(greeksFF, 4));
      set('oi', dbl(greeksFF, 5));
      set('iv', dbl(greeksFF, 6));
    }

    if (day) {
      set('dayOpen', dbl(day, 2));
      set('dayHigh', dbl(day, 3));
      set('dayLow', dbl(day, 4));
    }

    const marketLevel = marketFF ? sub(marketFF, 2) : null;
    if (marketLevel) {
      patch.depth = repeated(marketLevel, 1).map((q) => ({
        bidQ: int(q, 1) ?? 0,
        bidP: dbl(q, 2) ?? 0,
        askQ: int(q, 3) ?? 0,
        askP: dbl(q, 4) ?? 0,
      }));
    }

    patches.push(patch);
  }

  return { type, currentTs, patches, segments };
}

/** Build the subscribe/unsubscribe frame the feed expects. It must be sent as BINARY. */
export function subscribeFrame(
  method: 'sub' | 'unsub' | 'change_mode',
  instrumentKeys: string[],
  mode: 'ltpc' | 'full' | 'option_greeks' | 'full_d30' = 'full',
): Uint8Array {
  const guid = `trinetra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new TextEncoder().encode(JSON.stringify({ guid, method, data: { mode, instrumentKeys } }));
}
