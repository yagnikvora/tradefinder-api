// The Discord channel.
//
// Sits beside Telegram rather than replacing it, and that is the point: a single channel that
// fails silently is a missed trade you never learn about, and two independent ones have to fail
// together. Both are handed the SAME content, rendered as Markdown here and as HTML there through
// the `Markup` pair in `markup.ts`, so the two can never disagree about a price.
//
// Sent as an EMBED rather than plain content, for one reason worth keeping: an embed carries a
// colour stripe, so long and short are distinguishable from across the room without reading a
// word. The colours are the app's own bull and bear.
//
// The webhook URL is a credential — anyone holding it can post into that channel as you — so like
// the Telegram token it lives in the environment and never in the config that `PUT /momentum/config`
// serves over HTTP.

/**
 * The webhook URL, under its new name or the old `PULLBACK_`-prefixed one.
 *
 * Same reasoning as `telegram.ts`: the credentials were named for the module that first sent
 * anything, that module is gone, and dropping the old spelling would silently unconfigure the
 * channel on any `.env` that still uses it.
 */
const url = () =>
  (process.env.DISCORD_WEBHOOK_URL ?? process.env.PULLBACK_DISCORD_WEBHOOK_URL ?? '').trim();

/** Whether the channel is set up at all. Reported on `/momentum/status`. */
export const discordConfigured = (): boolean => /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url());

let failures = 0;
let lastError: string | null = null;
let lastSentAt: number | null = null;
let reachable: boolean | null = null;
let reachableAt: number | null = null;

export const discordStatus = () => ({
  configured: discordConfigured(),
  failures,
  lastError,
  lastSentAt,
  /** Result of the last `checkDiscord()` probe. Null before one has run. */
  reachable,
  reachableAt,
});

/**
 * Can this host reach the webhook, and does it still exist?
 *
 * The same startup question `checkTelegram` answers, and worth asking separately because this
 * channel has its own way of dying quietly: a webhook that someone deleted in Discord answers 404
 * forever, and nothing about `configured: true` notices. A GET on the webhook URL validates it
 * without posting anything into the channel.
 */
export async function checkDiscord(): Promise<boolean> {
  if (!discordConfigured()) {
    reachable = null;
    return false;
  }
  try {
    const res = await fetch(url(), { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`${res.status} — the webhook URL is rejected; it may have been deleted in Discord`);
    reachable = true;
    lastError = null;
  } catch (e) {
    reachable = false;
    lastError = String((e as Error).message);
  }
  reachableAt = Date.now();
  return reachable;
}

const BULL = 0x2ec76a;
const BEAR = 0xe5484d;
const NEUTRAL = 0x4c8dff;


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
