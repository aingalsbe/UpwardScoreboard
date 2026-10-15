# UpwardScoreboard: Proof of Concept

Live youth-basketball scoreboard for the church league (Kansas City area). A bench scorekeeper taps big buttons on a phone or tablet, and the score, clock, fouls, timeouts and possession show instantly on the gym TV, with each matchup's team names, colors and logos. An optional transparent overlay feeds an OBS livestream.

Prepared by Devon (lead developer) with Sage (UI/UX), Avery (QA) and Morgan (PM) for Aaron. Date: October 16, 2026.

## 1. Summary

- Approach: custom build, fully cloud-hosted. There is no computer at the gym; it needs only a TV device with a browser and the scorekeeper's phone or tablet.
- Three modules: Score (bench controller), Display (TV board plus stream overlay), Admin (teams, courts, schedule).
- Stack: one TypeScript Node 20 container that serves the web pages, the API and live WebSocket updates, plus managed Postgres.
- Status: a working POC runs with docker compose. After QA round 1: unit tests 8/8, end-to-end smoke test 60/60 and a browser offline test 10/10 (13/13 including the server-freeze case) all pass on a freshly rebuilt container.
- Recommended host: Render, about $13 per month including managed Postgres.

Research mockups the POC follows:

![TV scoreboard mockup](mockups/tv-scoreboard-mockup.png)

![Scorekeeper controller mockup](mockups/scorekeeper-controller-mockup.png)

## 2. Setup and run (development)

Development defaults only. Never reuse these values on a hosted server.

1. Install Docker with the compose plugin.
2. In the project folder, copy .env.example to .env (dev values: admin password change-me-admin, court PINs court-1 = 1111 and court-2 = 2222, TZ = America/Chicago).
3. Run: docker compose up --build
4. Open http://localhost:3000 and pick a court. Admin is at http://localhost:3000/admin.
5. In Admin > Today, press "Start on court" for a game. Open /tv/court-1 on the TV and /score/court-1 on the scorekeeper's phone.

Tests: npm test (unit), node scripts/offline-e2e.mjs (browser offline test), node scripts/smoke.mjs (end to end; run it last because it deliberately triggers the 30-second PIN and login lockout), node scripts/latency.mjs (sync time).

## 3. Module features

Status key: Built = in the POC. Partial = partly built. Next = planned, not built.

### 3.1 Score: bench scorekeeper controller

URL: /score/court-1 (one link per court). Mobile-first with big buttons: one column on phones, and team, clock, team side by side on tablets.

| Feature | Status | Notes |
|---|---|---|
| Unlock with a court PIN | Built | The PIN is remembered on the device |
| Game clock start and stop | Built | One large toggle button |
| Clock adjust +1 s / -1 s and Set clock (mm:ss) | Built | Never below 0 or above the period length |
| Clock stops automatically at 0:00 | Built | Done on the server |
| Tenths of a second in the last minute | Built | |
| Period previous / next, with overtime | Built | Next period resets the clock. Fouls reset at halftime by default |
| Points +1, +2, +3 per team | Built | |
| Corrections (-1 point) | Built | Score never goes below 0 |
| Team fouls +/- and bonus indicator | Built | Bonus when the opponent reaches the foul limit (default 7) |
| Timeouts remaining | Built | Taking a timeout stops the clock |
| Possession arrow | Built | |
| Undo and redo history | Built | 100 steps. Undoing a basket does not rewind a running clock |
| Halftime banner, End game and save | Built | The final score is saved to the schedule |
| Status pills: online, TV connected, two scorekeepers | Built | "Online" means a fresh server message arrived within the last 3 seconds. The app pings every second; after 3 s of silence it shows "Offline · reconnecting…". Turning off Wi-Fi shows Offline immediately. Presence counts drop within about 4–6 s of a device vanishing |
| Taps during a short network drop are re-sent safely | Partial | Kept in memory only and re-sent after reconnect and re-auth. The server ignores duplicates |
| Horn sound, player fouls, shot clock, offline app mode | Next | |

![Controller on a tablet](screenshots/controller-tablet.png)

![Controller on a phone](screenshots/controller-phone.png)

### 3.2 Display: TV scoreboard and streaming

URLs: /tv/court-1 (full-screen TV board) and /overlay/court-1 (transparent scorebug for OBS). Both are public and read-only.

