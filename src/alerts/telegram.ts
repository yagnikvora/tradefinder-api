// The Telegram channel.
//
// DELIVERY ONLY. What a message SAYS belongs to whatever produced it — the trend-day alert and the
// session bells each render their own text against a `Markup` from `markup.ts`, which is what lets
// the two phones in your pocket carry identical content in two different dialects.
//
// CREDENTIALS COME FROM THE ENVIRONMENT, NOT FROM THE CONFIG. `PUT /momentum/config` serves the
// whole config object, so a bot token stored there would be readable by anything that can reach
// the API — and a leaked bot token lets a stranger post trade instructions into your chat, which
// is a considerably worse outcome than a leaked threshold.
//
// SENDING IS FIRE-AND-FORGET, for the same reason the webhook is: an alert channel that can fail
// must never be able to fail or slow the scan. Failures are counted and surfaced on
// `/momentum/status` so a silent channel is diagnosable rather than merely quiet.

const DEFAULT_API = 'https://api.telegram.org';

/**
 * Read `NAME`, falling back to `PULLBACK_NAME`.
 *
 * The credentials were named for the pullback module because it was the first thing here that sent
 * anything, and that module is gone. Renaming them outright would silently unconfigure the channel
 * on every deployment whose `.env` still uses the old spelling — a channel that goes quiet with no
 * error is the exact failure this file spends fifty lines trying to make impossible. So the new
 * name wins and the old one still works.
 */
const env = (name: string): string =>
  process.env[name] ?? process.env[`PULLBACK_${name}`] ?? '';

/**
 * Where the Bot API lives — overridable, because on some networks the real one is unreachable.
 *
 * THIS IS NOT A CONVENIENCE SETTING. Many Indian ISPs filter Telegram by TLS SNI: DNS resolves
 * correctly, the TCP connection to 149.154.166.110:443 completes, and the connection is then RESET
 * the moment the ClientHello names `api.telegram.org`. The same IP with any other SNI finishes the
 * handshake normally, and `web.telegram.org` is reachable from the same host while
 * `api.telegram.org` is not — it is a per-hostname blocklist, not a route problem. Port 80 reaches
 * Telegram's nginx and only 301s to HTTPS; ports 88 and 8443 are blocked with 443. So there is no
 * transport trick available, and no change to the token or the chat ID can help: the only fix is to
 * stop putting that hostname in the SNI, which means sending through something else.
 *
 * Point this at any host that forwards the path through to the real API — a Cloudflare Worker
 * (free, and the SNI becomes `*.workers.dev`), a reverse proxy you control, or a self-hosted
 * `telegram-bot-api` server. The path and the token are appended unchanged, so a mirror only has to
 * pass the request along.
 *
 * A trailing slash is tolerated because it is the obvious thing to paste and would otherwise
 * produce `//bot123:ABC/sendMessage`, which Telegram answers with a 404 that reads like a bad token.
 */
const apiBase = (): string =>
  (env('TELEGRAM_API_BASE') || DEFAULT_API).trim().replace(/\/+$/, '');

/** True when sends are going somewhere other than Telegram's own host. Reported on `/status`. */
const usingMirror = (): boolean => apiBase() !== DEFAULT_API;

const token = () => env('TELEGRAM_BOT_TOKEN').trim();
const chatId = () => env('TELEGRAM_CHAT_ID').trim();

/** Whether the channel is set up at all. Reported on `/momentum/status`. */
export const telegramConfigured = (): boolean => !!token() && !!chatId();

let failures = 0;
let lastError: string | null = null;
let lastSentAt: number | null = null;
let reachable: boolean | null = null;
let reachableAt: number | null = null;

export const telegramStatus = () => ({
  configured: telegramConfigured(),
  failures,
  lastError,
  lastSentAt,
  /** Result of the last `checkTelegram()` probe. Null before one has run. */
  reachable,
  reachableAt,
  /**
   * The host sends are going to, and whether it is Telegram's own.
   *
   * Worth reporting because a mirror is invisible otherwise: a typo in `TELEGRAM_API_BASE`
   * fails in exactly the same way as the block it was set up to route around, and there would be
   * nothing on `/status` to tell the two apart. No token is included — this is the base only.
   */
  apiBase: apiBase(),
  usingMirror: usingMirror(),
});

