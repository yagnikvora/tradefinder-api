// Live feed health and a shadow diff against REST.  Run: npm run check-feed
//
// The migration's real risk is not the socket falling over — that is loud, and the scan falls
// back to REST on its own. It is the socket staying up and quietly disagreeing with the
// exchange, because every downstream number keeps computing and the board keeps rendering.
// This is the check that would catch that, and it is worth running once during market hours
// after any change to `feed/`.
//
// It does three things, in order of how much they matter:
//
//   1. Connects the real feed and subscribes the real momentum universe — the same ~434 keys
//      the scanner asks for — then reports whether coverage and freshness clear the gate that
//      `quoteSnapshot` actually uses. A feed that cannot clear it is silently costing you the
//      latency the migration was for.
//
//   2. Diffs the streamed reading against a REST quote for a sample, field by field. Outside
//      market hours both sides are frozen on the closing print and every drift should be
//      zero. DURING market hours the two readings are taken moments apart, so `ltp` and `vtt`
//      legitimately differ — a fast-moving stock will not agree to the paisa. What should
//      still agree closely is `atp`, because a session VWAP moves slowly by construction.
//
//   3. Runs one real `quoteSnapshot()` and reports which source served it, which is the only
//      end-to-end proof that the wiring is live rather than merely connectable.

import '../src/env.js';
import { call, tokenSet } from '../src/upstox.js';
import {
  feedCoverage, feedStatus, feedTick, feedUsable, startFeed, stopFeed, subscribeKeys,
} from '../src/feed/client.js';
import { quoteSnapshot } from '../src/momentum/data/quotes.js';
import { universe } from '../src/momentum/data/universe.js';
import { marketOpen } from '../src/momentum/session.js';

const pad = (s: string, n: number) => s.padEnd(n);
const money = (n: number) => (n ? n.toFixed(2) : '—');
const pct = (n: number) => `${(n * 100).toFixed(4)}%`;
const drift = (a: number, b: number) => (b > 0 ? Math.abs(a - b) / b : a === b ? 0 : 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!tokenSet()) {
  console.error('\n  UPSTOX_ACCESS_TOKEN is not set — put your Analytics Token in api/.env\n');
  process.exit(1);
}
if ((process.env.MOMENTUM_FEED ?? 'on').trim().toLowerCase() === 'off') {
  console.error('\n  MOMENTUM_FEED=off — the feed is disabled, so there is nothing to check.\n');
  process.exit(1);
}

const open = marketOpen();
console.log(`\n  FEED CHECK — market is ${open ? 'OPEN' : 'CLOSED'}\n  ${'='.repeat(68)}\n`);

/* --------------------------------------------------------------- connect and cover --- */

const uni = await universe();
const keys: string[] = [];
for (const m of uni.members) {
  keys.push(m.equityKey);
  if (m.future) keys.push(m.future.instrumentKey);
}
for (const [, key] of uni.sectorIndexKeys) keys.push(key);
keys.push(uni.niftyKey);
if (uni.niftyFuture) keys.push(uni.niftyFuture.instrumentKey);
if (uni.vixKey) keys.push(uni.vixKey);

console.log(`  universe: ${uni.members.length} stocks -> ${keys.length} instrument keys\n`);

startFeed();
subscribeKeys(keys);

// Coverage climbs as the connect snapshot lands. Waiting on the number rather than on a fixed
// sleep means a fast connection is not punished and a slow one is not cut off early.
const WAIT_MS = 30_000;
const startedAt = Date.now();
let coverage = 0;
process.stdout.write('  waiting for the connect snapshot ');
while (Date.now() - startedAt < WAIT_MS) {
  await sleep(1000);
  coverage = feedCoverage(keys);
  process.stdout.write('.');
  if (coverage >= 0.99) break;
}
console.log('');

const status = feedStatus();
console.log(`\n  phase           ${status.phase}`);
console.log(`  subscribed      ${status.subscribed}`);
console.log(`  instruments     ${status.instruments}`);
console.log(`  coverage        ${pct(coverage)}`);
console.log(`  packets         ${status.packets} (${status.decodeErrors} decode errors)`);
console.log(`  last packet     ${status.ageMs === null ? 'never' : `${(status.ageMs / 1000).toFixed(1)}s ago`}`);
if (status.lastError) console.log(`  last error      ${status.lastError.message}`);

const usable = feedUsable(keys, open);
console.log(`\n  feedUsable()    ${usable ? 'YES — cycles will be served from the feed' : 'NO — cycles will fall back to REST'}`);

if (!status.instruments) {
  console.error('\n  Nothing arrived. Run `npm run spike-ws` for the full connection diagnosis.\n');
  stopFeed();
  process.exit(1);
}

/* ------------------------------------------------------------------- the shadow diff --- */

// A spread of the universe rather than the first N, which would be alphabetical and therefore
// correlated — the same handful of names every run.
const SAMPLE = 40;
const step = Math.max(1, Math.floor(keys.length / SAMPLE));
const sample = keys.filter((_, i) => i % step === 0).slice(0, SAMPLE);

