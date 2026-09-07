# Deploying Trinetra

Production is one always-on Linux host running two services behind nginx:

```
internet ──80──> nginx (open, no auth) ──> Next  :3000 ──> API  127.0.0.1:4100 ──> Upstox
                                                                │
                                                                ├── api/.cache/   (local disk)
                                                                └── Neon Postgres (shared record)
```

> **On a Plesk host, read [PLESK.md](PLESK.md) first.** Plesk owns the domain, TLS and nginx;
> the two Node processes still run under systemd, because the API is a scheduler and Plesk's
> Passenger would idle-stop it overnight — silently killing the 08:00 baseline and the alerts.

**This deployment is intentionally public and unauthenticated.** Anyone with the address can read
the board and the journal, and can also write to it — see "What being open actually means" below.

---

## What actually has to move to the server

| Thing | Why |
|---|---|
| `api/` + `web/` (git) | The code. Both are separate repositories. |
| `api/.env` | Not in git, and cannot be reconstructed. Mode `0600`. |
| `api/.cache/momentum/history.json` | **Not regenerable.** IV rank record — see below. |
| `api/.cache/option-keys/*.json` | **Not regenerable after expiry.** |

Nothing else under `.cache/` needs to travel — roughly 10 MB of baselines, sessions, snapshots and
daily bars all rebuild themselves from the feed on first boot, and the journal, option paths and
candidate log are already mirrored to Neon.

### The two files that must be copied

**`history.json`** is the implied-volatility record. Upstox publishes IV *as of now* and has no
historical-IV endpoint at any tier, so the only way IV Rank can ever exist is to write one row per
symbol per session and wait. `minSessionsForIvRank` is 20. Deploying with this file absent does not
error — it silently resets the count to zero and the factor degrades to `hv-proxy` for a month.

**`option-keys/`** maps strikes to Upstox's opaque instrument keys (`NSE_FO|144219`). The endpoints
that reveal them answer only for *unexpired* series. `tools/option-keys-recover.ts` can rebuild a
missed map, but only with an Upstox Plus subscription and only back to 2024-10-31.

```bash
ssh srv 'mkdir -p /srv/trinetra/api/.cache/momentum /srv/trinetra/api/.cache/option-keys'
scp api/.cache/momentum/history.json  srv:/srv/trinetra/api/.cache/momentum/
scp api/.cache/option-keys/*.json     srv:/srv/trinetra/api/.cache/option-keys/
```

---

## First-time setup

```bash
# 1. user and layout
# --shell /bin/bash so you can `sudo -iu trinetra` to manage git and ssh keys as this account.
# No password is ever set, so it remains unusable as an interactive SSH login.
sudo adduser --system --group --home /srv/trinetra --shell /bin/bash trinetra
sudo mkdir -p /srv/trinetra && sudo chown trinetra:trinetra /srv/trinetra

# 2. node 22.22.2 (matches api/.nvmrc)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

# 3. code
sudo -u trinetra git clone <api-remote> /srv/trinetra/api
sudo -u trinetra git clone <web-remote> /srv/trinetra/web

# 4. secrets — staged through /tmp because /srv/trinetra is owned by the service account
#    and your SSH user cannot write into it directly.  From your machine:
#      scp api/.env srv:/tmp/.env
sudo mv /tmp/.env /srv/trinetra/api/.env
sudo chown trinetra:trinetra /srv/trinetra/api/.env && sudo chmod 600 /srv/trinetra/api/.env

# 5. the two perishable cache files (above)

# 6. services
sudo cp /srv/trinetra/api/deploy/trinetra-*.service /srv/trinetra/api/deploy/trinetra-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trinetra-api trinetra-web trinetra-keys-capture.timer

# 6b. let the service account restart its own units (deploy.sh needs this)
sudo cp /srv/trinetra/api/deploy/trinetra.sudoers /etc/sudoers.d/trinetra
sudo chmod 440 /etc/sudoers.d/trinetra && sudo visudo -c

# 7. nginx — open to the world, no password
sudo apt install -y nginx
sudo cp /srv/trinetra/api/deploy/nginx-trinetra.conf /etc/nginx/sites-available/trinetra
sudo ln -s /etc/nginx/sites-available/trinetra /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
# works now on http://<server-ip>/ — no domain or certificate required

# 8. firewall — 80 open; 4100 and 3000 are internal and stay shut
sudo ufw allow 22,80/tcp && sudo ufw enable

# 9. OPTIONAL, only if you have a domain pointed here. Not auth — HTTPS just stops browsers
#    marking the page "Not secure", and costs one command.
# sudo apt install -y certbot python3-certbot-nginx
# sudo certbot --nginx -d trinetra.example.com
# sudo ufw allow 443/tcp
```

