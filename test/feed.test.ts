// The live feed: wire decoding, merge semantics, and the gate that decides whether a cycle
// is allowed to trust it.
//
// The packets here are built BYTE BY BYTE from MarketDataFeedV3.proto rather than captured
// from a live socket. That is deliberate: a captured packet proves the decoder agrees with
// one recording, whereas a constructed one can exercise the case that actually matters and
// cannot be captured on demand — a live update that omits a field because its value happens
// to equal the proto3 default. That omission is indistinguishable from "unchanged" on the
// wire, and reading it as zero would blank the session VWAP of a stock that simply had
// nothing new to say.

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { decodeFeed, subscribeFrame } from '../src/feed/proto.js';
import {
  feedCoverage, feedTick, feedUsable, injectPatches, resetFeedStore, setPhaseForTest,
} from '../src/feed/client.js';
import { fromTick } from '../src/momentum/data/quotes.js';

/* ------------------------------------------------------------------ a tiny encoder --- */

const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = BigInt(Math.trunc(n));
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
};

const f64 = (v: number): number[] => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return [...b];
};

const tag = (field: number, wire: number): number[] => varint((field << 3) | wire);
const pDbl = (field: number, v: number): number[] => [...tag(field, 1), ...f64(v)];
const pInt = (field: number, v: number): number[] => [...tag(field, 0), ...varint(v)];
const pLen = (field: number, body: number[]): number[] => [...tag(field, 2), ...varint(body.length), ...body];
const pStr = (field: number, s: string): number[] => pLen(field, [...new TextEncoder().encode(s)]);

/** LTPC { ltp=1, ltt=2, ltq=3, cp=4 } */
const ltpc = (o: { ltp?: number; ltt?: number; ltq?: number; cp?: number }): number[] => [
  ...(o.ltp !== undefined ? pDbl(1, o.ltp) : []),
  ...(o.ltt !== undefined ? pInt(2, o.ltt) : []),
  ...(o.ltq !== undefined ? pInt(3, o.ltq) : []),
  ...(o.cp !== undefined ? pDbl(4, o.cp) : []),
];

/** Quote { bidQ=1, bidP=2, askQ=3, askP=4 } */
const quote = (bidQ: number, bidP: number, askQ: number, askP: number): number[] => [
  ...pInt(1, bidQ), ...pDbl(2, bidP), ...pInt(3, askQ), ...pDbl(4, askP),
];

/** MarketLevel { bidAskQuote=1 repeated } */
const marketLevel = (levels: number[][]): number[] => levels.flatMap((l) => pLen(1, l));

/** OHLC { interval=1, open=2, high=3, low=4, close=5, vol=6, ts=7 } */
const ohlc = (interval: string, open: number, high: number, low: number, close: number): number[] => [
  ...pStr(1, interval), ...pDbl(2, open), ...pDbl(3, high), ...pDbl(4, low), ...pDbl(5, close),
];

/** MarketOHLC { ohlc=1 repeated } */
const marketOHLC = (rows: number[][]): number[] => rows.flatMap((r) => pLen(1, r));

interface MarketFF {
  ltpc?: number[];
  level?: number[];
  ohlc?: number[];
  atp?: number;
  vtt?: number;
  oi?: number;
  tbq?: number;
  tsq?: number;
}

/** MarketFullFeed { ltpc=1, marketLevel=2, optionGreeks=3, marketOHLC=4, atp=5, vtt=6, oi=7, iv=8, tbq=9, tsq=10 } */
const marketFF = (o: MarketFF): number[] => [
  ...(o.ltpc ? pLen(1, o.ltpc) : []),
  ...(o.level ? pLen(2, o.level) : []),
  ...(o.ohlc ? pLen(4, o.ohlc) : []),
  ...(o.atp !== undefined ? pDbl(5, o.atp) : []),
  ...(o.vtt !== undefined ? pInt(6, o.vtt) : []),
  ...(o.oi !== undefined ? pDbl(7, o.oi) : []),
  ...(o.tbq !== undefined ? pDbl(9, o.tbq) : []),
  ...(o.tsq !== undefined ? pDbl(10, o.tsq) : []),
];

