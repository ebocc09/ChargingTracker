# Charging Tracker

A Supercharging dashboard that tracks **USOE** (usable state of energy) for one or more VINs
and watches each vehicle up to a target charge level.

Styled after Tesla.com, with flat 2D vector graphics instead of photography — a Model 3 Highland
front silhouette that changes state as the vehicle charges, with a Supercharger post behind it.

---

## What it does

Enter one or more VINs, press **Monitor**, and each vehicle joins the list:

| State | Car | Supercharger | Meaning |
|---|---|---|---|
| **Awaiting data** | Grey | Hidden | Just added, no baseline reading yet |
| **Charging** | Pulsing amber | Shown, cable plugged in | USOE went up since the last refresh |
| **Charge complete** | Green | Shown, cable unplugged | USOE reached the target level |

A completed vehicle stops being polled, and removes itself from the list automatically
after **2 refresh intervals** — long enough to notice, short enough to keep the board clean.

The bell in the top-right is an audit log. It records state changes only — vehicles added,
charging started, charging finished, vehicles removed, and fetch failures. Incremental
charge-level updates are deliberately *not* logged, because that would just be noise.

---

## Why USOE and not SOC

Garage exposes `SOC` and `USOE` as two separate vitals columns. `USOE` is the usable state of
energy — the customer-facing number shown on the vehicle display. This dashboard reads `USOE`
exclusively; `SOC` is never queried.

---

## Requirements

- **Node.js 18+** (portable install is fine — no admin rights needed, see below)
- **Tesla network or VPN access**, and a Garage account with Standard Read Access

Zero npm dependencies. Nothing to `npm install`.

### Node without admin rights

If you can't run installers, use the portable build:

```bash
curl -sSL -o node.zip https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip
powershell -Command "Expand-Archive node.zip -DestinationPath \"$HOME\nodejs\" -Force"
```

Then add `%USERPROFILE%\nodejs\node-v24.18.0-win-x64` to your **user** PATH
(Settings → *Edit environment variables for your account*). No elevation required.

macOS / Linux: `brew install node` or your distro's package manager.

---

## Running it

**Windows — just double-click `start-dashboard.bat`.** It finds Node (on PATH, or the portable
install under `%USERPROFILE%\nodejs`), starts the server and opens your browser.

Or from a terminal:

```bash
git clone <your-repo-url> charging-tracker
cd charging-tracker
node server.js
```

> **The dashboard only runs while that window is open.** It's a local server, not a background
> service — close the window or press Ctrl+C and it stops. Anyone using it needs it running on
> *their own* machine; you can't leave it running for other people.

Your browser opens automatically. The first run sends you to Bouncer to sign in; after that the
token is cached and refreshed silently. Then just go to:

```
http://localhost:3118
```

**Everyone who clones this runs their own copy and signs in as themselves.** There are no shared
credentials, and no one needs to leave a machine running for anyone else. You see exactly the
vehicles your own Garage permissions allow.

---

## Admin menu

Behind the **Admin** button, gated by a 6-digit code entered in a 2FA-style bubble input
(auto-advance, backspace, paste, auto-submit). Default code is `226565` — change it by editing
`ADMIN_PASSWORD` near the top of the `<script>` block in `index.html`.

> The replacement **must be exactly 6 digits**, or the bubble input can't produce it.

| Setting | Default | Notes |
|---|---|---|
| Target charge level | `80.0%` | Any value 1–100, to one decimal. Presets for 70/80/90/100. |
| Refresh interval | `5 minutes` | Minimum 5 seconds. Presets for 20s / 1m / 5m / 15m. |
| Request throttle | `4` / `150 ms` | Simultaneous requests, and the minimum gap between request starts |
| Auto-clear completed | On | Off keeps finished vehicles in a collapsible group instead |
| Main geofence TRT | `17589` | Vehicles elsewhere are tagged **Offsite** |
| Data source | Live | Live Garage, or Simulation for demos |
| Live vitals | Off | Real-time reads via a Garage session cookie — see below |
| Teams alert webhook | — | Power Automate flow URL for charge-complete cards |
| Clear notifications | — | Empties the audit log |
| Remove all vehicles | — | Clears the monitoring list |

Admin stays unlocked for the browser session; **Lock admin** ends it immediately.

> The password is a client-side convenience gate to stop casual fiddling with the settings.
> It is not a security boundary — the real access control is your Garage OAuth token, which is
> enforced server-side and scoped to your own permissions.

---

## How the Garage connection works

Garage's MCP endpoint answers a CORS preflight without an `Access-Control-Allow-Origin` header,
so a browser page can never call it directly. `server.js` makes the call server-side instead.

Auth is the standard MCP OAuth flow, performed entirely by your local process:

