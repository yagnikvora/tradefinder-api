#!/usr/bin/env bash
# Deploy Trinetra to the production host. Run ON the server, as the `trinetra` user.
#
#   /srv/trinetra/api/deploy/deploy.sh            normal deploy
#   /srv/trinetra/api/deploy/deploy.sh --force    skip the market-hours guard
#
# THE ORDER IS THE POINT. Build first, restart second — never the reverse. `next build` rewrites
# .next in place, so a running `next start` that is serving from it begins answering 500
# "Cannot find module './948.js'" for every route, with nothing in the source to explain it
# (web/next.config.mjs documents this). Build, then restart, and the window never opens.
set -euo pipefail

API=/srv/trinetra/api
WEB=/srv/trinetra/web
FORCE=${1:-}

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# --- guards -------------------------------------------------------------------------------
# A cold boot spends ~416 Upstox requests rebuilding the baseline plus ~208 seeding the session,
# against a budget of 2000 per 30 minutes. Doing that at 09:20 competes with the scan that the
# morning's alerts depend on, and the alerts are the product. IST is computed rather than assumed
# so this is correct on a UTC host — the same +330 arithmetic the app itself uses.
if [[ "$FORCE" != "--force" ]]; then
  ist_min=$(( ( $(date -u +%H) * 60 + $(date -u +%M) + 330 ) % 1440 ))
  dow=$(date -u -d "+330 minutes" +%u)
  if (( dow <= 5 && ist_min >= 525 && ist_min <= 960 )); then
    die "market hours (09:15-16:00 IST). Deploy after the close, or pass --force."
  fi
fi

[[ -f "$API/.env" ]] || die "$API/.env is missing — the app cannot start without a token."
perms=$(stat -c '%a' "$API/.env")
[[ "$perms" == "600" ]] || die ".env is mode $perms; it holds live credentials. chmod 600 it."

# The two files that are NOT regenerable and NOT in Postgres. history.json is the IV-rank record —
# Upstox has no historical-IV endpoint at any tier, so a missing file means starting the 20-session
# accumulation from zero. option-keys/ is the strike->instrument-key map, which cannot be fetched
# once a series expires. Everything else under .cache rebuilds itself from the feed.
[[ -f "$API/.cache/momentum/history.json" ]] \
  || echo "  WARNING: .cache/momentum/history.json absent — IV Rank restarts its 20-session count."
compgen -G "$API/.cache/option-keys/*.json" >/dev/null \
  || echo "  WARNING: no option-key maps in .cache/option-keys/ — run tools/option-keys-capture.ts."

# --- api ----------------------------------------------------------------------------------
say "api — pull, install, build"
cd "$API"
git pull --ff-only
# Full install, INCLUDING devDependencies, and that is deliberate. The runtime needs only cors,
# express and pg — but `npm run build` needs typescript, and the tools/ scripts the server runs on
# a timer (option-keys-capture, archive-guard) are TypeScript run through tsx. Pruning saves a few
# megabytes and costs you the monthly capture, which is a bad trade.
npm ci
npm run build
[[ -f "$API/dist/index.js" ]] || die "build produced no dist/index.js"

# --- web ----------------------------------------------------------------------------------
say "web — pull, install, build"
cd "$WEB"
git pull --ff-only
npm ci
# NEXT_PUBLIC_* is inlined into the client bundle AT BUILD TIME, so anything the browser needs has
# to be exported here — setting it in the systemd unit is too late and silently does nothing.
# API_BASE is not exported: every call to the API is server-side, and the unit supplies it.
npm run build

# --- restart ------------------------------------------------------------------------------
say "restart"
sudo systemctl restart trinetra-api
sudo systemctl restart trinetra-web

# --- verify -------------------------------------------------------------------------------
say "verify"
for i in $(seq 1 20); do
  if curl -fsS -m 3 http://127.0.0.1:4100/health >/dev/null 2>&1; then break; fi
  [[ $i -eq 20 ]] && die "api did not answer /health — journalctl -u trinetra-api -n 50"
  sleep 1
done
curl -fsS -m 5 http://127.0.0.1:4100/health && echo "  api ok"
curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/ && echo "  web ok"

say "deployed"