Required in `api/.env` on the server: `UPSTOX_ACCESS_TOKEN`, `DATABASE_URL`, `PORT=4100`,
`HOST=127.0.0.1`, `MOMENTUM_SCHEDULER=on`, `MOMENTUM_SEED=on`, `MOMENTUM_FEED=on`, the
`TELEGRAM_*` / `DISCORD_WEBHOOK_URL` alert credentials, the alert channel switches, and
`MARKET_HOLIDAYS`. `api/.env.example` documents every one.

---

## Routine deploys

```bash
ssh srv
sudo -u trinetra /srv/trinetra/api/deploy/deploy.sh
```

It refuses to run during market hours (a cold boot spends ~624 Upstox requests on the baseline and
session seed, and that budget belongs to the morning scan). `--force` overrides.

---

## What being open actually means

There is no login, by choice. Two consequences are worth knowing precisely, because neither is
obvious from the outside and one of them is about the app working rather than about privacy.

**Everything is readable.** The board, every factor, the full trade journal with entries, exits and
P&L, and the candidate log. If the journal is a record of real money, that is what is being
published.

**Nine routes mutate, and the dashboard proxies them.** `api/src/momentum/controller.ts` exposes
`PUT /config`, `POST /config/reset`, `POST /baseline/rebuild`, `POST /seed`, `POST /scan`,
`POST /alerts/test`, `PATCH /journal/:id`, `POST /journal/:id/exit` and `POST /journal/settle`. The
API is on loopback, but `web/app/api/momentum/**` forwards to them from the public origin, so they
are reachable. Two of these have real teeth:

- `POST /baseline/rebuild` spends ~416 Upstox requests against a 2000-per-30-minute budget. Empty
  that budget and the 08:00 baseline does not build, which takes RVOL off every row for the day.
- `PATCH /journal/:id` and `POST /journal/settle` edit the trade record — the one thing in this app
  that cannot be rebuilt from the feed. Neon holds it, but an edit propagates there too.

The commented `limit_req` block in `nginx-trinetra.conf` caps write rate without touching read
access. It is the one mitigation that costs a visitor nothing, and it exists for the quota problem
above, not for privacy.

**The API still binds loopback**, and that is not a restriction on the public — every page renders
server-side and `web/lib/proxy.ts` points the browser at the web app's own origin, so no visitor
ever needs port 4100. Uncomment the `/raw/` block in the nginx config to publish the JSON API too.

---

## The one recurring chore

`trinetra-keys-capture.timer` fires on the 22nd of each month and captures the option-key map
before the last-Tuesday expiry. Check it:

```bash
systemctl list-timers trinetra-keys-capture
ls /srv/trinetra/api/.cache/option-keys/
```

If a month is missing, `tools/option-keys-recover.ts` can still rebuild it while Upstox Plus is
active. Do not rely on that — it is the fallback, not the plan.

---

## Health and diagnosis

```bash
curl -s 127.0.0.1:4100/health                  # {"ok":true}
curl -s 127.0.0.1:4100/health/volume           # baseline / rate-limit state
journalctl -u trinetra-api -f
npm --prefix /srv/trinetra/api run check-neon   # journal DB round trip
npx --prefix /srv/trinetra/api tsx tools/archive-guard.ts
```

`archive-guard` reports "series expired" counts that are a known false alarm — it lists trades from
Postgres but checks paths only on local disk.

## Two machines, one database

Both this server and your laptop can point at the same `DATABASE_URL`. Only **one** may run the
scheduler. On the laptop use `npm run viewer` — scheduler off, reads the shared record, never
scans. Two schedulers on one database means two processes writing trades for the same signal.