```
1. GET  garage/.well-known/oauth-protected-resource   → discover Bouncer
2. GET  bouncer/.well-known/oauth-authorization-server → discover endpoints
3. POST bouncer/oauth/register                         → dynamic client registration
4. GET  bouncer/oauth/authorize                        → auth code + PKCE (S256)
5. GET  localhost:3118/callback                        → receive the code
6. POST bouncer/oauth/token                            → access + refresh token
7. POST garage/mcp                                     → JSON-RPC tools/call
```

Scope is `garage:mcp offline_access`. Tokens land in `.tokens.json` and the registered client in
`.client.json` — both are gitignored, written `0600`, and refused by the static file handler.
No secret is ever committed.

The actual data call is the `device_historical_vitals` MCP tool:

```json
{ "device_id": "<VIN>", "fields": ["USOE"], "hours": 6, "asc": false }
```

It reads cached Datatank snapshots, so **the vehicle does not need to be online** — you get the
most recent reading within the lookback window.

Two quirks of the real response, both handled in `extractUsoe()`:

- Rows come back **oldest-first even when `asc: false` is requested**, so the newest reading is
  selected by timestamp rather than by position.
- Timestamps are **naive UTC** (`"2026-07-29T03:20:30"`, no offset). The dashboard appends `Z`
  before parsing, otherwise they'd be read as local time and land in the future.

Snapshots are event-driven (`was_charging`, `drive_ended`, `wakeup`, `going_to_sleep`) rather than
on a fixed cadence, so each row shows **when the vehicle reported**, not when you polled. During an
active Supercharging session `was_charging` snapshots arrive frequently enough to drive the display.

### Configuration

Environment variables, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3118` | Dashboard + OAuth callback port |
| `GARAGE_URL` | `https://garage.vn.teslamotors.com` | Which Garage instance to query |
| `LOOKBACK_HOURS` | `6` | How far back to search for a USOE snapshot |
| `CACHE_TTL_MS` | `10000` | Minimum gap between Garage calls for the same VIN |
| `MAX_CONCURRENT` | `4` | Hard ceiling on concurrent Garage calls |
| `TEAMS_WEBHOOK_URL` | *(unset)* | Power Automate flow URL for Teams alerts |
| `TEAMS_DEDUPE_MS` | `7200000` | Window in which a repeat alert for a VIN is suppressed |

Other regions:

```bash
GARAGE_URL=https://garage-europe.vn.teslamotors.com node server.js   # Europe
GARAGE_URL=https://garage.vn.tesla.cn              node server.js   # China
```

Changing `PORT` re-registers the OAuth client, since the redirect URI changes.
Delete `.client.json` if you want to force a clean re-registration.

---

## Geofence tags

Each vehicle is checked against the **Main geofence TRT** set in the admin menu (default `17589`,
Houston&nbsp;-&nbsp;Cypress). Anything at a different TRT — or in no facility geofence at all —
gets a light-purple **Offsite** pill next to its status badge. Hover it for the facility name and
TRT. Vehicles at the main site get no tag.

Read from Tesladex `trt_id` / `tesla_facility`, not from vitals: `GUI_trtId` exists as a vitals
column but is empty on customer cars, whereas Tesladex carries a populated facility block.

Lookups are **batched** — Tesladex accepts `vin:(A OR B OR C)`, so a 100-VIN list costs two
queries per sweep rather than a hundred, and results are cached for 5 minutes (`GEO_TTL_MS`).
A geofence failure is swallowed rather than allowed to disrupt charge monitoring.

## Completed vehicles

Controlled by **Auto-clear when finished** in the admin menu:

- **On** (default) — a finished vehicle drops off the list after 2 refresh intervals, exactly as
  before. Its footer counts down.
- **Off** — finished vehicles collect in a collapsible **Fully charged** group pinned to the
  bottom, showing a count and a **Clear all** action. Their footer reads *Ready to move* and they
  stay until you clear them.

Either way, a completed vehicle stops being polled the moment it reaches the target.

## Running 100+ VINs

A large list must not fire one request per VIN simultaneously. Two independent limits prevent that.

**In the browser** — a sweep runs at most `concurrency` requests in flight, and a global rate gate
starts no more than one request per `spacingMs`. At the defaults (4 / 150 ms) that's a ~6–7 req/s
ceiling, so 100 VINs are dispatched over ~15 seconds instead of all at once. The admin menu shows
a live estimate for your current list size, and warns in red if a sweep can't finish inside the
refresh interval.

**In the proxy** — `MAX_CONCURRENT` (default 4) is a hard ceiling regardless of what the browser
asks for, so several open tabs still can't fan out. Concurrent requests for the same VIN collapse
into a single Garage call.

