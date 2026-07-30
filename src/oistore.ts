// Intraday open-interest tape — the recording behind Option Clock's replay.
//
// The clock compares OI at two points in the session, which means it needs OI as it
// stood at each of them. NSE only ever answers "right now", and nothing public serves
// intraday OI history, so the session is recorded here as it happens: one snapshot per
// five-minute slot, held for the current trading day only.
//
// Two things keep the replay useful rather than empty:
//   * the 09:15 baseline is not waited for — it is reconstructed on the first call of
//     the day from NSE's own `changeinOpenInterest` (OI now minus today's change IS the
//     OI at the open), so a full-session window works the moment the page is opened;
//   * the tape is persisted, so restarting the API mid-session doesn't erase the morning.
//
// Slots are five minutes because that is the resolution the clock's slider works at,
// and it bounds the file at ~75 snapshots per script/expiry per day.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAPE_FILE = path.join(__dirname, '..', '.cache', 'oi-tape.json');

export const SLOT_S = 300; // 5 minutes
export const slotOf = (epochS: number) => Math.floor(epochS / SLOT_S) * SLOT_S;

// A snapshot is the feed's own shape: option key -> OI, plus the ATM strike.
export type OiSnapshot = Record<string, number>;
type Tape = Record<string, Record<string, OiSnapshot>>; // feedKey -> ts -> snapshot

let mem: Tape | null = null;
let loading: Promise<void> | null = null;

export const feedKey = (script: string, exp: string) => `${script}|${exp}`;

// IST calendar day of an epoch — the tape only ever holds the current trading day.
const istDay = (epochS: number) => new Date((epochS + 330 * 60) * 1000).toISOString().slice(0, 10);

// The tape has more than one writer: the standalone recorder keeps it complete through
// the session, and the API adds to it whenever a page is served. Neither may clobber
// the other, so nothing here ever writes memory over the file wholesale — reads refresh
// when the file moves on, and writes merge into whatever is on disk at that moment.
// Slots are keyed by timestamp and both writers read the same chain, so a merge has no
// conflict to resolve: the same slot from either side carries the same reading.
let diskMtime = -1;

const readTape = async (): Promise<Tape> => {
  try { return JSON.parse(await fs.readFile(TAPE_FILE, 'utf8')) as Tape; } catch { return {}; }
};

const mtimeOf = async (): Promise<number> => {
  try { return (await fs.stat(TAPE_FILE)).mtimeMs; } catch { return -1; }
};

/** Fold `over` into `base`, slot by slot. Mutates and returns `base`. */
function merge(base: Tape, over: Tape): Tape {
  for (const [key, slots] of Object.entries(over)) base[key] = { ...(base[key] ?? {}), ...slots };
  return base;
}

async function load(): Promise<void> {
  const mtime = await mtimeOf();
  if (mem && mtime === diskMtime) return; // nothing new on disk
  if (!loading)
    loading = (async () => {
      // Anything held in memory but not yet flushed stays — it wins over the file.
      mem = merge(await readTape(), mem ?? {});
      diskMtime = mtime;
    })().finally(() => { loading = null; });
  await loading;
}

let persistTimer: NodeJS.Timeout | null = null;
// Batched, fire-and-forget: a snapshot is written on most page loads and a failed write
// must never break a request that already has its data.
function persist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flush();
  }, 2000);
  persistTimer.unref?.();
}

async function flush(): Promise<void> {
  try {
    const merged = merge(await readTape(), mem ?? {});
    pruneToToday(merged, istDay(Math.floor(Date.now() / 1000)));
    await fs.mkdir(path.dirname(TAPE_FILE), { recursive: true });
    await fs.writeFile(TAPE_FILE, JSON.stringify(merged), 'utf8');
    mem = merged;
    diskMtime = await mtimeOf();
  } catch { /* best effort — the next write tries again */ }
}

// Drop anything that isn't from today's session, so the file can't grow without bound.
function pruneToToday(tape: Tape, today: string): void {
  for (const key of Object.keys(tape)) {
    const day = tape[key];
    for (const ts of Object.keys(day)) if (istDay(Number(ts)) !== today) delete day[ts];
    if (!Object.keys(day).length) delete tape[key];
  }
}

/** Record a snapshot into its five-minute slot. The latest write in a slot wins. */
export async function record(key: string, ts: number, snap: OiSnapshot): Promise<void> {
  await load();
  const slot = slotOf(ts);
  pruneToToday(mem!, istDay(slot));
  (mem![key] ??= {})[String(slot)] = snap;
  persist();
}

/** Write anything pending immediately — for a recorder tick that may be the last one. */
export async function flushNow(): Promise<void> {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  await flush();
}

/** Record only if the slot is empty — used for the reconstructed 09:15 baseline. */
export async function recordIfAbsent(key: string, ts: number, snap: OiSnapshot): Promise<void> {
  await load();
  if (mem![key]?.[String(slotOf(ts))]) return;
  await record(key, ts, snap);
}

/**
 * The newest snapshot recorded for a feed. `exp` may be omitted — when NSE is down
 * there is no expiry list to resolve against, and any expiry recorded for the script
 * is a better answer than none.
 */
export async function latest(script: string, exp?: string): Promise<[number, OiSnapshot] | null> {
  await load();
  const keys = exp ? [feedKey(script, exp)] : Object.keys(mem!).filter((k) => k.startsWith(`${script}|`));
  let best: [number, OiSnapshot] | null = null;
  for (const key of keys)
    for (const [ts, snap] of Object.entries(mem![key] ?? {}))
      if (!best || Number(ts) > best[0]) best = [Number(ts), snap];
  return best;
}

/** Every recorded slot for a feed, oldest first. */
export async function timeline(key: string): Promise<Array<[number, OiSnapshot]>> {
  await load();
  return Object.entries(mem![key] ?? {})
    .map(([ts, snap]) => [Number(ts), snap] as [number, OiSnapshot])
    .sort((a, b) => a[0] - b[0]);
}

/**
 * The recorded snapshot that best represents time `ts`: the last one at or before it,
 * falling back to the earliest recorded when `ts` predates the tape (asking for 09:15
 * on a day whose recording started at 11:00 should answer with 11:00, not nothing).
 */
export function nearest(tape: Array<[number, OiSnapshot]>, ts: number): [number, OiSnapshot] | null {
  if (!tape.length) return null;
  let best = tape[0];
  for (const entry of tape) if (entry[0] <= ts) best = entry; else break;
  return best;
}