TV layout: league name and court/division header. For each team: a color bar, logo or initial badge, name in the team color, a large score, fouls, timeout dots and a BONUS tag. In the center: a red clock, the period (OT1, OT2 for overtime) and the possession arrow. At the bottom: an UP NEXT ticker from the schedule. Also a HALFTIME/FINAL banner, and a waiting screen when no game is on the court.

| Behavior | Status | Notes |
|---|---|---|
| Live sync from the controller | Built | Measured tap-to-TV time over 100 taps (same machine, scripts/latency.mjs): median 6.3 ms, 95th percentile 9.4 ms, max 19.4 ms. Over the internet, add the network round trip |
| Automatic reconnect | Built | Detects silent drops with a 1 s app ping and a 3 s watchdog, plus the browser's offline/online events. Retries from 0.5 s up to 8 s. A small red dot blinks while offline |
| Clock while disconnected | Built | Freezes at the moment the connection is lost and is dimmed. It never keeps counting down. After reconnect it jumps to the server's value. In a silent drop (no offline event) it can run up to about 3 s before freezing |
| Readable colors (contrast) | Built (Sage) | Text on team colors is picked automatically so each color pair is at least 4.5:1. Admin warns about low-contrast color choices |
| Overlay team names | Built | The OBS overlay shows the team short name (3–4 letters, set in Admin) |
| Exact state after reconnect or refresh | Built | The server sends the full current state on every connect |
| Clock accuracy | Built | Computed from server timestamps, so it does not drift |
| Resync when a TV stick wakes from sleep | Built | |
| Multiple courts at the same time | Built | Each court has its own TV, overlay and controller links |

Streaming options (the POC builds only the overlay page):

| Option | How it works | Pros | Cons |
|---|---|---|---|
| A. OBS browser-source overlay (page built) | A laptop runs OBS with a camera plus a Browser Source of /overlay/court-1 at 1920x1080 | Professional look, synced score, free, the laptop can also drive the TV | Needs a laptop and an OBS volunteer, and gym upload bandwidth |
| B. YouTube or Facebook Live through OBS | Option A plus a stream key | Families watch from home, and games are recorded | Channel live-stream eligibility, consent policy for minors, music copyright during warm-ups |
| C. Phone camera | Phone on a tripod streaming from the YouTube app, or an RTMP app that supports a web overlay | Cheapest, no laptop | Overlay support varies by app; battery, heat, uplink quality |
| D. Live score link only | Share the read-only TV link or a QR code | No video complexity | No video |

Recommendation: the pilot uses the TV only (the overlay is ready). Add option B once a volunteer owns OBS and the church approves a consent policy.

![TV board, court 1](screenshots/tv-court-1.png)

![TV board, court 2 with halftime banner](screenshots/tv-court-2.png)

![OBS overlay (transparent background)](screenshots/overlay-court-1.png)

### 3.3 Admin

URL: /admin (admin password).

| Feature | Status | Notes |
|---|---|---|
| Today view: courts, live games, links, Start game on court | Built | The TV and controller switch to the new game instantly |
| Teams: name, short name, primary and accent colors, logo by URL or upload | Built | Colors must be #RRGGBB (empty uses a default; anything else is an error). Uploads must be real PNG, JPEG, GIF or WebP files of 1 MB or less (checked by file content); SVG is refused. Larger files get a clear "limit is 1 MB" message. Logo URLs must start with http:// or https:// |
| Delete a team | Built | Refused with a friendly message if the team still has games |
| Courts: add and delete, PIN status | Built | PINs come from server settings in the POC |
| Schedule: add and delete games, with court, time, division, home and away | Built | Times are in league time (America/Chicago) |
| Per-matchup overrides: display names and colors (alternate jerseys) | Built | |
| CSV import and export for courts, teams and schedule | Built | Google Sheets compatible and safe to re-import: nothing is duplicated. Reports created, updated and skipped counts. See section 10 |
| Change history for each game | Built (API) | Every change is logged with who made it |
| Direct Google Sheets sync | Next | Sheets API with a service account: pull the schedule, push results |
| Users and roles | Partial | Admin = password, scorekeeper = court PIN, public viewer = no login. Next: Google sign-in and per-day PINs |

![Admin Today view](screenshots/admin-today.png)

## 4. Architecture and stack rationale

![System architecture](diagrams/architecture.png)

