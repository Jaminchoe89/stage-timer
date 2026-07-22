# Stage Timer App

Simple web app for running a speaker stage timer with:

- `/dashboard` for the operator controls
- `/stage` for the full-screen speaker display

## Run

```bash
npm start
```

Then open `http://localhost:3000/dashboard`.

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
- **State survives a restart.** Everything except transient alerts is written to
  `DATA_DIR/state.json`. On boot, a timer that was running is advanced by the
  downtime (up to 5 minutes) so it stays honest; longer gaps restore paused.
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
| `DATA_DIR`         | `./.data` | Where `state.json` is written                                 |
| `CONTROL_PASSCODE` | *(unset)* | When set, `POST /api/state` requires it; `/stage` stays open   |

`GET /healthz` returns process uptime and the connected display count.

### Deploying on Railway

- The app is reachable by anyone with the URL. Set `CONTROL_PASSCODE` so only
  the operator can drive the stage — the dashboard prompts once and remembers it.
  `/stage` stays open so displays need no credentials.
- Container disks are wiped on redeploy. Mount a Railway **Volume** and point
  `DATA_DIR` at it if you want the queue to survive a deploy as well as a crash.
