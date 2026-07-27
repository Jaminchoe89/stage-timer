# Stage Timer App

Web app for running speaker stage timers with:

- `/` — the **lobby**: create rooms and load saved shows
- `/dashboard` and `/stage` — the operator controls and full-screen display for
  the **default** timer (the room called `main`)
- `/r/<id>/dashboard` and `/r/<id>/stage` — controls and display for any other room

## Run

```bash
npm start
```

Then open `http://localhost:3000/` for the lobby, or `http://localhost:3000/dashboard`
to go straight to the default timer.

## Rooms

Each **room** is an independent timer with its own queue, clock, timezone and
messages. Two events (or two stages at one event) can run at the same time
without sharing a clock.

- Create a room from the lobby. It gets an unguessable id, e.g. `/r/q9z8vvg/`.
- **The room link is the key.** Anyone with a room's link can control it — there
  is no separate password — so hand the `/r/<id>/stage` link to the venue display
  and keep the `/r/<id>/dashboard` link for the operator.
- The default room (`main`) is reached by the bare `/dashboard` and `/stage`, so
  older links keep working. Because its URL is public, it keeps the passcode
  (see below) while other rooms rely on their id.
- Rooms nobody has touched for 30 days are pruned on boot; `main` is never pruned.

## Shows

A **show** is a saved agenda template — the room's queue, session label, warning
thresholds, timezone and clock format, minus the live clock. Build "Investment
Summit" once, then reload it or spin up a fresh room from it per event.

- Save the current room's agenda from the dashboard's **Shows** panel.
- Load a show into a room (replaces its agenda and stops the clock), or create a
  new room pre-loaded from a show in the lobby.
- Saving and deleting shows requires the passcode; listing and loading them does
  not, so a room operator can load a template you prepared.

## Stage clock timezone

The "Current Time" clock on the stage display renders in the timezone chosen in
the dashboard's **Stage Clock** panel — *not* the timezone of the device showing
the page. Venue PCs, hire laptops and iPads are routinely set to the wrong
country, so this is set once by the operator and every display follows it.

On first use the dashboard adopts the operator's own detected timezone. Change
it from the dropdown when you travel; it is saved with the rest of the state.

## Reliability notes

The display is built to survive a bad venue network and an unhealthy server:

- **The stage display ticks locally.** The server sends the time remaining as of
  now; each client advances it against its own monotonic clock. A dropped
  connection no longer freezes the countdown, and a small amber dot appears in
  the corner of the stage while the stream is down.
- **Timing never uses the wall clock.** Elapsed time is measured with a
  monotonic clock, so an NTP correction or a timezone change cannot make a
  running timer jump or stall.
- **State survives a restart.** Each room is written to `DATA_DIR/rooms/<id>.json`
  and shows to `DATA_DIR/shows.json`. On boot, a timer that was running is advanced
  by the downtime (up to 5 minutes) so it stays honest; longer gaps restore paused.
  A pre-rooms `state.json` is migrated into the `main` room on first boot.
- **Nothing is loaded from the internet.** Inter and the motion library are
  self-hosted under `public/fonts` and `public/vendor`, so the stage renders
  identically with no connectivity at all.
- **The server does not exit on bad input.** Malformed requests, dead client
  sockets and unexpected exceptions are logged, not fatal.
- **The stage display requests a screen Wake Lock** so it does not dim mid-session.

The `+`/`-` buttons adjust only the time left on the clock. The session's planned
duration is what **Reset** returns to, and what the Duration card reports.

## Configuration

| Env var            | Default   | Purpose                                                      |
|--------------------|-----------|--------------------------------------------------------------|
| `PORT`             | `3000`    | Listen port                                                   |
| `HOST`             | `0.0.0.0` | Listen address                                                |
| `DATA_DIR`         | `./.data` | Where room and show files are written                         |
| `CONTROL_PASSCODE` | *(unset)* | When set, gates room creation, the `main` room, and show edits |

When `CONTROL_PASSCODE` is set it protects **creating/listing/deleting rooms,
controlling the default `main` room, and saving/deleting shows**. Controlling a
non-default room needs only its link. All displays (`/stage`) stay open.

`GET /healthz` returns process uptime, room count, and connected display count.

## Deployment

**Live:** https://stagetimer.gamemakers.co — use this at events.

Also reachable on Railway's own URL,
https://stage-timer-production-09bb.up.railway.app.

Project `stage-timer`, service `stage-timer`, 5 GB volume mounted at `/data`
with `DATA_DIR=/data`, so state survives redeploys as well as crashes.

### Custom domain

`stagetimer.gamemakers.co` is a CNAME to `pgc0hxjo.up.railway.app` in the
Cloudflare zone for `gamemakers.co`, with a `_railway-verify.stagetimer` TXT
record for ownership. Railway issues and renews the Let's Encrypt certificate.

Keep the CNAME **DNS only (grey cloud)**. Proxying it through Cloudflare puts an
extra hop in front of the long-lived SSE stream that the displays depend on, and
interferes with Railway's certificate renewal.

The service deploys from GitHub: pushing to `main` on
[`Jaminchoe89/stage-timer`](https://github.com/Jaminchoe89/stage-timer) builds
and releases automatically. `railway up` still works for an out-of-band deploy
from your working copy, but prefer a push so the live build always matches a
commit.

Never push to `main` during a live session — a deploy restarts the container.
State is on the volume so a running timer is advanced by the downtime and
survives, but the display briefly loses its stream.

This app **must** run on a persistent container, not on serverless. Its whole
design is a single shared in-memory state pushed to displays over long-lived
SSE connections. On a serverless host each request can land on a different
instance, so a dashboard action never reaches the stage's open stream, and cold
starts reset the timer mid-event.

> ⚠️ The old Vercel deployment (`stage-timer-pied.vercel.app`) is still live and
> still auto-deploys from this repo, so it serves current code on an
> architecture that cannot run it correctly. **Use the Railway URL at events.**

`CONTROL_PASSCODE` is set on the Railway service, so creating rooms and driving
the default timer require it (the dashboard prompts once per device and remembers
it). Change it with:

```bash
railway variable set CONTROL_PASSCODE=<passcode>
```

`/stage` and non-default room links stay open, so displays need no credentials.