/** IndexFullFeed { ltpc=1, marketOHLC=2 } */
const indexFF = (l: number[], o?: number[]): number[] => [...pLen(1, l), ...(o ? pLen(2, o) : [])];

/** Feed { ltpc=1, fullFeed=2, firstLevelWithGreeks=3 } wrapping FullFeed { marketFF=1, indexFF=2 } */
const feedMarket = (ff: number[]): number[] => pLen(2, pLen(1, ff));
const feedIndex = (ff: number[]): number[] => pLen(2, pLen(2, ff));

/** FeedResponse { type=1, feeds=2 map<string,Feed>, currentTs=3 } */
const response = (type: number, entries: Array<[string, number[]]>, currentTs = 0): Uint8Array => {
  const body = [
    ...pInt(1, type),
    ...entries.flatMap(([key, feed]) => pLen(2, [...pStr(1, key), ...pLen(2, feed)])),
    ...(currentTs ? pInt(3, currentTs) : []),
  ];
  return new Uint8Array(body);
};

/* ------------------------------------------------------------------------- decoder --- */

describe('feed: protobuf decoding', () => {
  it('reads a full equity packet into the fields the scanner needs', () => {
    const packet = response(1, [[
      'NSE_EQ|INE002A01018',
      feedMarket(marketFF({
        ltpc: ltpc({ ltp: 1322, ltt: 1_755_000_000_000, ltq: 5, cp: 1300 }),
        level: marketLevel([quote(100, 1321.5, 200, 1322.5), quote(50, 1321, 75, 1323)]),
        ohlc: marketOHLC([ohlc('1d', 1305, 1330, 1298, 1322), ohlc('I1', 1321, 1322, 1320, 1322)]),
        atp: 1322.76,
        vtt: 10_180_567,
        oi: 0,
        tbq: 4000,
        tsq: 6000,
      })),
    ]], 1_755_000_001_000);

    const out = decodeFeed(packet);
    assert.equal(out.type, 1);
    assert.equal(out.currentTs, 1_755_000_001_000);
    assert.equal(out.patches.length, 1);

    const p = out.patches[0];
    assert.equal(p.instrumentKey, 'NSE_EQ|INE002A01018');
    assert.equal(p.isIndex, false);
    assert.equal(p.ltp, 1322);
    assert.equal(p.cp, 1300);
    assert.equal(p.atp, 1322.76);
    assert.equal(p.vtt, 10_180_567);
    assert.equal(p.tbq, 4000);
    assert.equal(p.tsq, 6000);
    // Only the "1d" candle is the day. "I1" is a one-minute bar and must not be mistaken
    // for it — doing so would report the last minute's range as the session's.
    assert.equal(p.dayOpen, 1305);
    assert.equal(p.dayHigh, 1330);
    assert.equal(p.dayLow, 1298);
    assert.equal(p.depth?.length, 2);
    assert.deepEqual(p.depth?.[0], { bidQ: 100, bidP: 1321.5, askQ: 200, askP: 1322.5 });
  });

  it('marks an index packet, which carries no atp, vtt or depth', () => {
    const packet = response(0, [[
      'NSE_INDEX|Nifty 50',
      feedIndex(indexFF(ltpc({ ltp: 24154.9, cp: 24200 }), marketOHLC([ohlc('1d', 24223, 24269, 24154, 24154.9)]))),
    ]]);

    const p = decodeFeed(packet).patches[0];
    assert.equal(p.isIndex, true);
    assert.equal(p.ltp, 24154.9);
    assert.equal(p.cp, 24200);
    assert.equal(p.dayOpen, 24223);
    // Not zero — ABSENT. The store must keep whatever it had rather than write a 0.
    assert.equal(p.atp, undefined);
    assert.equal(p.vtt, undefined);
    assert.equal(p.depth, undefined);
  });

  it('reports an omitted field as absent rather than as zero', () => {
    // A live update carrying only a new price, which is what the feed sends most of the time.
    const packet = response(1, [['NSE_EQ|X', feedMarket(marketFF({ ltpc: ltpc({ ltp: 101 }) }))]]);
    const p = decodeFeed(packet).patches[0];

    assert.equal(p.ltp, 101);
    assert.equal(p.atp, undefined);
    assert.equal(p.vtt, undefined);
    assert.equal(p.cp, undefined);
    assert.equal(p.dayHigh, undefined);
  });

  it('decodes several instruments in one packet', () => {
    const packet = response(1, [
      ['A', feedMarket(marketFF({ ltpc: ltpc({ ltp: 1 }) }))],
      ['B', feedMarket(marketFF({ ltpc: ltpc({ ltp: 2 }) }))],
      ['C', feedIndex(indexFF(ltpc({ ltp: 3 })))],
    ]);
    const out = decodeFeed(packet);
    assert.deepEqual(out.patches.map((p) => p.instrumentKey), ['A', 'B', 'C']);
    assert.deepEqual(out.patches.map((p) => p.ltp), [1, 2, 3]);
  });

  it('yields no patches for a market_info packet', () => {
    // type=2 with no feeds map. This must not refresh the freshness clock, which is why the
    // client checks `patches.length` rather than treating any packet as liveness.
    const out = decodeFeed(new Uint8Array([...pInt(1, 2)]));
    assert.equal(out.type, 2);
    assert.equal(out.patches.length, 0);
  });

  it('throws on a truncated buffer rather than returning half a reading', () => {
    const full = response(1, [['NSE_EQ|X', feedMarket(marketFF({ ltpc: ltpc({ ltp: 101, cp: 100 }) }))]]);
    assert.throws(() => decodeFeed(full.subarray(0, full.length - 4)));
  });

  it('builds a binary subscribe frame the feed will accept', () => {
    const frame = subscribeFrame('sub', ['NSE_EQ|A', 'NSE_EQ|B'], 'full');
    assert.ok(frame instanceof Uint8Array, 'must be binary — a text frame is silently ignored');
    const parsed = JSON.parse(new TextDecoder().decode(frame));
    assert.equal(parsed.method, 'sub');
    assert.equal(parsed.data.mode, 'full');
    assert.deepEqual(parsed.data.instrumentKeys, ['NSE_EQ|A', 'NSE_EQ|B']);
    assert.ok(parsed.guid, 'every frame needs its own guid');
  });
});

