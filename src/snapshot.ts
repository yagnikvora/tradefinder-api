// Last-known-good payload store.
//
// NSE is intermittently unreachable (it tarpits clients it dislikes). The mock
// fallback exists so the app always renders, but on a trading screen invented
// prices are worse than stale ones — a HDFCBANK at ₹1094 when it actually trades
// near ₹740 reads as a broken app. So once a feed has returned real data we keep
// it and re-serve it through the outage, and only fall back to mock on a cold
// start that has never seen a live response.
//
// Persisted to disk so a restart doesn't drop back to fabricated numbers.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAP_FILE = path.join(__dirname, '..', '.cache', 'last-good.json');

interface Snap { at: number; data: unknown }

const mem = new Map<string, Snap>();
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(SNAP_FILE, 'utf8');
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, Snap>)) mem.set(k, v);
  } catch { /* no snapshot yet */ }
}

// Fire-and-forget: a failed write must never break a request that already succeeded.
function persist(): void {
  const out = Object.fromEntries(mem);
  fs.mkdir(path.dirname(SNAP_FILE), { recursive: true })
    .then(() => fs.writeFile(SNAP_FILE, JSON.stringify(out), 'utf8'))
    .catch(() => { /* best effort */ });
}

export async function remember<T>(key: string, data: T): Promise<T> {
  await load();
  mem.set(key, { at: Date.now(), data });
  persist();
  return data;
}

export async function recall<T>(key: string): Promise<{ data: T; ageMs: number } | null> {
  await load();
  const hit = mem.get(key);
  return hit ? { data: hit.data as T, ageMs: Date.now() - hit.at } : null;
}

// "3m" / "2h" — for the note explaining how stale a served snapshot is.
export const ageLabel = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};