interface RestQuote {
  instrument_token?: string;
  last_price?: number;
  average_price?: number | null;
  volume?: number | null;
  oi?: number | null;
}

const rest = new Map<string, RestQuote>();
const data = await call<Record<string, RestQuote>>(
  `/v2/market-quote/quotes?instrument_key=${encodeURIComponent(sample.join(','))}`,
);
for (const q of Object.values(data ?? {})) if (q.instrument_token) rest.set(String(q.instrument_token), q);

console.log(`\n  SHADOW DIFF — ${sample.length} instruments, feed vs REST\n`);
console.log(`  ${pad('instrument', 26)}${pad('ltp drift', 14)}${pad('atp drift', 14)}${pad('vtt drift', 14)}oi drift`);
console.log('  ' + '-'.repeat(84));

const worst = { ltp: 0, atp: 0, vtt: 0, oi: 0 };
let compared = 0;
let missing = 0;

for (const key of sample) {
  const t = feedTick(key);
  const r = rest.get(key);
  if (!t || !r) { missing++; continue; }

  const rLtp = r.last_price ?? 0;
  const rAtp = r.average_price ?? 0;
  const rVol = r.volume ?? 0;
  const rOi = r.oi ?? 0;

  const d = {
    ltp: drift(t.ltp, rLtp),
    // An index carries no atp or vtt on either side — REST answers null too — so a diff of
    // "absent vs absent" is not a finding and must not be reported as perfect agreement.
    atp: rAtp > 0 ? drift(t.atp, rAtp) : -1,
    vtt: rVol > 0 ? drift(t.vtt, rVol) : -1,
    oi: rOi > 0 ? drift(t.oi, rOi) : -1,
  };

  compared++;
  worst.ltp = Math.max(worst.ltp, d.ltp);
  if (d.atp >= 0) worst.atp = Math.max(worst.atp, d.atp);
  if (d.vtt >= 0) worst.vtt = Math.max(worst.vtt, d.vtt);
  if (d.oi >= 0) worst.oi = Math.max(worst.oi, d.oi);

  const cell = (v: number) => (v < 0 ? 'n/a' : pct(v));
  // Only the outliers and a few samples, or 40 rows of 0.0000% drowns the summary.
  if (d.ltp > 0.001 || d.atp > 0.001 || compared <= 5) {
    console.log(
      `  ${pad(key.slice(0, 25), 26)}${pad(cell(d.ltp), 14)}${pad(cell(d.atp), 14)}` +
      `${pad(cell(d.vtt), 14)}${cell(d.oi)}`,
    );
  }
}

console.log(`\n  compared ${compared}, ${missing} not on both sides`);
console.log(`  worst drift   ltp ${pct(worst.ltp)}   atp ${pct(worst.atp)}   vtt ${pct(worst.vtt)}   oi ${pct(worst.oi)}`);

/* ------------------------------------------------------------------- end to end --- */

console.log('\n  END TO END — one real quoteSnapshot()\n');
const snap = await quoteSnapshot();
console.log(`  source          ${snap.source}`);
console.log(`  equity          ${snap.equity.size}`);
console.log(`  futures         ${snap.futures.size}`);
console.log(`  sectors         ${snap.sectors.size}`);
console.log(`  nifty           ${snap.nifty ? money(snap.nifty.ltp) : 'missing'}`);
console.log(`  nifty future    ${snap.niftyFuture ? money(snap.niftyFuture.ltp) : 'missing'}`);
console.log(`  india vix       ${snap.vix ? money(snap.vix.ltp) : 'missing'}`);

const sampleQuote = snap.equity.values().next().value;
if (sampleQuote) {
  console.log(
    `\n  sample row      ${sampleQuote.symbol}  ltp ${money(sampleQuote.ltp)}  ` +
    `vwap ${money(sampleQuote.vwap)}  turnover ₹${sampleQuote.turnoverCr}cr  ` +
    `book ${sampleQuote.hasBook ? 'yes' : 'no'}`,
  );
}

/* ---------------------------------------------------------------------- verdict --- */

console.log('\n  ' + '='.repeat(68));

const notes: string[] = [];
if (!usable) notes.push('the gate is refusing the feed — every cycle is paying for REST and the latency win is not being collected.');
if (snap.source !== 'feed' && usable) notes.push('the gate passes but the snapshot still came from REST — the wiring is not live.');
if (status.decodeErrors) notes.push(`${status.decodeErrors} packets failed to decode — check the vendored proto against Upstox's current one.`);
if (!open && worst.atp > 0.0001) notes.push(`atp disagrees by ${pct(worst.atp)} with the market closed, when both sides should be frozen on the same closing print.`);
if (open) notes.push('the market is open, so ltp and vtt drift is expected — the two readings are taken moments apart. atp should still agree closely.');

if (notes.length) {
  console.log('  NOTES\n');
  for (const n of notes) console.log(`  - ${n}`);
} else {
  console.log('  All good — the feed is serving the scanner and agrees with REST.');
}

console.log('');
stopFeed();
process.exit(snap.source === 'feed' || !usable ? 0 : 1);
