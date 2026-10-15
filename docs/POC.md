# Church League Scoreboard: POC features

Status key: ✅ built in the POC · 🟡 partial · ⏭ next step (documented, not built)

Everything runs in the cloud: one app container plus managed Postgres. There is no court box at the gym. The gym needs only a TV device with a browser and the scorekeeper's phone or tablet, both on Wi-Fi or a hotspot.

## 1. Score: the bench scorekeeper controller (`/score/<court>`)

Big buttons, mobile-first: a single column on phones, and team | clock | team on tablets (≥900 px), following `scorekeeper-controller-mockup.png`.

| Feature | Status | Notes |
|---|---|---|
| Unlock with a per-court PIN | ✅ | The PIN is remembered on the device (localStorage). A wrong PIN shows the gate again. |
| Game clock start/stop | ✅ | One large toggle (green ▶ START / red ■ STOP). |
| Clock adjust ±1 s, "Set clock… mm:ss" | ✅ | Clamped to 0..period length. |
| Clock auto-stops at 0:00 | ✅ | A server timer fires `CLOCK_EXPIRE`. |
| Last minute shows tenths (`42.3`) | ✅ | |
| Periods prev/next (with overtime) | ✅ | Next period resets the clock to the period length. Team fouls reset per rule (`half` by default). |
| Points +1/+2/+3 per team | ✅ | |
| Corrections: −1 point | ✅ | The score never goes below 0. |
| Team fouls +/− with bonus indicator | ✅ | Bonus is on when the opponent reaches `bonusFouls` (default 7). |
| Timeouts (remaining count) | ✅ | Using a timeout stops the clock. |
| Possession arrow toggle | ✅ | |
| Undo / redo history | ✅ | 100 steps. Undoing a score or foul does **not** rewind a running clock. The button shows "last: Home +2". |
| "Halftime" banner, End game & save | ✅ | End game freezes the clock, marks the game final, and saves the final score to the schedule. |
| Connection pill, "TV connected", "2 scorekeepers" warning | ✅ | Based on server presence. |
| Taps made during a network blip are queued and re-sent with the same id | 🟡 | The queue lives in memory and is lost if the page is closed. The server dedupes by id. |
| Haptic tick on tap, screen wake lock | ✅ | Where the browser supports it. |
| Horn sound | ⏭ | |
| Offline PWA / IndexedDB queue | ⏭ | |
| Player fouls, shot clock | ⏭ | |

## 2. Display: TV scoreboard + streaming (`/tv/<court>`, `/overlay/<court>`)

**TV layout** (follows `tv-scoreboard-mockup.png`, 16:9, scales to any resolution):
league name and court/division header; per team a color bar, logo (or initial badge), name in the team's accent color, huge score, fouls, timeout dots and a BONUS tag; center red LED-style clock, period (OT1, OT2…), possession arrow; bottom "UP NEXT" ticker from the court's schedule; HALFTIME/FINAL banner; a "Waiting for the next game" screen when nothing is on court.

**Live sync**: WebSocket. Every accepted change pushes the full authoritative state to every screen on that court, typically in under 50 ms on the box.

**Reconnect behavior**:
- The display reconnects automatically with exponential backoff (0.5 s up to 8 s). A small dot in the bottom-right corner turns red and blinks while offline.
- On every (re)connect the server sends a full snapshot, so the TV shows the exact current state, including changes made while it was offline.
- When the tab becomes visible again (TV stick waking up), it asks for a resync.
- The clock is computed from the server's `startedAt` timestamp plus a measured client/server clock offset (from ping round-trips). A TV that was offline for 30 s shows the right time immediately, with no drift from counting ticks.

**Streaming options** (the POC builds only the overlay page):

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. OBS browser-source overlay** ✅ (page built) | OBS on a laptop: camera + Browser Source `https://<host>/overlay/court-1` at 1920×1080. The page background is transparent. | Pro look, live scorebug synced to the controller, no extra cost, the same laptop can also drive the TV over HDMI. | Needs a laptop and someone comfortable with OBS. Upload bandwidth at the gym. |
| **B. YouTube / Facebook Live via OBS** ⏭ | Option A plus OBS "Start Streaming" with a YouTube/Facebook stream key. | Families watch from home, recordings are kept. | YouTube needs channel verification/eligibility for live streaming. Minors on camera need a church consent/privacy policy. Music copyright strikes during warm-ups. |
| **C. Phone-camera path** ⏭ | A phone on a tripod streams with the YouTube app (no overlay), or with an RTMP app that supports a web-page overlay (e.g., Larix/Streamlabs-type apps), or the phone feeds OBS over NDI/OBS Camera. | Cheapest: no laptop. | Overlay support varies by app. Battery/heat. Quality depends on cellular/Wi-Fi uplink. |
| D. Just a parents' live score link | Share `/tv/court-1` (read-only) or a future mobile "live scores" page with a QR code. | Zero video complexity. | No video. |

Recommendation: pilot with **A on the TV only**. Add B once a volunteer owns OBS and the consent policy is settled.

## 3. Admin (`/admin`)

| Feature | Status | Notes |
|---|---|---|
| Login (admin password from env) | ✅ | HttpOnly cookie, 12 h session. |
| Today view: courts with the live game, links to TV/Score/Overlay, Start/Re-show a game on its court | ✅ | Starting a game switches the court's TV and controller instantly. |
| Teams: name, short name, primary + accent colors, logo by URL **or** upload | ✅ | Uploads (≤1 MB png/jpg/gif/webp/svg) are stored in Postgres (`bytea`) and served from `/logos/:id`. |
| Courts: add/delete, PIN status | ✅ | PINs come from the `COURT_PINS` env. |
| Schedule: add games (court, time, division, home/away), delete | ✅ | |
| Per-matchup overrides: display names and colors (alternate jerseys) | ✅ | Stored in `games.theme`. Logo override is supported by the API, not the form. |
| CSV import/export for teams and schedule in Google-Sheets-friendly columns | ✅ | Teams upsert by name. Schedule import reports bad rows. Export includes scores and status. Formula-injection safe. |
| Game event log (`GET /api/games/:id/events`) | ✅ (API) | Audit of every change, with actor. |
| Real Google Sheets sync | ⏭ | Use the Sheets API v4 with a service account shared on the league sheet. "Pull schedule" reads `Schedule!A:F` (`spreadsheets.values.get`) through the same import code. "Push results" writes scores back (`values.update`). Optional nightly cron. |
| Users & roles | 🟡 | POC: **admin** = password, **scorekeeper** = per-court PIN, **public viewer** = TV/overlay with no login (read-only, enforced server-side). Next: a `users` table with Google sign-in (OIDC) for admins, and PINs/QR codes generated per game day from the admin UI instead of env. |
| Seasons, divisions, standings | ⏭ | |
