# Deploying Trinetra on a Plesk host

Plesk keeps the domain, the DNS and the certificate. **systemd keeps the two Node processes.**
Plesk's own Node.js extension is not used, and the reason is specific rather than stylistic.

```
internet ──80/443──> Plesk nginx ──> Next :3000 ──> API 127.0.0.1:4100 ──> Upstox
   (Plesk owns TLS + domain)          (systemd)        (systemd)
```

---

## Why the API must not run under Plesk's Node.js extension

Plesk runs Node apps under **Phusion Passenger**, which is request-driven: it spawns a process when
an HTTP request arrives and stops it after `passenger_pool_idle_time` (300s by default).

That model is wrong for this app. The API is a **scheduler**, not a web service. Its work happens on
a clock, with no HTTP request behind it:

| Time (IST) | What fires | Needs a live process? |
|---|---|---|
| 08:00 | baseline build, ~416 Upstox requests | yes |
| 09:15 | session bell → Telegram | yes |
| 09:15–15:30 | scan every 15s, alerts, journal writes | yes |
| every 60s | session state flush | yes |
| 15:35 | closing scan, settles the day | yes |

Nobody loads the dashboard at 07:59. Under Passenger the process would be idle-stopped overnight,
so at 08:00 there is no process, no baseline, and — the part that matters — **no alerts**. It fails
silently: the site still answers, because the request that hits it spawns a fresh process which
then believes it has only just booted.

Passenger can be forced to hold a process (`passenger_min_instances 1`,
`passenger_pool_idle_time 0`), but that is fighting the tool to make a scheduler out of a request
handler. systemd already does this correctly, with `Restart=always`. The Next.js dashboard *is*
request-driven and could run under Passenger — but it needs a shim, so it goes under systemd too and
the whole setup stays one mental model.

**Keep the code in `/srv/trinetra`, not under the vhost.** Plesk owns `/var/www/vhosts/<domain>/`:
`plesk repair fs` resets ownership there, and backups would sweep in `node_modules` and the 11 MB
`.cache`. The vhost document root simply goes unused — nginx proxies straight past it.

---

## Steps

Over SSH as root. `README.md` covers the parts Plesk does not change; this file covers the parts it
does.

### 1. Node 22

Plesk ships its own Node builds. List them, and prefer 22 to match `api/.nvmrc`:

```bash
ls /opt/plesk/node/
```

If 22 is absent, add it under **Plesk → Tools & Settings → Updates → Add Components → Node.js**, or
install system-wide from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

Note the resulting path — `/opt/plesk/node/22/bin/node` or `/usr/bin/node`. It is called NODE below.

### 2. Service account and code

Exactly as in `README.md` steps 1, 3, 5 and 6 — the `trinetra` user, `/srv/trinetra`, the two GitHub
deploy keys, and both clones on branch `feature/paper-trade-added`. Plesk changes none of it.

### 3. Point the units at the right Node

Both units are written for `/usr/bin/node`. If Plesk's Node is what you have:

```bash
sed -i 's#/usr/bin/node#/opt/plesk/node/22/bin/node#' /srv/trinetra/api/deploy/trinetra-api.service
```

The web unit calls `npx`, which resolves against `PATH` and will not find Plesk's Node. Point it at
the binary directly instead:

```bash
sed -i 's#ExecStart=/usr/bin/npx next start -p 3000#ExecStart=/opt/plesk/node/22/bin/node node_modules/next/dist/bin/next start -p 3000#' \
  /srv/trinetra/api/deploy/trinetra-web.service
```

Then install both units, the sudoers rule and the capture timer, per `README.md` steps 6 and 6b.

### 4. Build and start

`README.md` steps 4, 5, 9, 10 and 11 unchanged — `.env` at mode 600 with `HOST=127.0.0.1`, the two
perishable cache files, `npm ci && npm run build` in each repo, then:

```bash
systemctl enable --now trinetra-api trinetra-web
curl -s 127.0.0.1:4100/health       # {"ok":true}
curl -sI 127.0.0.1:3000/ | head -1  # HTTP/1.1 200
```

Both must pass before Plesk is touched. If they do not, nginx is not the problem.

### 5. The domain in Plesk

Add the domain (**Websites & Domains → Add Domain**) with any document root; it will not be read.
Then open **Websites & Domains → your domain → Apache & nginx Settings**:

1. Untick **Proxy mode**. That stops nginx handing the request to Apache, which has nothing to serve
   here and only adds a hop.
2. Paste this into **Additional nginx directives**:

```nginx
# Trinetra — everything goes to the Next.js dashboard on :3000.
#
# `location ~ ^/` and NOT `location /` on purpose. Plesk's template already emits a `location /`
# in this server block, and a second one is a "duplicate location" error that refuses to save.
# A regex location is a different kind of location, so it coexists — and nginx matches regex
# locations BEFORE prefix ones, so this one wins.
location ~ ^/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        "upgrade";

    # /momentum/journal/exit-lab grades every archived option path in one request and is
    # legitimately slower than the 60s default. The 2s dashboard poll is unaffected.
    proxy_read_timeout 120s;
}

# The dashboard polls every 2s and a snapshot is ~1.8MB unzipped. Compression is not a nicety.
gzip on;
gzip_types application/json text/css application/javascript;
gzip_min_length 1024;
```

Click **OK** — Plesk validates the config and refuses the save if it is wrong, which is a faster
feedback loop than `nginx -t`.

### 6. TLS (optional, one click)

**SSL/TLS Certificates → Install a free basic certificate (Let's Encrypt)**. There is no login on
this site, so nothing is being protected — it only stops browsers marking the page "Not secure". If
you enable it, also tick **Redirect from http to https** in Hosting Settings.

### 7. Firewall

Plesk's firewall (**Tools & Settings → Firewall**) must allow 80 and 443, and must **not** open 3000
or 4100. Both are loopback-bound already; do not add rules for them.

### 8. Verify from outside

```bash
curl -sI http://yourdomain.com/ | head -1     # 200, and no 401
```

Then capture the option keys and watch the first market open — `README.md`, Phase 6.

---

## Plesk-specific things that will bite

**Do not enable the Node.js extension on this domain.** If it is on, Plesk injects its own Passenger
directives into the same server block and they fight the proxy above. If the domain ever had it
enabled, turn it off and re-save Apache & nginx Settings.

**`plesk repair` and template rebuilds** regenerate vhost configs from Plesk's own templates.
Additional nginx directives are stored in Plesk's database and survive that. Anything hand-edited in
`/var/www/vhosts/system/<domain>/conf/` does not — which is the other reason the config belongs in
the Plesk field rather than in a file.

**Plesk's nginx is the only nginx.** Do not also install `deploy/nginx-trinetra.conf` from this
directory: it declares `default_server` on port 80 and would collide. That file is for a plain host
with no control panel.

**Logs are in two places.** The app logs to the journal, not to the vhost logs:

```bash
journalctl -u trinetra-api -f
journalctl -u trinetra-web -f
tail -f /var/www/vhosts/system/yourdomain.com/logs/proxy_error_log   # nginx side only
```

**Deploys are unchanged.** `deploy/deploy.sh` never touches nginx, so it works as-is:

```bash
sudo -u trinetra /srv/trinetra/api/deploy/deploy.sh
```
