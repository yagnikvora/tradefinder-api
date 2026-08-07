// A Cloudflare Worker that forwards Bot API calls to Telegram.
//
// WHY THIS EXISTS. Many Indian ISPs filter Telegram by TLS SNI. On the affected network the DNS is
// correct, the TCP connection to api.telegram.org:443 completes, and the connection is then RESET
// the moment the TLS ClientHello names that hostname — the same IP with any other SNI finishes the
// handshake normally. `web.telegram.org` resolves and answers 200 from the same host while
// `api.telegram.org` does not, so it is a per-hostname blocklist rather than a route problem. Port
// 80 reaches Telegram's nginx and only redirects to HTTPS; ports 88 and 8443 are blocked alongside
// 443. There is no transport trick left, and nothing about the bot token is wrong.
//
// A Worker fixes it because the request from your server now names `*.workers.dev` in the SNI,
// which nothing is filtering. Cloudflare's egress to Telegram is not on your ISP's path.
//
// DEPLOY (five minutes, free tier is far more than enough — alerts are a handful a day):
//
//   1. npm install -g wrangler && wrangler login
//   2. wrangler deploy tools/telegram-mirror.worker.js --name tg-mirror --compatibility-date 2024-01-01
//      (or paste this file into dash.cloudflare.com → Workers & Pages → Create → Edit code)
//   3. Put the URL it prints into api/.env:
//        PULLBACK_TELEGRAM_API_BASE=https://tg-mirror.<your-subdomain>.workers.dev
//   4. Restart the API, then: npm run demo-alert
//      /pullback/status should then show telegram.reachable = true and usingMirror = true.
//
// SECURITY. The bot token travels in the URL path, exactly as it does to Telegram directly, so this
// Worker can see it — which is fine when the Worker is yours and is why this must be deployed to
// YOUR OWN Cloudflare account and never to a shared or third-party one. Anyone who can reach this
// URL can drive your bot, so treat the URL as a credential: it is as sensitive as the token. The
// optional shared secret below reduces that exposure if the hostname ever leaks.
//
// It forwards only what the Bot API needs and deliberately does not log request bodies — those
// contain your trade alerts.

/** Optional. Set MIRROR_SECRET as a Worker secret and requests must carry `X-Mirror-Secret`. */
const REQUIRE_SECRET = false;

const UPSTREAM = 'https://api.telegram.org';

/** Only the Bot API surface. A wide-open forwarder is an open proxy, which is somebody else's problem to abuse. */
const ALLOWED_PATH = /^\/bot\d+:[A-Za-z0-9_-]+\/[A-Za-z]+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (REQUIRE_SECRET && request.headers.get('X-Mirror-Secret') !== env.MIRROR_SECRET)
      return new Response('forbidden', { status: 403 });

    if (!ALLOWED_PATH.test(url.pathname))
      return new Response('not a Bot API path', { status: 404 });

    const upstream = new URL(url.pathname + url.search, UPSTREAM);

    // The body is streamed through untouched so `sendMessage` keeps its JSON and any future
    // multipart upload keeps its boundary. Host is dropped so fetch sets it for api.telegram.org;
    // sending the Worker's own Host would have Telegram answer a 404 that reads like a bad token.
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('x-mirror-secret');

    try {
      const res = await fetch(upstream, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      });
      // Returned verbatim, status and all. The sender reads Telegram's own `description` field out
      // of error bodies to tell "chat not found" from "bot was blocked", and rewriting the response
      // here would collapse every one of those into a generic failure.
      return new Response(res.body, { status: res.status, headers: res.headers });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, description: `mirror could not reach Telegram: ${e}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