/**
 * Can this host actually TALK to Telegram? Answered at startup rather than discovered at 10:45.
 *
 * `configured: true, failures: 0, lastSentAt: null` is what a perfectly healthy channel looks like
 * on a quiet morning AND what a completely unreachable one looks like all day, and there is no way
 * to tell them apart from the outside. That ambiguity is expensive here: the first send is attempted
 * at the exact moment a Strong signal fires, which is the worst possible time to discover that
 * `api.telegram.org` cannot be reached from this network.
 *
 * It is worth being specific about the failure this was written for, because it looks nothing like
 * a credentials problem and gets debugged as one. On a network that filters Telegram — which many
 * Indian ISPs do — the TCP connection to 149.154.166.110:443 SUCCEEDS and the TLS handshake is then
 * reset the moment the ClientHello names `api.telegram.org`. Node surfaces that as the entirely
 * unhelpful `fetch failed`. Same IP with any other SNI completes the handshake normally, so nothing
 * about the token, the chat ID or the code is wrong, and no amount of re-checking them helps.
 *
 * `getMe` is used because it is free, unauthenticated against rate limits, sends nothing to the
 * chat, and distinguishes the two failures that matter: a transport error means the host cannot get
 * there, and a 401 means the token is wrong.
 */
export async function checkTelegram(): Promise<boolean> {
  if (!telegramConfigured()) {
    reachable = null;
    return false;
  }
  try {
    const res = await fetch(`${apiBase()}/bot${token()}/getMe`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { description?: string } | null;
      throw new Error(`${res.status} ${body?.description ?? ''}`.trim());
    }
    reachable = true;
    lastError = null;
  } catch (e) {
    reachable = false;
    // `fetch failed` is what Node reports for DNS failure, connection refusal AND a TLS reset, so
    // the raw message would send a reader to check a token that is fine.
    lastError = describeError(String((e as Error).message));
  }
  reachableAt = Date.now();
  return reachable;
}

/**
 * Turn a transport failure into something that names the actual problem.
 *
 * Shared by the probe and the send because they fail the same way and were explaining it
 * differently — `checkTelegram` said "this is a network block, here is the fix" and `sendTelegram`
 * said `fetch failed`, which is the message that sends you to re-check a token that is fine. The
 * one people actually read is the send's, because that is what `POST /momentum/alerts/test` puts on
 * screen.
 *
 * Anything that is not a transport error is passed through untouched: a 401 or a "chat not found"
 * already says what is wrong, and wrapping it would bury it.
 */
function describeError(msg: string): string {
  if (msg !== 'fetch failed') return msg;
  return usingMirror()
    ? `cannot reach the configured Telegram mirror at ${apiBase()} — check TELEGRAM_API_BASE ` +
      'is reachable from this host and forwards the path through to api.telegram.org unchanged.'
    : 'cannot reach api.telegram.org from this host — the TLS connection is refused or reset. ' +
      'This is a network block (many Indian ISPs filter Telegram by SNI), not a bad token: the ' +
      'TCP connection succeeds and the handshake is killed. Set TELEGRAM_API_BASE to a ' +
      'mirror you control (see tools/telegram-mirror.worker.js), or use a VPN. Discord is unaffected.';
}

/**
 * Send, never throwing.
 *
 * `disable_notification` is NOT set: the entire point of this channel is that the phone makes a
 * noise. If that becomes too much the fix is the threshold in `the conviction floor`, not a silent send.
 */
export async function sendTelegram(text: string): Promise<boolean> {
  const [t, c] = [token(), chatId()];
  if (!t || !c) return false;
  try {
    const res = await fetch(`${apiBase()}/bot${t}/sendMessage`, {
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
    lastError = describeError(String((e as Error).message));
    // A transport failure here is the same evidence the probe collects, so the health flag is
    // updated rather than left showing whatever the last hourly check happened to see.
    reachable = false;
    reachableAt = Date.now();
    return false;
  }
}
