https://voltpay-dashboard.vercel.app/# Running the VoltPay API on the InterServer VPS

Since 14 October 2026 the VoltPay API runs on our own server at InterServer, not
on Render and not on a laptop behind a tunnel. This document is the whole process:
how the server is put together, how to ship new code, how to add or change a
setting, how to check on it, what is still left to do, and how to rebuild it from
nothing.

`RENDER_DEPLOY.md` beside this file describes the old Render setup. It is kept for
history only.

---

## Contents

- [Contents](#contents)
- [At a glance](#at-a-glance)
- [How the pieces fit together](#how-the-pieces-fit-together)
- [Shipping new code](#shipping-new-code)
  - [Step 1 — push the backend](#step-1--push-the-backend)
  - [Step 2 — deploy](#step-2--deploy)
  - [Step 3 — act on any warning](#step-3--act-on-any-warning)
  - [Deploy options](#deploy-options)
  - [When not to deploy](#when-not-to-deploy)
- [Adding or changing a setting (.env)](#adding-or-changing-a-setting-env)
  - [The quick way: voltpay-env](#the-quick-way-voltpay-env)
  - [When new code needs a new setting](#when-new-code-needs-a-new-setting)
  - [Rules](#rules)
  - [By hand, if you prefer](#by-hand-if-you-prefer)
- [Database setup scripts (ddl)](#database-setup-scripts-ddl)
- [Checking on the server](#checking-on-the-server)
- [Rolling back, restarting, rebooting](#rolling-back-restarting-rebooting)
- [HTTPS](#https)
  - [Moving to a real domain later](#moving-to-a-real-domain-later)
- [Access and security](#access-and-security)
- [Still to do](#still-to-do)
- [Troubleshooting](#troubleshooting)
- [Appendix A — what is on the server](#appendix-a--what-is-on-the-server)
  - [Production .env: what differs from the laptop](#production-env-what-differs-from-the-laptop)
  - [Settings the API needs](#settings-the-api-needs)
  - [npm and install scripts](#npm-and-install-scripts)
- [Appendix B — rebuilding the server from scratch](#appendix-b--rebuilding-the-server-from-scratch)
  - [1. Base system, Node.js 24, PM2, firewall](#1-base-system-nodejs-24-pm2-firewall)
  - [2. App user, deploy key, code](#2-app-user-deploy-key-code)
  - [3. The helper commands](#3-the-helper-commands)
  - [4. Production .env](#4-production-env)
  - [5. Install and start the app](#5-install-and-start-the-app)
  - [6. Log rotation](#6-log-rotation)
  - [7. nginx and HTTPS](#7-nginx-and-https)
- [Appendix C — the two helper commands](#appendix-c--the-two-helper-commands)

---

## At a glance

| | |
|---|---|
| **API address (use this in the app)** | `https://162-35-105-36.sslip.io`; the app adds `/api/` itself |
| **Health check** | `http://162.35.105.36/health`, or `https://162-35-105-36.sslip.io/health` |
| **Ship new code** | `ssh root@162.35.105.36 voltpay-deploy` |
| **Add or change a setting** | `ssh -t root@162.35.105.36 voltpay-env set KEY` |
| **Log in to the server** | `ssh root@162.35.105.36` (SSH key, no password) |
| **Server** | InterServer VPS `vps3718201`, IP `162.35.105.36`, Ubuntu 26.04, 1.6 GB RAM |
| **App on the server** | `/var/www/voltpay-backend`, run by the `voltpay` user under PM2 as `voltpay-api` |
| **Database and cache** | Neon Postgres and Upstash Redis, exactly as before. Neither runs on the VPS |

Every command in this document is typed into **PowerShell on Windows**, unless the
text says it runs **on the server**.

---

## How the pieces fit together

```
Phone app, admin dashboard, provider webhooks
        |
        |  HTTPS (port 443)   https://162-35-105-36.sslip.io
        v
nginx   - HTTPS certificate, access log, 120 s timeout, 100 MB uploads,
          plain HTTP sent on to HTTPS (308)
        |
        |  http://127.0.0.1:3000   (port 3000 is closed to the internet)
        v
PM2 -> node server.js   (process "voltpay-api", runs as user voltpay)
          the API + StaffPay payroll + scheduled top-ups + background sweeps
        |                                   |
        v                                   v
Neon Postgres (the database)        Upstash Redis (caches)
```

**nginx** is the front door. It holds the HTTPS certificate, writes the access log,
and passes each request to the app. Four of its settings exist because of how the
app behaves:

- **A 120-second timeout.** Airtime to Cash step 3 waits up to 90 seconds for
  MySubWallet, and a USD card create up to 60. nginx's default of 60 seconds would
  cut the customer off while their conversion may still be going through.
- **A 100 MB upload limit.** CAC registration sends up to 16 documents of 5 MB each
  in a single request.
- **It logs the path, never the query string.** The app's live-notification
  WebSocket sends the user's session token as `?token=...`, and the default log
  format would save live tokens to disk.
- **Plain HTTP answers only `/health` and `/ping`.** Every other HTTP request is
  sent on to HTTPS with a `308`. Unlike the usual `301`, a `308` keeps a POST a POST,
  so a webhook pointed at the wrong address fails loudly instead of losing its body.

**PM2** keeps `node server.js` running. It restarts the app if it crashes, starts
it again after a reboot (systemd service `pm2-voltpay`), restarts it if it ever
grows past 800 MB, and gives it 12 seconds to finish requests in progress before any
restart.

**The app runs as exactly one copy, on purpose.** Besides answering the API,
`server.js` runs the StaffPay payroll scheduler, scheduled top-ups and about a dozen
background sweeps (bills, betting, Airtime to Cash, CAC, USD cards). Two copies would
run all of them twice. Never add a second copy (no PM2 cluster mode, no second
server), and keep the three scheduler flags switched off on the laptop. They have
been off since 14 October 2026.

**The firewall** opens only SSH (22), HTTP (80) and HTTPS (443). Port 3000, where
the app itself listens, must stay closed. The app takes each customer's IP address
from a header that nginx adds. If port 3000 were reachable, anyone could write that
header themselves and slip past the rate limits and the login lockout.

---

## Shipping new code

### Step 1 — push the backend

The backend is its own git repository (`backend\` has its own `.git`), so run git
from inside `backend\`, never from the `voltpay` folder above it:

```powershell
cd "C:\Users\JADE EDGE TECHNOLOGY\Desktop\voltpay\backend"
git status
git add <the files you changed>
git commit -m "Say what changed and why"
git push origin main
```

The server only ever deploys `main`.

### Step 2 — deploy

```powershell
ssh root@162.35.105.36 voltpay-deploy
```

That one command does all of this, in order:

1. **It refuses during the StaffPay payday window**, the 25th to the 29th of each
   month, unless you add `--force`. See [When not to deploy](#when-not-to-deploy).
2. **It fetches `main` from GitHub.** If nothing is new, it prints `Already up to
   date` and stops. The running API is not touched.
3. **It lists the commits** it is about to deploy.
4. **It remembers the version running now**, so that `--rollback` can return to it.
5. **It updates the code.** This is a fast-forward only: it never merges or
   overwrites anything.
6. **It restarts the API.** If `package.json`, `package-lock.json` or
   `prisma/schema.prisma` changed, it first stops the API and reinstalls the
   dependencies (`npm ci`, which also rebuilds the Prisma client). That means about
   **a minute of downtime**. Otherwise it is a plain restart of about **5 seconds**.
7. **It waits up to 30 seconds for `/health`** to report healthy. If the API doesn't
   come back, it prints the last 30 log lines and the rollback command.
8. **It warns you about follow-ups** the update needs (step 3).

A normal deploy looks like this (the commit line is only an example):

```
Deploying:
  a1b2c3d Fix rounding on bill receipts
Restarting...
Healthy: {"status":"healthy","database":"connected","redis":"connected","timestamp":"..."}
```

### Step 3 — act on any warning

| Warning | Meaning | Do this |
|---|---|---|
| `!! New settings in .env.example that this server does not have: KEY1 KEY2` | The new code documents a setting the server lacks | Add each one: [Adding or changing a setting](#adding-or-changing-a-setting-env) |
| `!! This update changes database setup. Run each once ...` | The update adds or changes a `ddl:*` script | Run the `npm run ddl:...` it names: [Database setup scripts](#database-setup-scripts-ddl) |

### Deploy options

| Command | When to use it |
|---|---|
| `ssh root@162.35.105.36 voltpay-deploy` | A normal deploy |
| `ssh root@162.35.105.36 voltpay-deploy --rollback` | The new version misbehaves; go back to the one before |
| `ssh root@162.35.105.36 voltpay-deploy --restart` | Restart only, for example after editing `.env` by hand |
| `ssh root@162.35.105.36 voltpay-deploy --reinstall` | Recovery: a reinstall was interrupted and the API is down |
| `ssh root@162.35.105.36 voltpay-deploy --force` | Deploy anyway during the payday window |
| `ssh root@162.35.105.36 voltpay-deploy --help` | Show these options |

### When not to deploy

From the 25th to the 29th, companies' salaries go out automatically, by default at
09:00 Lagos time. Payroll runs are built to recover from a restart in the middle of
a run, but payday is the worst possible moment to discover a bug. That is why the
command refuses on those days without `--force`. Outside that window, deploy when
you can watch the result for a few minutes.

---

## Adding or changing a setting (.env)

The API's settings and secrets live in one file on the server,
`/var/www/voltpay-backend/.env`. That file is **not in git and must never be**. It
holds every secret that moves money, so a `git push` can never carry a new setting.
Settings are changed on the server directly.

### The quick way: voltpay-env

```powershell
ssh -t root@162.35.105.36 voltpay-env set NEW_KEY
```

It asks `Value for NEW_KEY (hidden):`. Paste or type the value and press Enter.
Nothing appears on screen, and nothing lands in your PowerShell history. It then
saves the setting, restarts the API and checks `/health`. The `-t` is what makes the
hidden prompt work; without it, the value shows as you type it.

| Command | What it does |
|---|---|
| `ssh root@162.35.105.36 voltpay-env list` | Lists setting **names**. Values are never printed |
| `ssh -t root@162.35.105.36 voltpay-env set KEY` | Adds or replaces a setting with a hidden prompt, then restarts |
| `ssh root@162.35.105.36 voltpay-env set KEY VALUE` | The same, with the value on the command line. Only for non-secrets, since the value lands in your PowerShell history |
| `ssh root@162.35.105.36 voltpay-env unset KEY` | Removes a setting, then restarts |
| Add `--no-restart` to `set` or `unset` | Saves without restarting. Use it to change several settings, then run `voltpay-deploy --restart` once |

Values are one line each. `voltpay-env` adds quotes when a value needs them (see the
`#` rule below), so paste the raw value without quotes around it.

### When new code needs a new setting

Work in this order, so that the code and its setting arrive together:

1. On the laptop, add the key to `backend\.env` (for local work), and add it to
   `backend\.env.example` **without its value**, then push the code. The
   `.env.example` entry is what lets the deploy warn you when the server lacks it.
2. Add the setting on the server without restarting:
   ```powershell
   ssh -t root@162.35.105.36 voltpay-env set NEW_KEY --no-restart
   ```
3. Deploy. One restart picks up the new code and the new setting together:
   ```powershell
   ssh root@162.35.105.36 voltpay-deploy
   ```

If you skip step 2, the deploy still finishes, then warns you.

### Rules

- **Never copy the laptop's `.env` onto the server.** The two files now differ on
  purpose ([see the table](#production-env-what-differs-from-the-laptop)). Most
  dangerously, the laptop has the payroll and top-up schedulers switched **off**, so
  copying it over would silently stop salaries.
- **Never commit `.env`.** `.gitignore` already excludes it; keep it that way.
- **`PII_ENC_KEY` and `PII_HASH_KEY` never change.** They encrypt and index every user
  record already in the database. A new value makes every existing user "not found"
  until a full re-index (`scripts/backfill-pii.js --reindex`). `voltpay-env` refuses
  to change either one without `--force`.
- **Changing `JWT_SECRET` signs every customer out**, and changing
  `ADMIN_JWT_SECRET` signs every admin out. Only change them on purpose.
- **A value containing `#` or a space must be quoted** in the file, because the
  `.env` reader stops an unquoted value at `#`. For example, `PASSWORD=ab#cd` is read
  as `ab`. `voltpay-env` adds the quotes for you.
- **Add every new key to the laptop's `.env` as well.** That file plus the table below
  is what the server is rebuilt from if it is ever lost.

### By hand, if you prefer

Log in:

```powershell
ssh root@162.35.105.36
```

Then, **on the server**:

```bash
nano /var/www/voltpay-backend/.env      # edit; Ctrl+O then Enter saves, Ctrl+X quits
voltpay-deploy --restart
```

Wrap any value containing `#`, spaces or quotes in single quotes:
`KEY='value with # inside'`.

---

## Database setup scripts (ddl)

Some features come with a script that creates or reshapes their tables, run with
`npm run ddl:<name>` (for example `npm run ddl:cac`). The deploy tells you when an
update adds or changes one.

- **Run it once, right after the deploy.** Until it has run, the feature it belongs
  to answers "temporarily unavailable" (HTTP 503) instead of working. The rest of the
  API is unaffected. The scripts are written to be safe to run more than once.
- **From the laptop**, as you always have. It is the same Neon database:
  ```powershell
  cd "C:\Users\JADE EDGE TECHNOLOGY\Desktop\voltpay\backend"
  npm run ddl:cac
  ```
- **Or on the server**, from PowerShell:
  ```powershell
  ssh root@162.35.105.36 "su - voltpay -c 'cd /var/www/voltpay-backend && npm run ddl:cac'"
  ```

---

## Checking on the server

| What | Command |
|---|---|
| Is it healthy? | `curl.exe -s https://162-35-105-36.sslip.io/health` |
| Is the process up? | `ssh root@162.35.105.36 "su - voltpay -c 'pm2 ls'"` |
| The last 100 log lines | `ssh root@162.35.105.36 "su - voltpay -c 'pm2 logs voltpay-api --lines 100 --nostream'"` |
| Watch the log live | `ssh -t root@162.35.105.36 "su - voltpay -c 'pm2 logs voltpay-api'"` (Ctrl+C stops watching; the API keeps running) |
| Memory and disk | `ssh root@162.35.105.36 "free -h; df -h /"` |
| Which version is live | `ssh root@162.35.105.36 "su - voltpay -c 'cd /var/www/voltpay-backend && git log --oneline -1'"` |

A healthy answer looks like this:

```json
{"status":"healthy","database":"connected","redis":"connected","timestamp":"2026-10-14T14:48:03.624Z"}
```

`database` is Neon and `redis` is Upstash. Redis being down makes the API slower,
never broken, because every cache falls back to the database.

When the API starts up healthy, its log shows these lines. It must **not** show
`⚠️ StaffPay automatic payroll is NOT running`:

```
🔥 Firebase Admin SDK initialized { source: 'FIREBASE_SERVICE_ACCOUNT_JSON' }
⏱️  StaffPay scheduler started { enabled: true, ... autopay_enabled: true ... }
⏱️  Scheduled top-ups worker started { tick_interval_ms: 60000, batch: 25 }
🚀 VoltPay API server running on http://localhost:3000
⚡ Redis cache enabled (Upstash REST)
📚 Bills catalogues warmed (4 loaded, 0 failed, ...)
```

One warning is expected until it is fixed: `CORS_ALLOWED_ORIGINS is unset in
production` (see [Still to do](#still-to-do)).

The app's logs are in `/home/voltpay/.pm2/logs/` (rotated daily, 14 days kept).
nginx's access log is `/var/log/nginx/voltpay-api.access.log`.

---

## Rolling back, restarting, rebooting

**Rolling back.** If a deploy misbehaves:

```powershell
ssh root@162.35.105.36 voltpay-deploy --rollback
```

This returns to the version that ran before the last deploy, reinstalling
dependencies if they differ, and checks health. Running it a second time returns to
where you were. Then fix the problem on the laptop, push, and deploy normally. A
rollback changes only the code. It does not undo a database script you ran or a
setting you changed.

**Restarting:**

```powershell
ssh root@162.35.105.36 voltpay-deploy --restart
```

**Rebooting the server** is safe. PM2, nginx and the firewall all start on their own,
and the API is back in under a minute (tested on 14 October 2026):

```powershell
ssh root@162.35.105.36 reboot
```

---

## HTTPS

We have no domain, so the server's name is `162-35-105-36.sslip.io`. sslip.io is a
free public service: every name it answers for points at the IP address written
inside the name. Nothing was bought or registered.

- **The certificate** is a free 90-day Let's Encrypt certificate. `certbot.timer`
  checks twice a day, renews about 30 days before expiry, and reloads nginx, so there
  is nothing to do by hand. The current certificate runs to 12 January 2027 and will
  be renewed before then.
- **To check that renewal works:** `ssh root@162.35.105.36 certbot renew --dry-run`
- **Older phones** are covered: the certificate chains to ISRG Root X1, which every
  Android phone since 7.1.1 trusts.
- **The one risk** is that sslip.io is a free third-party service. If it ever stops
  answering, phones cannot find the server even though the server itself is fine. In
  that case `http://162.35.105.36/health` still works, which tells you the problem
  is the name, not the server.

### Moving to a real domain later

1. At your domain's DNS provider, add an `A` record (for example `api`) pointing at
   `162.35.105.36`. If the DNS is on Cloudflare, set the record to **DNS only** (grey
   cloud). Behind Cloudflare's proxy, every customer would share Cloudflare's IP
   addresses in the rate limiter.
2. **On the server**, add the new name to the certificate and to nginx, keeping the
   old name working for phones that haven't updated yet. Answer `U` (update) if
   certbot asks:
   ```bash
   DOMAIN=api.yourdomain.com
   certbot certonly --webroot -w /var/www/letsencrypt --cert-name 162-35-105-36.sslip.io \
     -d 162-35-105-36.sslip.io -d "$DOMAIN"
   sed -i "s/server_name 162-35-105-36.sslip.io;/server_name 162-35-105-36.sslip.io $DOMAIN;/" \
     /etc/nginx/sites-available/voltpay-api
   nginx -t && systemctl reload nginx
   voltpay-env set PUBLIC_BASE_URL "https://$DOMAIN"
   ```
3. Point the app, the admin dashboard and the provider webhooks at the new address.
   The list is the same as in [Still to do](#still-to-do).

---

## Access and security

- **Logging in.** `ssh root@162.35.105.36` uses the SSH key at
  `C:\Users\JADE EDGE TECHNOLOGY\.ssh\id_ed25519` on the laptop, with no password. To
  let another computer in, send its public key from a computer that can already log
  in:
  ```powershell
  Get-Content C:\path\to\other-computer.pub | ssh root@162.35.105.36 "cat >> ~/.ssh/authorized_keys"
  ```
- **The root password** must be changed, because the current one was shared in a chat.
  Run `ssh root@162.35.105.36`, then `passwd`. Once everyone logs in with keys, you can
  switch password logins off entirely. Do this **on the server**, and only after
  confirming that key login works from a second window:
  ```bash
  printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-voltpay.conf
  sshd -t && systemctl restart ssh
  ```
  After that, the only ways in are a computer whose key is in
  `/root/.ssh/authorized_keys`, or InterServer's web console.
- **The code** is pulled from GitHub with a read-only deploy key
  (`/home/voltpay/.ssh/id_ed25519`). It is listed under the repository's
  Settings → Deploy keys as "InterServer VPS", and it can read the repository and
  nothing else.
- **Remote Desktop.** The server came with a desktop and Remote Desktop (xrdp). The
  firewall closes its port, 3389, to the internet. To use the desktop, tunnel through
  SSH:
  ```powershell
  ssh -L 13389:localhost:3389 root@162.35.105.36
  ```
  Leave that window open, and connect Remote Desktop to `localhost:13389`. If nobody
  uses the desktop, switching it off frees a few hundred MB of memory. Run
  `systemctl disable --now xrdp lightdm` **on the server**; undo it with
  `systemctl enable --now lightdm xrdp`.

---

## Still to do

As of 14 October 2026:

- [ ] **Point the app at the server.** In `lib\environment.dart`, change line 28
  (`LIVE_API_URL`) and line 30 (`TEST_API_URL`) to `'https://162-35-105-36.sslip.io'`,
  then build and publish the new APK. Installed copies still call the old tunnel
  address, which no longer exists, so they cannot be prompted to update. Customers
  need to download the new APK.
- [ ] **Set the webhook URLs** in the provider dashboards:
  - PaymentPoint: `https://162-35-105-36.sslip.io/api/funding/webhook`
  - Paystack (one URL covers StaffPay, CAC and Airtime to Cash):
    `https://162-35-105-36.sslip.io/api/staffpay/wallet/webhook`
  - Payvessel (USD cards): `https://162-35-105-36.sslip.io/api/virtual-card/webhook`.
    Payvessel may refuse an address that isn't the business's own domain. Card money
    still settles through the background sweep; only the instant "You paid $X at Y"
    notifications need this webhook.
  - Nothing else needs a dashboard setting. Betting callbacks and checkout return
    pages are built from `PUBLIC_BASE_URL` automatically, and MySubWallet has no
    webhook setting.
- [ ] **Add `162.35.105.36` to provider IP allowlists.** Start with **Brevo**
  (Security → Authorised IPs), or OTP and password-reset emails can fail. Then add it
  in Payvessel, PaymentPoint, ArewaSmart and Paystack, for any of them that restrict
  by IP. MySubWallet already accepts the server.
- [ ] **Point the admin dashboard at the server:** set
  `BACKEND_API_URL=https://162-35-105-36.sslip.io` wherever the dashboard is hosted.
- [ ] **Change the root password** (see [Access and security](#access-and-security)).
- [ ] **Set the two missing settings.** `CORS_ALLOWED_ORIGINS` is the admin
  dashboard's https address (the phone app is unaffected). `ALERT_WEBHOOK_URL` is a
  Slack or Discord incoming webhook; without it, alerts meant for whoever is on call
  only reach the log.

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `Another deploy is already running.` | A deploy is running in another window | Wait for it. The lock frees itself when that deploy ends |
| `Not possible to fast-forward` | Code was edited on the server, or `main` was force-pushed on GitHub | Never edit code on the server. Check with `ssh root@162.35.105.36 "su - voltpay -c 'cd /var/www/voltpay-backend && git status'"` |
| `did not report healthy within 30 seconds` | The new code fails at start-up, often because a setting is missing | Read the log lines it printed, run `voltpay-deploy --rollback`, then fix and deploy again |
| `The deploy stopped partway and the API is probably down` | The dependency reinstall failed (network or npm registry) | Run `voltpay-deploy --reinstall` once the network is back |
| `502 Bad Gateway` | nginx is up but the app is not | Check `pm2 ls` and the log ([Checking on the server](#checking-on-the-server)), then run `voltpay-deploy --restart` |
| `413 Request Entity Too Large` | An upload over 100 MB | Raise `client_max_body_size` in both server blocks of the nginx site |
| `/health` shows `"database":"disconnected"` | Neon is unreachable, or `DATABASE_URL` is wrong | Check the Neon console, then the setting |
| OTP or password-reset emails stop | Brevo is blocking the server's IP | Brevo → Security → Authorised IPs → add `162.35.105.36` |
| Customers see "briefly unavailable" for one provider | That provider refuses the server's IP or key | Check that provider's IP allowlist, and the log for its message |
| A certificate error in the app | Renewal is failing, or sslip.io is down | Run `certbot renew --dry-run`. If `http://162.35.105.36/health` works but HTTPS doesn't, the problem is the certificate or the name |
| Slow, or `pm2 ls` shows many restarts | Out of memory | Check `free -h`. PM2 restarts the app above 800 MB, and switching off the desktop frees memory |

---

## Appendix A — what is on the server

| Path or name | What it is |
|---|---|
| `/var/www/voltpay-backend` | The code: a git clone of `voltpay-backend` on branch `main`, owned by `voltpay` |
| `/var/www/voltpay-backend/.env` | The production settings, mode 600 (readable only by `voltpay`) |
| `voltpay` user | Runs the app. It has no password and no sudo |
| PM2 process `voltpay-api` | `node server.js` in fork mode, one instance, `--kill-timeout 12000 --max-memory-restart 800M --time` |
| systemd `pm2-voltpay` | Starts PM2, and with it the app, at boot |
| `/usr/local/bin/voltpay-deploy`, `/usr/local/bin/voltpay-env` | The two helper commands ([Appendix C](#appendix-c--the-two-helper-commands)) |
| `/home/voltpay/.voltpay-previous-deploy` | The commit that `--rollback` returns to |
| `/etc/nginx/sites-available/voltpay-api` | The nginx site (linked from `sites-enabled`) |
| `/etc/nginx/snippets/voltpay-proxy.conf` | Proxy settings shared by the HTTP and HTTPS blocks |
| `/etc/letsencrypt/live/162-35-105-36.sslip.io/` | The certificate, renewed by `certbot.timer` |
| `/var/www/letsencrypt` | Where certbot proves we control the name at each renewal |
| `/etc/logrotate.d/voltpay-pm2` | Rotates the PM2 logs daily and keeps 14 days |
| `/home/voltpay/.pm2/logs/` | The app's logs: `voltpay-api-out.log` and `voltpay-api-error.log` |
| `/var/log/nginx/voltpay-api.*.log` | nginx's access and error logs |
| `/home/swapfile` | 512 MB of swap, which came with the server |
| Firewall (UFW) | Allows only ports 22, 80 and 443 |

Software: Ubuntu 26.04.1, Node.js 24.21 (from NodeSource), npm 11.19, PM2 7.0,
nginx 1.28 and certbot 4.0. The time zone is Africa/Lagos.

### Production .env: what differs from the laptop

The server's `.env` started as a copy of the laptop's, with these changes:

| Setting | On the server | On the laptop |
|---|---|---|
| `NODE_ENV` | `production` | `development` |
| `PORT` | `3000` | `4000` |
| `PUBLIC_BASE_URL` | `https://162-35-105-36.sslip.io` | the old tunnel address |
| `TZ` | `Africa/Lagos` | not set |
| `HTTP_LOGGING` | `0` | `1` |
| `STAFFPAY_SCHEDULER_ENABLED`, `STAFFPAY_AUTOPAY_ENABLED`, `SCHEDULED_TOPUPS_ENABLED` | on | **off** |
| `STAFFPAY_AUTOPAY_INTERVAL_MS` | `30000` | not set |
| `MYSUBWALLET_CASH_TIMEOUT_MS` | `90000` | not set |
| `STAFFPAY_SCHEDULER_DEBUG`, `STAFFPAY_WEBHOOK_DEBUG` | off | unchanged |

`STAFFPAY_AUTOPAY_INTERVAL_MS` has to be below the scheduler's 60-second tick.
`render.yaml` explains why: at an equal value, autopay runs only every other minute.

### Settings the API needs

| Group | Settings |
|---|---|
| Runtime | `NODE_ENV`, `PORT`, `PUBLIC_BASE_URL`, `TZ` (`API_PREFIX` defaults to `/api`) |
| Database (Neon) | `DATABASE_URL` (pooled), `DIRECT_URL` (direct) |
| Encryption and sessions | `PII_HASH_KEY`, `PII_ENC_KEY`, `JWT_SECRET`, `ADMIN_JWT_SECRET`, and `ADMIN_API_SECRET` (the admin dashboard signs in with it) |
| Money and identity providers | `PAYSTACK_SECRET_KEY`, `PAYMENTPOINT_API_KEY`, `PAYMENTPOINT_SECRET_KEY`, `PAYMENTPOINT_BUSINESS_ID`, `PAYVESSEL_API_KEY`, `PAYVESSEL_API_SECRET`, `MYSUBWALLET_API_KEY`, `AREWASMART_API_TOKEN` |
| Email, push, files, cache | `BREVO_API_KEY`, `BREVO_FROM`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_PROJECT_ID`, `UPLOADTHING_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Background jobs | `STAFFPAY_SCHEDULER_ENABLED`, `STAFFPAY_AUTOPAY_ENABLED`, `SCHEDULED_TOPUPS_ENABLED` |
| Strongly recommended | `CORS_ALLOWED_ORIGINS`, `ALERT_WEBHOOK_URL` |
| Never on the server | `ALLOW_MOCK_OTP`, `DEV_BYPASS_EMAIL_OTP`, `DEV_INCLUDE_OTP_IN_RESPONSE` |

Every other setting has a default in the code and is documented in `.env.example`
and `render.yaml`.

### npm and install scripts

npm 11.19 on the server does not run dependencies' own install scripts unless they
are approved. Five are skipped: `prisma`, `@prisma/engines`, `protobufjs`,
`msgpackr-extract` and `win-ca`. None of them is needed at runtime, because the app
reaches Neon through Prisma's `@prisma/adapter-pg` driver adapter. **Do not run
`npm install-scripts approve` or `deny` on the server.** Both write to `package.json`,
and a locally edited `package.json` can make a later deploy fail at the git step.

---

## Appendix B — rebuilding the server from scratch

If the server is ever lost, these steps recreate it. Everything runs **on the new
server, as root**. If the new server has a different IP address, replace
`162-35-105-36` and `162.35.105.36` everywhere below, and in [Still to do](#still-to-do),
with the new address.

### 1. Base system, Node.js 24, PM2, firewall

```bash
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
timedatectl set-timezone Africa/Lagos
apt-get update
apt-get install -y git curl ca-certificates gnupg nginx ufw certbot

curl -fsSL https://deb.nodesource.com/setup_24.x -o /root/nodesource_setup.sh
bash /root/nodesource_setup.sh
# If the image already ships Ubuntu's own Node.js, dry-run first and check that
# only Node packages would be removed:  apt-get install -s nodejs | grep Remv
apt-get install -y nodejs
npm install -g pm2

ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable
```

### 2. App user, deploy key, code

```bash
useradd -m -s /bin/bash voltpay
install -d -o voltpay -g voltpay /var/www/voltpay-backend
su - voltpay -c 'ssh-keygen -q -t ed25519 -N "" -C voltpay-vps-deploy -f ~/.ssh/id_ed25519; cat ~/.ssh/id_ed25519.pub'
```

Add the printed key on GitHub under **voltpay-backend → Settings → Deploy keys → Add
deploy key**, with **Allow write access unchecked**, and delete the old server's key.
Then:

```bash
su - voltpay -c 'ssh -T git@github.com'
# answer "yes" only if the ED25519 fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
su - voltpay -c 'git clone git@github.com:WebDev-Insider/voltpay-backend.git /var/www/voltpay-backend'
```

### 3. The helper commands

Install both from [Appendix C](#appendix-c--the-two-helper-commands). For each one,
run `cat > /usr/local/bin/NAME <<'EOF'`, paste the script, type a line containing
only `EOF`, then run `chmod 755 /usr/local/bin/NAME`.

### 4. Production .env

From PowerShell on the laptop, copy the laptop's `.env` up:

```powershell
scp "C:\Users\JADE EDGE TECHNOLOGY\Desktop\voltpay\backend\.env" root@162.35.105.36:/root/voltpay.env
```

Then, on the server, put it in place and apply **every** row of
[the differences table](#production-env-what-differs-from-the-laptop). Above all,
switch the three scheduler flags back on:

```bash
install -m 600 -o voltpay -g voltpay /root/voltpay.env /var/www/voltpay-backend/.env
shred -u /root/voltpay.env
sed -i 's/\r$//' /var/www/voltpay-backend/.env        # Windows line endings off
voltpay-env set NODE_ENV production --no-restart
voltpay-env set PORT 3000 --no-restart
voltpay-env set PUBLIC_BASE_URL https://162-35-105-36.sslip.io --no-restart
voltpay-env set TZ Africa/Lagos --no-restart
voltpay-env set HTTP_LOGGING 0 --no-restart
voltpay-env set STAFFPAY_SCHEDULER_ENABLED true --no-restart
voltpay-env set STAFFPAY_AUTOPAY_ENABLED true --no-restart
voltpay-env set SCHEDULED_TOPUPS_ENABLED true --no-restart
voltpay-env set STAFFPAY_AUTOPAY_INTERVAL_MS 30000 --no-restart
voltpay-env set MYSUBWALLET_CASH_TIMEOUT_MS 90000 --no-restart
voltpay-env set STAFFPAY_SCHEDULER_DEBUG false --no-restart
voltpay-env set STAFFPAY_WEBHOOK_DEBUG 0 --no-restart
```

### 5. Install and start the app

```bash
su - voltpay -c 'cd /var/www/voltpay-backend && npm ci --omit=dev'
su - voltpay -c 'cd /var/www/voltpay-backend && pm2 start server.js --name voltpay-api --time --kill-timeout 12000 --max-memory-restart 800M && pm2 save'
pm2 startup systemd -u voltpay --hp /home/voltpay
curl -s http://127.0.0.1:3000/health
```

### 6. Log rotation

```bash
cat > /etc/logrotate.d/voltpay-pm2 <<'EOF'
/home/voltpay/.pm2/logs/*.log {
    su voltpay voltpay
    daily
    rotate 14
    maxsize 20M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
```

### 7. nginx and HTTPS

First, a temporary site that only answers certbot's check, and the certificate:

```bash
install -d -m 755 /var/www/letsencrypt
cat > /etc/nginx/sites-available/voltpay-api <<'EOF'
server {
    listen 80 default_server;
    server_name _;
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
}
EOF
ln -sf /etc/nginx/sites-available/voltpay-api /etc/nginx/sites-enabled/voltpay-api
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
certbot certonly --webroot -w /var/www/letsencrypt -d 162-35-105-36.sslip.io \
  --agree-tos --register-unsafely-without-email --deploy-hook "systemctl reload nginx"
```

Then the shared proxy settings, `/etc/nginx/snippets/voltpay-proxy.conf`:

```nginx
# Proxy settings shared by VoltPay's HTTP and HTTPS server blocks.
proxy_http_version 1.1;
proxy_set_header   Host              $host;
proxy_set_header   X-Real-IP         $remote_addr;
proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header   X-Forwarded-Proto $scheme;
proxy_set_header   Upgrade           $http_upgrade;
proxy_set_header   Connection        $connection_upgrade;

# Airtime-to-Cash step 3 waits up to 90 s for MySubWallet, a USD card create
# up to 60 s; nginx's default of 60 s would cut both off.
proxy_read_timeout 120s;
proxy_send_timeout 120s;
```

And the final site, `/etc/nginx/sites-available/voltpay-api`:

```nginx
# WebSocket upgrade only when the client asks for one (/ws/notifications).
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# Path only, never the query string: the app's WebSocket sends its session
# token as ?token=..., and the default log format would write it to disk.
log_format voltpay '$remote_addr [$time_local] "$request_method $uri $server_protocol" '
                   '$status $body_bytes_sent $request_time "$http_user_agent"';

# Plain HTTP: certificate renewals and the health/ping checks only. Every API
# call goes to HTTPS - a 308 keeps the method and body, so a POST stays a POST.
server {
    listen 80 default_server;
    server_name _;

    access_log /var/log/nginx/voltpay-api.access.log voltpay;
    error_log  /var/log/nginx/voltpay-api.error.log;
    server_tokens off;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location = /health {
        proxy_pass http://127.0.0.1:3000;
        include snippets/voltpay-proxy.conf;
    }

    location = /ping {
        proxy_pass http://127.0.0.1:3000;
        include snippets/voltpay-proxy.conf;
    }

    location / {
        return 308 https://162-35-105-36.sslip.io$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name 162-35-105-36.sslip.io;

    # Let's Encrypt, renewed by certbot.timer; the renewal reloads nginx.
    ssl_certificate     /etc/letsencrypt/live/162-35-105-36.sslip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/162-35-105-36.sslip.io/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:VoltPaySSL:10m;
    ssl_session_timeout 1d;

    access_log /var/log/nginx/voltpay-api.access.log voltpay;
    error_log  /var/log/nginx/voltpay-api.error.log;
    server_tokens off;

    # CAC registration posts up to 16 documents of 5 MB each in one request.
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        include snippets/voltpay-proxy.conf;
    }
}
```

Apply it and test:

```bash
nginx -t && systemctl reload nginx
certbot renew --dry-run
curl -s https://162-35-105-36.sslip.io/health
```

Then work through [Still to do](#still-to-do) again for the new server.

---

## Appendix C — the two helper commands

Both are installed in `/usr/local/bin`, owned by root, mode 755. These are the
versions installed on 14 October 2026.

<details>
<summary><code>/usr/local/bin/voltpay-deploy</code></summary>

```bash
#!/bin/bash
# voltpay-deploy - ship the latest `main` from GitHub to this server.
#
#   voltpay-deploy              pull, reinstall if dependencies changed, restart, check health
#   voltpay-deploy --restart    restart only (after changing .env)
#   voltpay-deploy --rollback   go back to the version that ran before the last deploy
#   voltpay-deploy --reinstall  reinstall dependencies and restart (recovery)
#   --force                     allow a deploy during the StaffPay payday window (25th-29th)
#
# Run as root. Git, npm and PM2 run as the `voltpay` user.
set -euo pipefail

APP=/var/www/voltpay-backend
PREV_FILE=/home/voltpay/.voltpay-previous-deploy
STOPPED=0

as_app() { su - voltpay -c "cd $APP && $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run this as root."; exit 1; }
exec 9>/run/voltpay-deploy.lock
flock -n 9 || { echo "Another deploy is already running."; exit 1; }

MODE=deploy; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --restart)   MODE=restart ;;
    --rollback)  MODE=rollback ;;
    --reinstall) MODE=reinstall ;;
    --force)     FORCE=1 ;;
    -h|--help)   sed -n '2,10p' "$0"; exit 0 ;;
    *)           echo "Unknown option: $arg (see voltpay-deploy --help)"; exit 1 ;;
  esac
done

on_exit() {
  if [ "$STOPPED" -eq 1 ]; then
    echo "!! The deploy stopped partway and the API is probably down."
    echo "   Fix the cause (usually the network), then run: voltpay-deploy --reinstall"
  fi
}
trap on_exit EXIT

health() {
  for _ in $(seq 1 30); do
    if curl -sf -m 5 http://127.0.0.1:3000/health | grep -q '"healthy"'; then
      echo "Healthy: $(curl -s -m 5 http://127.0.0.1:3000/health)"
      return 0
    fi
    sleep 1
  done
  echo "!! The API did not report healthy within 30 seconds. Last log lines:"
  su - voltpay -c "pm2 logs voltpay-api --lines 30 --nostream --raw" 2>&1 | tail -30
  echo "To go back to the previous version: voltpay-deploy --rollback"
  return 1
}

# Stop, reinstall (npm ci also regenerates the Prisma client), start. npm ci
# deletes node_modules first, so the API must not be serving while it runs.
reinstall() {
  echo "Reinstalling dependencies - the API is down for about a minute..."
  STOPPED=1
  as_app "pm2 stop voltpay-api" >/dev/null
  as_app "npm ci --omit=dev --no-audit --no-fund --loglevel=error"
  as_app "pm2 start voltpay-api" >/dev/null
  STOPPED=0
}

# Move the running API from commit $1 to commit $2 (already checked out).
apply() {
  if [ -n "$(as_app "git diff --name-only $1 $2 -- package.json package-lock.json prisma/schema.prisma")" ]; then
    reinstall
  else
    echo "Restarting..."
    as_app "pm2 restart voltpay-api" >/dev/null
  fi
}

case "$MODE" in
  restart)
    echo "Restarting voltpay-api..."
    as_app "pm2 restart voltpay-api" >/dev/null
    health; exit $?
    ;;
  reinstall)
    reinstall
    health; exit $?
    ;;
  rollback)
    [ -s "$PREV_FILE" ] || { echo "No previous deploy is recorded yet."; exit 1; }
    prev=$(cat "$PREV_FILE"); cur=$(as_app "git rev-parse HEAD")
    [ "$prev" != "$cur" ] || { echo "Already on $(as_app "git log --oneline -1")."; exit 0; }
    echo "Rolling back:  $(as_app "git log --oneline -1 $cur")"
    echo "          to:  $(as_app "git log --oneline -1 $prev")"
    as_app "git reset --hard --quiet $prev"
    apply "$cur" "$prev"
    echo "$cur" > "$PREV_FILE"   # a second --rollback returns to where we were
    health; exit $?
    ;;
esac

# --- deploy -----------------------------------------------------------------
day=$(TZ=Africa/Lagos date +%-d)
if [ "$day" -ge 25 ] && [ "$day" -le 29 ] && [ "$FORCE" -eq 0 ]; then
  echo "Today is day $day of the month - the StaffPay payday window (25th-29th)."
  echo "Salaries may be going out right now. If you are sure: voltpay-deploy --force"
  exit 1
fi

as_app "git fetch --quiet origin main"
cur=$(as_app "git rev-parse HEAD")
new=$(as_app "git rev-parse origin/main")
if [ "$cur" = "$new" ]; then
  echo "Already up to date: $(as_app "git log --oneline -1")"
  echo "(Changed .env? Apply it with: voltpay-deploy --restart)"
  exit 0
fi

echo "Deploying:"
as_app "git log --oneline $cur..$new" | sed 's/^/  /'

# Settings this update documents in .env.example that this server lacks.
missing=""
for k in $(as_app "git diff $cur $new -- .env.example" | sed -nE 's/^\+([A-Z][A-Z0-9_]*)=.*/\1/p' | sort -u); do
  grep -q "^$k=" "$APP/.env" || missing="$missing $k"
done

# Database setup scripts this update adds or changes.
ddl=$(as_app "git diff --name-only --diff-filter=AM $cur $new -- 'scripts/apply-*-ddl.js'")

echo "$cur" > "$PREV_FILE"; chown voltpay:voltpay "$PREV_FILE"
as_app "git merge --ff-only --quiet $new"
apply "$cur" "$new"
health || exit 1

if [ -n "$missing" ]; then
  echo
  echo "!! New settings in .env.example that this server does not have:$missing"
  echo "   Add each with: voltpay-env set KEY"
fi
if [ -n "$ddl" ]; then
  echo
  echo "!! This update changes database setup. Run each once - from your laptop or here:"
  for f in $ddl; do
    name=$(grep -oE "\"[^\"]+\": *\"node $f[^\"]*\"" "$APP/package.json" | head -1 | sed -E 's/^"([^"]+)".*/\1/')
    echo "   npm run ${name:-?}    ($f)"
  done
  echo "   On this server: su - voltpay -c 'cd $APP && npm run <name>'"
fi
```

</details>

<details>
<summary><code>/usr/local/bin/voltpay-env</code></summary>

```bash
#!/bin/bash
# voltpay-env - change the API's settings (.env) on this server.
#
#   voltpay-env list              setting names (values are never printed)
#   voltpay-env set KEY           asks for the value (hidden), saves it, restarts the API
#   voltpay-env set KEY VALUE     same, value on the command line (it lands in shell history)
#   voltpay-env unset KEY         removes the setting and restarts the API
#   --no-restart                  save only; apply later with: voltpay-deploy --restart
#   --force                       allow changing PII_ENC_KEY / PII_HASH_KEY (see below)
#
# Run as root. The file stays owned by voltpay with mode 600.
set -euo pipefail
ENV_FILE=/var/www/voltpay-backend/.env

[ "$(id -u)" -eq 0 ] || { echo "Run this as root."; exit 1; }

RESTART=1; FORCE=0; ARGS=()
for a in "$@"; do
  case "$a" in
    --no-restart) RESTART=0 ;;
    --force)      FORCE=1 ;;
    *)            ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]}"
cmd=${1:-}; key=${2:-}

usage() { sed -n '2,11p' "$0"; exit 1; }

check_key() {
  [[ "$1" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "Setting names are UPPER_CASE letters, digits and _ (got '$1')."; exit 1; }
  # These two encrypt and index every user row already in Neon. A new value
  # makes every existing login "user not found" until a full re-index.
  if [[ "$1" == PII_ENC_KEY || "$1" == PII_HASH_KEY ]] && [ "$FORCE" -eq 0 ]; then
    echo "$1 protects every user record already in the database. Changing it locks"
    echo "everyone out until scripts/backfill-pii.js --reindex has run. Add --force only if you mean it."
    exit 1
  fi
}

# dotenv reads an unquoted value only up to a '#', so anything unusual is quoted.
quote() {
  local v=$1
  if [[ "$v" =~ ^[A-Za-z0-9_./:@,+=%-]*$ ]]; then printf '%s' "$v"
  elif [[ "$v" != *"'"* ]]; then printf "'%s'" "$v"
  elif [[ "$v" != *'"'* && "$v" != *'\'* ]]; then printf '"%s"' "$v"
  else echo "That value contains both kinds of quote - edit $ENV_FILE with nano instead." >&2; return 1
  fi
}

# write_env KEY LINE: replace KEY's line with LINE (or delete it when LINE is
# empty), via a temp file swapped in whole so a crash never leaves half a file.
write_env() {
  local tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  K="$1" L="$2" awk '
    BEGIN { k = ENVIRON["K"]; l = ENVIRON["L"]; done = 0 }
    index($0, k "=") == 1 { if (l != "" && !done) { print l; done = 1 }; next }
    { print }
    END { if (l != "" && !done) print l }
  ' "$ENV_FILE" > "$tmp"
  chown voltpay:voltpay "$tmp"; chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

apply_change() {
  if [ "$RESTART" -eq 1 ]; then exec /usr/local/bin/voltpay-deploy --restart; fi
  echo "Saved. Apply it with: voltpay-deploy --restart"
}

case "$cmd" in
  list)
    grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | tr -d '=' | sort | tr '\n' ' ' | fold -s -w 100; echo
    ;;
  set)
    [ -n "$key" ] || usage
    check_key "$key"
    if [ $# -ge 3 ]; then
      val=$3
    elif [ -t 0 ]; then
      read -rsp "Value for $key (hidden): " val; echo
    else
      IFS= read -r val || true
    fi
    [ -n "$val" ] || { echo "Empty value - nothing changed."; exit 1; }
    q=$(quote "$val")
    if grep -q "^$key=" "$ENV_FILE"; then verb=Updated; else verb=Added; fi
    write_env "$key" "$key=$q"
    echo "$verb $key."
    apply_change
    ;;
  unset)
    [ -n "$key" ] || usage
    check_key "$key"
    grep -q "^$key=" "$ENV_FILE" || { echo "$key is not set."; exit 0; }
    write_env "$key" ""
    echo "Removed $key."
    apply_change
    ;;
  *)
    usage
    ;;
esac
```

</details>