/* --------------------------------------------------------------------------- store --- */

describe('feed: the store', () => {
  beforeEach(() => {
    resetFeedStore();
    setPhaseForTest('open');
  });

  it('keeps the previous value for a field the next packet omits', () => {
    injectPatches([{ instrumentKey: 'K', isIndex: false, ltp: 100, cp: 99, atp: 99.5, vtt: 1000 }], 1000);
    // The update that broke the naive implementation: price moved, nothing else was sent.
    injectPatches([{ instrumentKey: 'K', isIndex: false, ltp: 101 }], 2000);

    const t = feedTick('K');
    assert.equal(t?.ltp, 101, 'the new value wins');
    assert.equal(t?.atp, 99.5, 'a zeroed VWAP would price the stock infinitely above its average');
    assert.equal(t?.vtt, 1000);
    assert.equal(t?.cp, 99);
    assert.equal(t?.at, 2000);
  });

  it('takes an explicit zero, which is different from an omission', () => {
    injectPatches([{ instrumentKey: 'K', isIndex: false, ltp: 100, tbq: 5000 }], 1000);
    injectPatches([{ instrumentKey: 'K', isIndex: false, tbq: 0 }], 2000);
    assert.equal(feedTick('K')?.tbq, 0, 'the book really did empty');
  });

  it('accumulates the open-interest range, which the feed does not carry', () => {
    injectPatches([{ instrumentKey: 'F', isIndex: false, ltp: 10, oi: 5000 }], 1000);
    injectPatches([{ instrumentKey: 'F', isIndex: false, oi: 7000 }], 2000);
    injectPatches([{ instrumentKey: 'F', isIndex: false, oi: 4000 }], 3000);

    const t = feedTick('F');
    assert.equal(t?.oi, 4000);
    assert.equal(t?.oiHigh, 7000);
    assert.equal(t?.oiLow, 4000);
  });

  it('does not let an equity zero seed the open-interest low', () => {
    // Equities report oi 0 forever. Seeding the low with it would report every future's range
    // as "0 to today's OI" the first time one ticked.
    injectPatches([{ instrumentKey: 'E', isIndex: false, ltp: 10, oi: 0 }], 1000);
    injectPatches([{ instrumentKey: 'E', isIndex: false, oi: 0 }], 2000);
    const t = feedTick('E');
    assert.equal(t?.oiHigh, 0);
    assert.equal(t?.oiLow, 0);
  });

  it('starts a fresh session at the IST day rollover', () => {
    // This process runs overnight, so without a day stamp Tuesday's accumulators survive into
    // Wednesday and the futures OI range reports a two-day spread as today's.
    const tue = Date.UTC(2026, 7, 18, 6, 0) ; // 11:30 IST Tuesday
    const wed = Date.UTC(2026, 7, 19, 6, 0);  // 11:30 IST Wednesday

    injectPatches([{ instrumentKey: 'F', isIndex: false, ltp: 10, oi: 9000, vtt: 500_000 }], tue);
    assert.equal(feedTick('F')?.oiHigh, 9000);

    injectPatches([{ instrumentKey: 'F', isIndex: false, ltp: 11, oi: 3000 }], wed);
    const t = feedTick('F');
    assert.equal(t?.day, '2026-08-19');
    assert.equal(t?.oiHigh, 3000, "yesterday's high must not survive the rollover");
    assert.equal(t?.oiLow, 3000);
    assert.equal(t?.vtt, 0, "yesterday's volume is not today's");
  });

  it('keeps accumulating within one IST day', () => {
    const morning = Date.UTC(2026, 7, 19, 4, 0); // 09:30 IST
    const noon = Date.UTC(2026, 7, 19, 7, 0);    // 12:30 IST
    injectPatches([{ instrumentKey: 'F', isIndex: false, ltp: 10, oi: 5000 }], morning);
    injectPatches([{ instrumentKey: 'F', isIndex: false, oi: 8000 }], noon);
    assert.equal(feedTick('F')?.oiHigh, 8000);
    assert.equal(feedTick('F')?.oiLow, 5000);
  });

  it('remembers an instrument is an index across the rollover', () => {
    const tue = Date.UTC(2026, 7, 18, 6, 0);
    const wed = Date.UTC(2026, 7, 19, 6, 0);
    injectPatches([{ instrumentKey: 'I', isIndex: true, ltp: 100 }], tue);
    // A bare LTPC packet carries no union tag, so the patch alone cannot say what this is.
    injectPatches([{ instrumentKey: 'I', isIndex: false, ltp: 101 }], wed);
    assert.equal(feedTick('I')?.isIndex, true);
  });

  it('never downgrades an index back to an equity', () => {
    injectPatches([{ instrumentKey: 'I', isIndex: true, ltp: 100 }], 1000);
    injectPatches([{ instrumentKey: 'I', isIndex: false, ltp: 101 }], 2000);
    assert.equal(feedTick('I')?.isIndex, true);
  });

  it('measures coverage against what was asked for', () => {
    injectPatches([
      { instrumentKey: 'A', isIndex: false, ltp: 1 },
      { instrumentKey: 'B', isIndex: false, ltp: 2 },
    ], 1000);
    assert.equal(feedCoverage(['A', 'B']), 1);
    assert.equal(feedCoverage(['A', 'B', 'C', 'D']), 0.5);
    assert.equal(feedCoverage([]), 0);
  });
});