| Choice | Why |
|---|---|
| One Node 20 + TypeScript container | Serves the pages, the API and live updates from one process. A volunteer only has to keep one service and one database running |
| WebSockets in the same process | Two-way and low-latency. The controller sends commands and every screen receives updates over one connection. All recommended hosts support it |
| Plain HTML, CSS and JavaScript pages | No front-end build tooling to maintain. Sage can restyle with CSS files alone. The pages can move to React later without changing the server |
| Postgres for everything, including logos | One backup covers all data. No separate file storage |
| Two runtime libraries (ws, pg) | Little upgrade work over time |
| Docker | The same image runs on a laptop and on any managed host |

This deliberately differs from the research's heavier option (Turborepo, Express, Socket.IO, Prisma). Its main justification was a local court computer, which the cloud-only requirement removes.

UI files owned by Sage: public/tv.css, public/tv.html, public/overlay.css, public/overlay.html, public/score.css, public/score.html, public/admin.css, public/admin.html.

## 5. Data model

![ER data model](diagrams/er-data-model.png)

| Table | Purpose | Key columns |
|---|---|---|
| teams | League teams | name (unique), short_name, primary_color, secondary_color, logo_url, logo_data, logo_mime |
| courts | Physical courts | slug (unique, used in links and PINs), name, location, current_game_id |
| games | Scheduled and played games | court_id, home_team_id, away_team_id, scheduled_at, division, status, theme (matchup overrides), rules, history (live state plus undo), final_home, final_away |
| game_events | Change log for each game | game_id, seq, client_cmd_id, actor, command, created_at |

Planned later: seasons, divisions, users with roles, and hashed per-day court PINs.

## 6. Realtime approach

![Realtime sync and reconnect sequence](diagrams/realtime-sequence.png)

| Topic | Approach |
|---|---|
| Source of truth | The server. Controllers send intents (for example "home +2"), never "set score to 42" |
| Applying changes | Each game has one queue. The server validates each command, applies it with a tested reducer, saves it, then broadcasts the new state to everyone on that court |
| Ordering | Every change increases a sequence number (seq), and every change is logged in game_events |
| Clock | Stored as running, remaining time and a server start time. Each screen calculates the time from server time (offset measured by ping), so nothing drifts |
| Reconnect | Every connect or reconnect receives the full current state, so a TV or controller always shows exactly what the server has |
| Heartbeat | Server pings every 2 s and drops a connection after about 3.5 s of silence, so presence stays accurate. Browsers send an app-level ping every second and treat 3 s of silence as offline. While offline, clocks freeze and dim |
| Retries | Each tap has a unique id. Re-sent taps are recognized and applied only once |
| Two controllers on one game | Commands are queued in arrival order, and both taps count because commands are relative. Screens show a "2 scorekeepers" warning. A controller looking at an old game is refused and refreshed |
| Undo and redo | Full snapshots, kept in the database, so they survive a restart |
| Scale | One app instance easily serves a league. Running several instances would need extra coordination later |

## 7. Auth

| Role | POC | Next step |
|---|---|---|
| Admin | Password from server settings. Signed session cookie for 12 hours. 5 wrong passwords lock that address for 30 s (doubling, max 15 min) with HTTP 429 and Retry-After | Google sign-in with a users table |
| Scorekeeper | PIN for each court, valid only for that court. 5 wrong PINs close the connection; 10 wrong PINs from one network address lock it for 30 s, doubling each time up to 15 min | Per-day PINs or QR codes generated in Admin |
| Public viewer | TV and overlay need no login; the server rejects any command from them | Optional public live-scores page |

HTTPS is provided by the host. Secrets live only in host settings, never in the code repository.

## 8. Hosting, deploy and costs

All options run the same Docker image plus managed Postgres. Deploys run automatically on each push, or with one command. Prices were checked on October 16, 2026 using the pricing pages below. Usage-based items are estimates.

| Host | App | Database | Estimated total per month | Notes |
|---|---|---|---|---|
| Render (recommended) | Web service, 512 MB: $7 | Managed Postgres, 256 MB, 1 GB storage: $6 | About $13 | Easiest dashboard. Database includes 3-day point-in-time recovery. 5 GB bandwidth included, then $0.15/GB. The free web tier sleeps when idle (not verified on the page) |
| DigitalOcean App Platform | Container, 512 MiB: $5 | Development database: $7 | About $12 (about $20 with a full managed database, estimate) | The development database has no backups by default |
| Fly.io | Machine, 512 MB: $3.69 | Managed Postgres Basic: $38 | About $42 | Good command-line tooling, but the database is expensive. No free tier |

Sources:

- Render pricing: https://render.com/pricing (checked 2026-10-16)
- DigitalOcean App Platform pricing: https://www.digitalocean.com/pricing/app-platform (checked 2026-10-16)
- Fly.io pricing: https://fly.io/docs/about/pricing/ (checked 2026-10-16)

Deploy steps on Render (planned, not yet done):

1. Create a Render Postgres database.
2. Create a Web Service from the code repository using the Dockerfile.
3. Set the settings: DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET, COURT_PINS, TZ=America/Chicago, SEED=false.
4. Set the health check path to /api/health.

Upkeep: nothing weekly. Each season, rebuild for security updates, change the PINs and export the CSVs as a backup.

## 9. Project plan

| Phase | Goal | Milestones | Owners |
|---|---|---|---|
| 0. POC (done) | Prove live sync, multiple courts, reconnect and clock accuracy | Game logic and tests, server, four pages, CSV, Docker, smoke test, screenshots, diagrams | Devon (build), Sage (restyle), Avery (test plan), Morgan (demo to Aaron) |
| 1. Pilot: one Saturday, one court | A real game with a real volunteer | Host chosen and deployed; final TV and phone look plus a one-page cheat sheet; dry run on gym Wi-Fi and the real TV device; free Keepthescore board as fallback; feedback collected | Devon (deploy), Sage (UI and cheat sheet), Avery (dry run), Morgan (volunteers and feedback) |
| 2. Season rollout | All courts, every Saturday | Season schedule imported from Google Sheets; per-day PINs or QR codes; Google sign-in for admins; results and standings; backups verified | Devon (backend), Sage (admin and standings UI), Avery (regression testing), Morgan (training and communication) |
| 3. Streaming | Families can watch | Overlay polish, YouTube channel, consent policy, trained OBS volunteer, phone-camera trial | Sage, Morgan, Avery, Devon (support) |

Next steps:

1. Aaron answers the open decisions below (Morgan).
2. Sage restyles the TV, controller and admin pages (CSS only).
3. Avery runs the test plan on the real TV device and gym Wi-Fi.
4. Devon deploys to the chosen host and loads the season schedule from the templates.
5. Morgan schedules the pilot Saturday and recruits a scorekeeper and a backup.

What Avery should test:

1. Two courts at once: nothing ever crosses courts.
2. TV loses Wi-Fi or power for 30 seconds: on reconnect, the score and clock match the controller (compare with a stopwatch).
3. Scorekeeper page refreshed mid-game: nothing is lost.
4. Two phones scoring one game: every tap counts exactly once.
5. Airplane mode for 5 seconds while tapping: each tap is applied once.
6. Undo and redo across score, fouls and the clock.
7. Clock edge cases: auto-stop, tenths, period change, timeout.
8. Bonus at the foul limit, and the reset at halftime.
9. Admin: logo upload, color overrides, starting a game.
10. CSV round trip through Google Sheets, with Kansas City times.
11. The TV cannot score; wrong or other-court PINs are rejected.
12. Real devices: TV stick sleep, iPhone, Android, OBS transparency.
13. About 50 viewers on one court.

Open decisions for Aaron:

1. Host: Render (about $13/month, recommended), DigitalOcean (about $12 to $20) or Fly.io (about $42)? Who owns the account and card?
2. Streaming: TV only for the pilot, then OBS to YouTube? Is a consent policy for minors needed first?
3. Courts: how many run at once, and which TV device for each? Is gym Wi-Fi reliable, or do we need a hotspot?
4. Scorekeepers: a parent volunteer for each game, or a trained crew?
5. League rules: quarters or halves, period length, timeouts, the foul limit for the bonus, when fouls reset, overtime length. POC defaults: 4 x 8 minutes, 3 timeouts, bonus at 7, reset at halftime.

## 10. Google Sheets import and export templates

Files in sheets-templates/. They match the POC importer exactly. Import them in Admin under Import / Export in this order: courts, then teams, then schedule.

| File | Columns | Import behavior |
|---|---|---|
| courts.csv | slug, name, location (required: slug, name) | Matched by slug: adds new courts, updates changed ones, skips identical ones. slug must be lowercase letters, digits and dashes. Scorekeeper PINs are set separately (COURT_PINS) |
| teams.csv | name, short_name, primary_color, secondary_color, logo_url (required: name) | Matched by name: adds, updates or skips. Colors must be #RRGGBB or empty (a bad color is a row error). logo_url must be http(s) or empty |
| schedule.csv | id, date, time, court, division, home, away (required: date, time, court, home, away; id optional) | If id is filled (from an export), that game is updated. Otherwise games are matched by court + start time + home + away, which the database enforces as unique. Duplicate rows in one file are skipped. date is YYYY-MM-DD, time is HH:MM in league time (America/Chicago), court must be an existing court slug (unknown courts are a row error, not created), home and away must be existing teams |