If a sweep overruns the interval, the next tick is skipped rather than piling up, and the audit log
records it once. At 100 VINs, **keep the interval at 5 minutes** — that's ~20 req/min. Dropping to
60s would be ~100 req/min for data that, per the note above, mostly won't have changed.

> **Live vital pulls are deliberately not used.** In the snapshot data, every `vital_pull` row is
> preceded by a `wakeup` 10 seconds earlier — a live read *wakes the vehicle*. Across 100+ cars on
> a polling loop that would keep an entire fleet from sleeping. `device_historical_vitals` is a
> pure read of cached data with zero vehicle impact, which is why it's the only source used here.

## Live vitals

**Off by default.** Everything reads Garage's cached snapshots, which is how the dashboard has
always worked and needs nothing beyond your Bouncer sign-in.

### Why you might want it on

Vehicles report vitals on their own state changes — `wakeup`, `going_to_sleep`, `drive_ended`,
`was_charging` — not on a schedule. Measured cadence:

| Vehicle state | Gap between readings |
|---|---|
| Actively charging | **8–12 minutes** |
| Parked | 10 minutes to over an hour |

So a completion card on cached data typically lands 10–15 minutes after the car actually crossed
its limit. Polling faster doesn't help: the number isn't there yet.

Live read fixes that. Garage's web UI reads current vitals from
`GET /vehicles/<numeric id>/vitals`, and with a session cookie this dashboard can call the same
endpoint. Readings come back stamped to the millisecond of the request.

### Turning it on

1. Sign into Garage in a browser
2. **F12 → Network**, click any request, find **Request Headers**
3. Copy the *entire* `Cookie:` value — not one cookie from the Application tab
4. Admin → **Live vitals** → paste → **Save cookie** → **Test** → **Enable live read**

### What to know before you do

- **It's your full Garage identity.** Anyone holding that cookie can act as you in Garage until it
  expires. Stored in `.garage.json` on your machine, never sent back to the page, never committed.
- **It expires** on Garage's own schedule — hours to days. When it does, live read switches itself
  off, says why, and everything falls back to cached. Paste a fresh one to resume.
- **Each person uses their own.** Never share a `.garage.json`.
- **~140 KB per vehicle per read.** The endpoint returns the entire vitals dump — around 4,475
  fields — to obtain two numbers. A 100-vehicle sweep moves roughly 14 MB. Fine for the short
  lists this is normally pointed at; worth knowing before loading it up.
- **Every failure falls back to cached.** Live read is an accelerator, never a dependency. Turn it
  off and the dashboard behaves exactly as it did before.

---

## Microsoft Teams alerts

When a vehicle reaches its target level, the proxy can post a card to a Teams channel:

```
⚡ Charging complete
   Charging Tracker | Powered by Zo' Projects

   5YJ3E1EA9TF146618

   SOC     80.4%
   Target  80.0%
```

This works over a Power Automate SAS URL. There is no UI to configure it — set the URL in
`.teams.json` or via the `TEAMS_WEBHOOK_URL` environment variable.

> ### ⚠ If you get `401 DirectApiInvalidAuthorizationScheme`
>
> **Check that the URL still has its `sig` parameter before assuming anything about tenant
> policy.** A flow URL looks like this, and every part after the `?` matters:
>
> ```
> …/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=<signature>
> ```
>
> `sig` is the entire credential. A URL truncated at the first `&` keeps the path and
> `api-version` and loses the signature, so the request arrives with no credential — and Power
> Automate reports that as an *invalid authorization scheme*, which reads like the scheme is
> blocked rather than absent. This cost a long detour once; the error message is genuinely
> misleading.
>
> Truncation at `&` is what shells do to an unquoted URL. Always quote it.
>
> Verify with:
>
> ```
> node -e "console.log(/[?&]sig=/.test(require('./.teams.json').url))"
> ```

**Other delivery paths**, for reference if the flow URL is ever unavailable:

| Path | Result |
|---|---|
| Power Automate SAS URL | **Works.** The normal path. |
| Outlook COM → email-triggered flow | **Works.** Implemented as `ALERT_TRANSPORT=outlook`; see below. |
| O365 incoming webhook | Retired by Microsoft |
| SMTP relay | `smtp`/`mail.teslamotors.com` blackhole every port (25 / 587 / 465) |
| Teams channel email address | Disabled by tenant policy — no **Get email address** in the channel menu |
| OneDrive file-drop | Not viable: the machine has only a personal OneDrive, no work account |
| Entra ID bearer token | Untested. Would need an app registration, and is unnecessary while SAS works. |

### Outlook fallback transport