/* ---------------------------------------------------------------------- the gate --- */

describe('feed: when a cycle may trust it', () => {
  const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const all = keys.map((k) => ({ instrumentKey: k, isIndex: false, ltp: 1 }));

  beforeEach(() => {
    resetFeedStore();
    setPhaseForTest('open');
  });

  it('serves a fresh, fully covered feed', () => {
    injectPatches(all, 10_000);
    assert.equal(feedUsable(keys, true, 12_000), true);
  });

  it('refuses when the socket is not open', () => {
    injectPatches(all, 10_000);
    setPhaseForTest('closed');
    assert.equal(feedUsable(keys, true, 12_000), false);
  });

  it('refuses a stale feed while the market is open', () => {
    injectPatches(all, 10_000);
    // A liquid universe silent for a minute is a broken socket, not a quiet market.
    assert.equal(feedUsable(keys, true, 10_000 + 60_000), false);
  });

  it('accepts a silent feed once the market has closed', () => {
    injectPatches(all, 10_000);
    // After the close the last print is the correct answer until tomorrow, so age is not a
    // fault. This is the case that would otherwise put the evening board back on REST.
    assert.equal(feedUsable(keys, false, 10_000 + 6 * 60 * 60_000), true);
  });

  it('refuses a partially covered feed', () => {
    injectPatches(all.slice(0, 8), 10_000);
    assert.equal(feedCoverage(keys), 0.8);
    // 80% is not a feed with gaps, it is a subscription that did not land — and the rows it
    // would serve get scored against a breadth picture drawn from a different universe.
    assert.equal(feedUsable(keys, true, 12_000), false);
  });

  it('refuses before any packet has arrived', () => {
    assert.equal(feedUsable(keys, true, 12_000), false);
  });
});