A file missing a required column is rejected as a whole with a message naming the column. Every bad row is reported with its row number; good rows still import. Re-importing the same file, or an export, changes nothing (all rows reported as skipped).

Exports use the same columns. The schedule export starts with the game id and adds home_score, away_score and status, which the importer ignores. In Google Sheets, use File > Download > CSV to produce a file for import, and File > Import > Upload to open an export.

## 11. Known risks and gaps

| Risk or gap | Impact | Mitigation |
|---|---|---|
| Gym Wi-Fi (captive portal, weak signal) | The TV or controller can't reach the cloud | Test before the pilot; bring a hotspot or travel router; Keepthescore as fallback |
| Taps during long outages are kept only in memory | Taps can be lost if the page is closed while offline | Offline app mode with stored queue (next step) |
| POC-level auth (PINs in server settings, 4-digit PINs) | Guessing is now throttled, but PINs are shared and long-lived | Per-day PINs, Google sign-in for admins |
| Lockouts are per network address and held in memory | A gym shares one address, so someone guessing could briefly lock out the real scorekeeper (10 tries, 30 s). Lockouts reset when the server restarts | Per-person logins later; admin can restart if needed |
| Single app instance | Restart takes a few seconds (state is preserved) | Fine for a league; coordination layer before scaling out |
| No database migration tool yet | Riskier schema changes later | Add a migration tool before the first post-launch change |
| Direct Google Sheets sync not built | Manual CSV steps | Sheets API sync in phase 2 |
| Streaming not built beyond the overlay | No family stream yet | Phase 3, after the consent policy |
| Missing features: horn, player fouls, shot clock; matchup logo override is API-only | Possible volunteer requests | Collect pilot feedback and prioritize |
| Volunteer turnover | Knowledge loss | One-page cheat sheet, managed host, minimal upkeep |

## 12. Known bugs and backlog

From QA round 1 (Avery). Fixed in this round: silent network drops (#1), duplicate schedule imports (#2), PIN and login guessing (#3), oversized logo dropping the connection (#4), contrast (#5, fixed by Sage), unclear CSV errors (#8), raw error when deleting a team (#9), logo file and URL validation (#10).

| Item | Status | Notes |
|---|---|---|
| QA #6 | Backlog | From Avery's QA report. The report text was not available to the developer, so see Avery's report for the details |
| QA #7 | Backlog | From Avery's QA report (see the report for details) |
| QA #11 | Backlog | From Avery's QA report (see the report for details) |
| Colored logo images are not contrast-checked | Backlog | Only the team color pairs are checked |
| Grey team colors near #808080 are borderline | Backlog | They pass at about 4.78:1, just above the 4.5:1 minimum |
| Clock can run up to about 3 s before freezing in a silent drop | Known limit | Turning Wi-Fi off is detected immediately; a silent drop takes the 3 s watchdog |
| Offline taps are kept in memory only | Backlog | Lost if the page is closed while offline |
| Phone controller shows the clock above the teams | Backlog (Sage) | Decide the layout order after the pilot |
| Horn, player fouls, shot clock; matchup logo override in the Admin form | Backlog | |

## 13. On-site test checklist for Aaron

Do this at the gym about a week before the pilot, with the real TV device and the scorekeeper's phone.

1. Connect the TV device and the phone to the gym Wi-Fi. Note any sign-in page (captive portal); the TV device may not get past it.
2. Open the TV link full screen on the TV. Check that it is readable from the far bench and the stands, and that the screen does not sleep within 30 minutes.
3. Open the scorekeeper link on the phone and enter the court PIN. Check that "Online" and "TV connected" show.
4. Tap +2, a foul and a timeout. The TV should update immediately.
5. Start the clock and compare it with a phone stopwatch for 2 minutes. It should match within a second.
6. Turn the TV device's Wi-Fi off for 30 seconds while the clock runs, then on again. The TV clock should freeze and dim, then come back with the correct time and score.
7. Do the same with the phone. It should show "Offline · reconnecting…", then recover. Taps made just before the drop should count once.
8. If there are two courts, run both at once and confirm that nothing crosses over.
9. Try a mobile hotspot as a backup network and repeat step 4.
10. Write down anything confusing for the volunteer and send it to Morgan.

