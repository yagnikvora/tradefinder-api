// The Telegram channel.
//
// Delivery only — what the message SAYS lives in `message.ts`, shared with every other channel so
// the two phones in your pocket cannot disagree about the same trade.
//
// CREDENTIALS COME FROM THE ENVIRONMENT, NOT FROM THE CONFIG. `GET /pullback/config` serves the
// whole config object, so a bot token stored there would be readable by anything that can reach
// the API — and a leaked bot token lets a stranger post trade instructions into your chat, which
// is a considerably worse outcome than a leaked threshold.
//
// SENDING IS FIRE-AND-FORGET, for the same reason the webhook is: an alert channel that can fail
// must never be able to fail or slow the scan. Failures are counted and surfaced on
// `/pullback/status` so a silent channel is diagnosable rather than merely quiet.

import type { AlertEvent, PullbackSignal } from '../types.js';
import { buildEventMessage, buildSignalMessage, HTML } from './message.js';

const API = 'https://api.telegram.org';

const token = () => (process.env.PULLBACK_TELEGRAM_BOT_TOKEN ?? '').trim();
const chatId = () => (process.env.PULLBACK_TELEGRAM_CHAT_ID ?? '').trim();

/** Whether the channel is set up at all. Reported on `/pullback/status`. */
export const telegramConfigured = (): boolean => !!token() && !!chatId();

let failures = 0;
let lastError: string | null = null;
let lastSentAt: number | null = null;

export const telegramStatus = () => ({
  configured: telegramConfigured(),
  failures,
  lastError,
  lastSentAt,
});

export const signalMessage = (signal: PullbackSignal): string => buildSignalMessage(signal, HTML);
export const eventMessage = (e: AlertEvent): string => buildEventMessage(e, HTML);

/**
 * Send, never throwing.
 *
 * `disable_notification` is NOT set: the entire point of this channel is that the phone makes a
 * noise. If that becomes too much the fix is the threshold in `alerts.push`, not a silent send.
 */
export async function sendTelegram(text: string): Promise<boolean> {
  const [t, c] = [token(), chatId()];
  if (!t || !c) return false;
  try {
    const res = await fetch(`${API}/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: c,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      // Telegram puts the actual reason in the body — "chat not found", "bot was blocked" — and
      // the status alone (400) would leave every one of those looking identical.
      const body = (await res.json().catch(() => null)) as { description?: string } | null;
      throw new Error(`${res.status} ${body?.description ?? ''}`.trim());
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
export const resetTelegramStatus = (): void => {
  failures = 0;
  lastError = null;
  lastSentAt = null;
};
