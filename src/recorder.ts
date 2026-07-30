// Standalone OI recorder — keeps Option Clock's PCR trend complete on its own.
//
// The trend can only ever contain what was captured while the market was open: NSE
// serves the option chain as it stands right now and nothing anywhere serves it as it
// stood an hour ago, so a ten-minute row nobody was around to record is gone for good.
// The API records as it serves pages, but that only helps while the API is up, which
// ties the day's data to whether someone happened to be running the app.
//
// This process exists to break that tie. It has no HTTP surface and no dependency on
// the web app — it wakes every five minutes, and during market hours writes the chain
// for every index into the same tape the API reads from (api/src/oistore.ts). Run it as
// a service or a logon task (see tools/install-recorder.ps1) and the trend fills in
// whether or not anything else is running.
//
// It cannot record while the machine it runs on is off. Nothing can — that is what
// hosting it somewhere always-on solves, not more code here.

import { recordAll, sessionCloseEpoch } from './oiclock.js';
import { flushNow } from './oistore.js';
import { marketOpen } from './services.js';

const TICK_MS = Number(process.env.RECORD_TICK_MS) || 5 * 60e3;

// A few minutes past 15:30 so the closing reading is definitely taped. Without it a
// tick landing at 15:31 would skip, and the day's final row would rest on whatever was
// captured a few minutes before the bell.
const CLOSE_GRACE_S = 10 * 60;

const stamp = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(11, 19); // IST
const log = (msg: string) => console.log(`${stamp()} IST  ${msg}`);

function shouldRecord(nowMs = Date.now()): boolean {
  if (marketOpen(nowMs)) return true;
  const now = Math.floor(nowMs / 1000);
  const close = sessionCloseEpoch(nowMs);
  // marketOpen at the close instant also settles whether today was a trading weekday.
  return now > close && now <= close + CLOSE_GRACE_S && marketOpen(close * 1000);
}

let running = false;

async function tick(): Promise<void> {
  if (running) return; // a slow tick must not overlap the next one
  if (!shouldRecord()) return;
  running = true;
  try {
    const { ok, failed } = await recordAll();
    await flushNow();
    log(`recorded ${ok.length}/${ok.length + failed.length}` + (failed.length ? ` — failed: ${failed.join(', ')}` : ''));
  } catch (e) {
    log(`tick failed: ${String((e as Error).message)}`);
  } finally {
    running = false;
  }
}

log(`OI recorder started — every ${TICK_MS / 60000} min during market hours (09:15–15:30 IST, Mon–Fri)`);
void tick();
setInterval(() => void tick(), TICK_MS);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void flushNow().finally(() => { log('stopped'); process.exit(0); });
  });
}
