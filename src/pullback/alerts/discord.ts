// The Discord channel.
//
// Sits beside Telegram rather than replacing it, and that is the point: a single channel that
// fails silently is a missed trade you never learn about, and two independent ones have to fail
// together. They carry the SAME message from `message.ts`, rendered as Markdown here and as HTML
// there, so the two can never disagree about a price.
//
// Sent as an EMBED rather than plain content, for one reason worth keeping: an embed carries a
// colour stripe, so long and short are distinguishable from across the room without reading a
// word. The colours are the app's own bull and bear.
//
// The webhook URL is a credential — anyone holding it can post into that channel as you — so like
// the Telegram token it lives in the environment and never in the config that `GET /pullback/config`
// serves over HTTP.

import type { AlertEvent, PullbackSignal } from '../types.js';
import { buildEventMessage, buildSignalMessage, MARKDOWN } from './message.js';

const url = () => (process.env.PULLBACK_DISCORD_WEBHOOK_URL ?? '').trim();

/** Whether the channel is set up at all. Reported on `/pullback/status`. */
export const discordConfigured = (): boolean => /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url());

let failures = 0;
let lastError: string | null = null;
let lastSentAt: number | null = null;

export const discordStatus = () => ({
  configured: discordConfigured(),
  failures,
  lastError,
  lastSentAt,
});

const BULL = 0x2ec76a;
const BEAR = 0xe5484d;
const NEUTRAL = 0x4c8dff;

export const signalMessage = (signal: PullbackSignal): string => buildSignalMessage(signal, MARKDOWN);
export const eventMessage = (e: AlertEvent): string => buildEventMessage(e, MARKDOWN);

/** An embed description tops out at 4096 characters; ours run ~600, so this only ever guards. */
const CAP = 4000;

/**
 * Send, never throwing.
 *
 * `direction` only picks the colour stripe. It is optional because the test send and any future
 * non-directional notice have no side to be on.
 */
export async function sendDiscord(text: string, direction?: 1 | -1): Promise<boolean> {
  const hook = url();
  if (!discordConfigured()) return false;
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          description: text.length > CAP ? `${text.slice(0, CAP)}…` : text,
          color: direction === 1 ? BULL : direction === -1 ? BEAR : NEUTRAL,
        }],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      // Discord answers 400 with a JSON body naming the offending field, and 429 with the retry
      // window. The status alone would make "malformed embed" and "you are rate limited" identical.
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${body.slice(0, 200)}`.trim());
    }
    lastSentAt = Date.now();
    lastError = null;
    return true;
  } catch (e) {
    failures++;
    lastError = String((e as Error).message);
    return false;
  }
}

/** Test seam. */
export const resetDiscordStatus = (): void => {
  failures = 0;
  lastError = null;
  lastSentAt = null;
};