`ALERT_TRANSPORT=outlook` sends the alert as an email from the local Outlook client over COM,
for a flow triggered by **When a new email arrives (V3)** with a subject filter on
`[CHARGING-TRACKER]`. The body carries a JSON block between `--CT-JSON--` and `--CT-END--` so
the flow can parse exact values rather than scraping the subject.

This exists because it needs no credential of its own — Outlook already holds an authenticated
Exchange session, which also routes around the SMTP blackhole. It is a fallback, not the
default. Note that Outlook's programmatic-access guard can block `.Send()` depending on Group
Policy and antivirus state; the error is reported explicitly if so.

### How it behaves

- The URL is stored in `.teams.json` (gitignored, `0600`, refused by the static handler) and is
  never echoed back to the page — the admin menu shows only the host.
- The POST is made **server-side**. The URL carries a signature that shouldn't sit in client-side
  JavaScript, and Power Automate returns no CORS headers, so a browser `fetch()` would be blocked.
- Alerts are **fire-and-forget**. A Teams outage can't stall or break a monitoring sweep; the
  failure is recorded in the audit log instead.
- Repeat alerts for the same VIN are suppressed for 2 hours (`TEAMS_DEDUPE_MS`), so a page refresh
  or a re-added vehicle won't post twice.
- The payload includes both an Adaptive Card and flat `event` / `vin` / `usoe` / `limit` fields, so
  a hand-built flow can read the values directly instead of parsing the card.

> **Caveat for multi-user setups.** Dedupe is per machine. If five people each run their own copy
> monitoring the same VIN, the channel gets five messages. For a shared alerting channel, run
> **one** instance as the alerter — and have everyone else leave the webhook field blank.

## Simulation mode

Switch **Data source** to *Simulation* in the admin menu to run without Garage. USOE values
follow a tapering Supercharger curve — quick to 50%, slowing hard past 80% — so state
transitions and the auto-removal behaviour can be demonstrated on any machine, on or off VPN.

Opening `index.html` directly from disk (`file://`) also defaults to simulation, since there's
no proxy on the other end.

---

## HTTP API

`server.js` exposes a small surface, useful if you want to script against it:

| Endpoint | Returns |
|---|---|
| `GET /api/usoe?vin=<VIN>` | `{"vin":"…","usoe":85.06,"readingAt":"2026-07-29T03:20:30","samples":9,"source":"garage:USOE","ts":…}` |
| `GET /api/auth/status` | `{"authenticated":true,"garage":"…","loginUrl":"…"}` |
| `GET /auth/login` | Redirects into the Bouncer sign-in flow |
| `GET /auth/logout` | Discards the cached token |
| `GET /api/teams` | `{"configured":true,"preview":"https://host/…","fromEnv":false}` |
| `POST /api/teams` | Set the webhook — `{"url":"https://…"}`, or `""` to clear |
| `POST /api/teams/test` | Sends a test card to the channel |
| `POST /api/notify` | `{"event":"charge_complete","vin":"…","usoe":80.4,"limit":80.0}` |

`/api/usoe` returns `401` with `{"needsAuth":true}` when the token is missing or expired, and
`502` with an `error` string when Garage rejects the query.

---

## Files

```
index.html           Entire dashboard — markup, styles, SVG graphics, logic. No build step.
server.js            Local Garage proxy: OAuth, MCP client, static file serving. No dependencies.
start-dashboard.bat  Windows launcher — double-click to run.
package.json         Metadata and `npm start`.
.gitignore           Keeps the credential files out of the repo.
```

### Sharing this with someone

Send **only** these six files: `index.html`, `server.js`, `start-dashboard.bat`, `package.json`,
`README.md`, `.gitignore`.

> ⚠️ **Do not zip the whole folder.** It also contains `.tokens.json`, `.client.json`,
> `.teams.json` and `.garage.json` — your Garage OAuth token, your Teams webhook, and a live
> Garage **session cookie** that is your full identity. `.gitignore` excludes them from *git*, but
> not from a right-click → *Send to* → *Compressed folder*. Pushing to git is safe; zipping the
> directory is not.

The recipient needs no key or file from you. On first run their copy registers its own OAuth
client and they sign into Bouncer as themselves, with their own Garage permissions.

State (monitored VINs, settings, audit log) lives in browser `localStorage`, so it survives a
refresh and stays local to each user.

---

## Troubleshooting

**"No USOE snapshot in the last 6h"** — Datatank has no recent snapshot for that VIN. Raise the
window with `LOOKBACK_HOURS=24`.

**"Garage MCP returned HTTP 403"** — your account lacks Standard Read Access for that vehicle.

**Sign-in page won't load** — you're off the Tesla network. Connect to VPN and retry.

**Stuck auth after a failed login** — delete `.tokens.json` and `.client.json`, then restart.

**Port already in use** — `PORT=3200 node server.js`.
