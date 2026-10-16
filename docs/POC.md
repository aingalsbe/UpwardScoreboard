# UpwardScoreboard: POC features

Status key: ✅ built in the POC · 🟡 partial · ⏭ next step (documented, not built)

Everything runs in the cloud: one app container plus managed Postgres. There is no court box at the gym. The gym needs only a TV device with a browser and the scorekeeper's phone or tablet, both on Wi-Fi or a hotspot.

## 1. Score: the bench scorekeeper controller (`/score/<court>`)

Big buttons, mobile-first: a single column on phones, and team | clock | team on tablets (≥900 px), following `scorekeeper-controller-mockup.png`.

| Feature | Status | Notes |
|---|---|---|
| Unlock with a per-court PIN | ✅ | A correct PIN gives the device a 12 h session for that court (localStorage); reconnects/reloads skip the PIN. Wrong PINs are limited per court + device, with a countdown after 5. Unsent taps survive closing the page and are resent; closing with unsent taps asks first. |
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

**Live sync**: WebSocket. Every accepted change pushes the full authoritative state to every screen on that court. Measured on the box: median 6.3 ms, p95 9.4 ms tap-to-TV.

**Online indicator**: Online = a server message within the last 3 s (1 s app ping). Silent drops show Offline within about 3–4 s; Wi-Fi off shows it immediately. While offline the clock freezes (dimmed) and never counts down past a stop. The overlay shows team short names.

**Reconnect behavior**:
- The display reconnects automatically with exponential backoff (0.5 s up to 8 s). A small dot in the bottom-right corner turns red and blinks while offline.
- On every (re)connect the server sends a full snapshot, so the TV shows the exact current state, including changes made while it was offline.
- When the tab becomes visible again (TV stick waking up), it asks for a resync.
- The clock is computed from the server's `startedAt` timestamp plus a measured client/server clock offset (from ping round-trips). A TV that was offline for 30 s shows the right time immediately, with no drift from counting ticks.

**Streaming options** (the POC builds only the overlay page):

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. OBS browser-source overlay** ✅ (page built) | OBS on a laptop: camera + Browser Source `https://<host>/upwardbasketballscores/westcourt/overlay` at 1920×1080. The page background is transparent. | Pro look, live scorebug synced to the controller, no extra cost, the same laptop can also drive the TV over HDMI. | Needs a laptop and someone comfortable with OBS. Upload bandwidth at the gym. |
| **B. YouTube / Facebook Live via OBS** ⏭ | Option A plus OBS "Start Streaming" with a YouTube/Facebook stream key. | Families watch from home, recordings are kept. | YouTube needs channel verification/eligibility for live streaming. Minors on camera need a church consent/privacy policy. Music copyright strikes during warm-ups. |
| **C. Phone-camera path** ⏭ | A phone on a tripod streams with the YouTube app (no overlay), or with an RTMP app that supports a web-page overlay (e.g., Larix/Streamlabs-type apps), or the phone feeds OBS over NDI/OBS Camera. | Cheapest: no laptop. | Overlay support varies by app. Battery/heat. Quality depends on cellular/Wi-Fi uplink. |
| D. Just a parents' live score link | Share `/upwardbasketballscores/westcourt` (read-only) or a future mobile "live scores" page with a QR code. | Zero video complexity. | No video. |

Recommendation: pilot with **A on the TV only**. Add B once a volunteer owns OBS and the consent policy is settled.

## 3. Admin (`/admin`)

| Feature | Status | Notes |
|---|---|---|
| Login (admin password from env) | ✅ | HttpOnly cookie, 12 h session. |
| Today view: courts with the live game, links to TV/Score/Overlay, Start/Re-show a game on its court | ✅ | Starting a game switches the court's TV and controller instantly. |
| Teams: name, short name, primary + accent colors, logo by URL **or** upload | ✅ | Colors must be `#RRGGBB` (empty → default). Uploads ≤1 MB, PNG/JPEG/GIF/WebP verified by magic bytes; SVG rejected; oversize → 413 with a message (QA #4, #10). URLs must be http(s). Deleting a team that has games → friendly 409 (QA #9). Contrast: Sage's `public/contrast.js` keeps each text/color pair ≥ 4.5:1 and warns in Admin. |
| Courts: add/delete, PIN status | ✅ | PINs come from the `COURT_PINS` env. |
| Schedule: add games (court, time, division, home/away), delete | ✅ | |
| Per-matchup overrides: display names and colors (alternate jerseys) | ✅ | Stored in `games.theme`. Logo override is supported by the API, not the form. |
| CSV import/export for teams, courts and schedule in Google-Sheets-friendly columns | ✅ | **Idempotent (QA #2):** re-importing never duplicates; returns created/updated/skipped. Schedule matches by exported `id`, else court + start time + home + away (unique index); in-file duplicates are skipped. Explicit errors (QA #8): missing required column → 400; bad color, non-http logo URL, bad date/time, **unknown court slug** (no longer auto-created), unknown team → row errors. **Keep the `id` column when editing an exported sheet** (that's how moved games update instead of duplicating). Undated games (empty date+time, optional empty court) import and round-trip (QA r2-B). The export carries final scores, and current scores for live games. |
| League time zone | ✅ | `TZ` (default `America/Chicago`, Kansas City area). Used for CSV times, the "up next" ticker and admin display, regardless of the viewer's device time zone. |
| Game event log (`GET /api/games/:id/events`) | ✅ (API) | Audit of every change, with actor. |
| Real Google Sheets sync | ⏭ | Use the Sheets API v4 with a service account shared on the league sheet. "Pull schedule" reads `Schedule!A:F` (`spreadsheets.values.get`) through the same import code. "Push results" writes scores back (`values.update`). Optional nightly cron. |
| Users & roles | 🟡 | POC: **admin** = password, **scorekeeper** = per-court PIN, **public viewer** = TV/overlay with no login (read-only, enforced server-side). Next: a `users` table with Google sign-in (OIDC) for admins, and PINs/QR codes generated per game day from the admin UI instead of env. |
| Seasons, divisions, standings | ⏭ | |

## Update (courts, shared floor, season colors, grades, QR scorekeeping flow)

Courts are now full, west and east (Full shares the floor with West and East; GAME_MINUTES default 60 with a per-game override). Statuses are scheduled/active/complete with one active game per court. Scorekeepers sign in with a weekly signed court QR (PIN fallback) and pick today's game. TV links: /upwardbasketballscores/{fullcourt,westcourt,eastcourt} and /overlay variants, plus /tv/split. Season colors (Maroon #800000 / Gold #FFC72C) replace team colors; teams have grades. Full details: deliverables/UpwardScoreboard-POC.md section 3.4.

## Update (2026-10)

- ✅ Lobby schedule screen: /upwardbasketballscores/schedule (alias /schedule), all courts for one day, live, fits one 1920x1080 screen (moves/pages to keep live + next in view, reduced-motion aware, offline like the TV).
- ✅ Gender (Boys/Girls) on teams, CSVs, Admin and every display ("3rd Grade Girls · Eagles vs Lions"); names unique per grade + gender + name.
- ✅ One cheer squad per game (was per side); shown on the TV and schedule, never on the scorekeeper.
- ✅ Schedule warnings in import and Admin (team twice in a weekend, cheer rules, split-court hours).
- ✅ Home team always listed first, home on the left.
- ✅ Demo weekend seed (Fri Full Court evening, Sat West/East 08–16 then Full Court). Details: deliverables/UpwardScoreboard-POC.md section 3.5.