/* ------------------------------------------------------------ tick -> MomentumQuote --- */

describe('feed: mapping a tick onto the scanner reading', () => {
  const base = {
    instrumentKey: 'NSE_EQ|X', isIndex: false, ltp: 100, cp: 80, atp: 95, vtt: 200_000,
    oi: 0, oiHigh: 0, oiLow: 0, tbq: 5000, tsq: 4000, iv: 0,
    dayOpen: 82, dayHigh: 104, dayLow: 79, depth: [], day: '2026-08-19', at: 5000, feedTs: 4000,
  };

  it('derives change, VWAP and turnover the same way the REST path does', () => {
    const q = fromTick('X', 'NSE_EQ|X', base);
    assert.ok(q);
    assert.equal(q.prevClose, 80);
    assert.equal(q.netChange, 20);
    assert.equal(q.changePct, 25);
    assert.equal(q.vwap, 95);
    // 95 × 200000 = 19,000,000 -> ₹1.9 crore
    assert.equal(q.turnoverCr, 1.9);
    assert.equal(q.open, 82);
    assert.equal(q.high, 104);
    assert.equal(q.low, 79);
    assert.equal(q.at, 4000, "Upstox's own stamp is preferred over our receive time");
  });

  it('reports a two-sided book, and the order counts the feed cannot carry', () => {
    const q = fromTick('X', 'NSE_EQ|X', {
      ...base,
      depth: [{ bidP: 99.5, bidQ: 100, askP: 100.5, askQ: 200 }],
    });
    assert.ok(q);
    assert.equal(q.hasBook, true);
    assert.equal(q.bid, 99.5);
    assert.equal(q.ask, 100.5);
    assert.equal(q.depthCr, +(((99.5 * 100) + (100.5 * 200)) / 1e7).toFixed(4));
    // The one genuine loss in the migration. Zero here, and `liquidity.service.ts` reports
    // orderImbalance as null rather than as a real skew of 0.
    assert.equal(q.bidOrders, 0);
    assert.equal(q.askOrders, 0);
  });

  it('refuses to call a one-sided book a book', () => {
    // What the closing auction leaves behind. Treating it as a spread reads as infinitely
    // tight, which would score a stock nobody is quoting as perfectly liquid.
    const q = fromTick('X', 'NSE_EQ|X', {
      ...base,
      depth: [{ bidP: 0, bidQ: 0, askP: 100.5, askQ: 200 }],
    });
    assert.ok(q);
    assert.equal(q.hasBook, false);
    assert.equal(q.bid, 0);
    assert.equal(q.ask, 100.5);
  });

  it('falls back to the previous close before the first trade of the day', () => {
    const q = fromTick('X', 'NSE_EQ|X', { ...base, dayOpen: 0, dayHigh: 0, dayLow: 0 });
    assert.ok(q);
    assert.equal(q.open, 80, 'the stock is still where it closed');
    assert.equal(q.high, 100);
    assert.equal(q.low, 100);
  });

  it('drops an unpriced instrument rather than reporting it at zero', () => {
    assert.equal(fromTick('X', 'NSE_EQ|X', { ...base, ltp: 0 }), null);
  });

  it('carries the accumulated OI range onto the reading', () => {
    const q = fromTick('F', 'NSE_FO|1', { ...base, oi: 6000, oiHigh: 7000, oiLow: 5000 });
    assert.ok(q);
    assert.equal(q.openInterest, 6000);
    assert.equal(q.oiDayHigh, 7000);
    assert.equal(q.oiDayLow, 5000);
  });
});
