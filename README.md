# UpwardScoreboard

Live youth-basketball scoreboard and venue display suite for **Upward Basketball and Cheer** at Lenexa Baptist Church — running in production at **https://upward.hipfog.com** (current release: **v1.1.0**).

A volunteer scorekeeper on the bench taps big buttons on a phone or tablet, and scores, clocks, and buzzers stay synchronized in real time across gym court TVs, optional OBS stream overlays, and the lobby display.

- **Scorekeeper** (`/score/<court>`): mobile-first bench controller unlocked via weekly court QR code or court PIN (12 h session). Games run 6 periods × 6:00 (3 per half, auto-advance at 0:00, auto-end at final 0:00, no overtime, no fouls). K–2nd Grade keeps clock, period, and possession only (scores hidden); Full court / 5th–6th Grade adds 1 timeout per team per half and a manual buzzer.
- **Court TVs & OBS Overlays** (`/fullcourt`, `/westcourt`, `/eastcourt`, `/split`, `/<court>court/overlay`): full-screen gym boards, split West+East view, and transparent OBS scorebugs using season colors (light home / dark away; "Swap colors" flips) and team/cheer mascot logos. Plays a 3 s auto-buzzer at period 0:00 (and 5 s during practice clocks); see [SETUP.md](SETUP.md) for the kiosk `--autoplay-policy=no-user-gesture-required` flag.
- **Lobby TV** (`/lobby`): live game + next game per court, halftime roll-up, cheer squad per time slot, locker rooms, and coaches. Defaults to the next game day in `America/Chicago` (today if today has games).
- **Practice TVs** (`/practice/basketball`, `/practice/cheer`): Mon–Thu practice schedules (basketball rotates at the `:30` mark before each slot). Defaults to the next day with slots of that kind.
- **Practice clocks (v1.1.0)**: automatic synchronized **DEVO** (25:00) and **PRACTICE ENDS** (60:00) countdowns with 5 s buzzers on all idle court TVs during scheduled basketball practice hours, with Admin Pause/Resume/Restart controls.
- **Admin** (`/admin`, `/admin/practice`): teams (grade + gender), season colors, logos, courts and printable weekly QR sheets, schedule & rescheduling (with conflict warnings), cheer squads, practice week editor, live game controls, Practice clocks card, and CSV import/export.

One Node/TypeScript container + Postgres. See [docs/releases/v1.1.0-report.md](docs/releases/v1.1.0-report.md), [SETUP.md](SETUP.md), [DEMO.md](DEMO.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/POC.md](docs/POC.md), and [docs/PLAN.md](docs/PLAN.md).

## Production URLs

| Screen | URL |
|---|---|
| Court picker | https://upward.hipfog.com/ |
| Admin | https://upward.hipfog.com/admin (password = `ADMIN_PASSWORD`) |
| Admin — Practice schedule | https://upward.hipfog.com/admin/practice |
| Full Court (Scorekeeper / TV / Overlay) | https://upward.hipfog.com/score/full · https://upward.hipfog.com/fullcourt · https://upward.hipfog.com/fullcourt/overlay |
| West Court (Scorekeeper / TV / Overlay) | https://upward.hipfog.com/score/west · https://upward.hipfog.com/westcourt · https://upward.hipfog.com/westcourt/overlay |
| East Court (Scorekeeper / TV / Overlay) | https://upward.hipfog.com/score/east · https://upward.hipfog.com/eastcourt · https://upward.hipfog.com/eastcourt/overlay |
| Split TV (West + East on one TV) | https://upward.hipfog.com/split (alias `/tv/split`) |
| Lobby TV (live + next per court) | https://upward.hipfog.com/lobby (`?day=fri`, `?day=sat`, `?date=YYYY-MM-DD`) |
| Practice TV — Basketball | https://upward.hipfog.com/practice/basketball (`?day=mon`..`thu`, `?at=HH:MM`) |
| Practice TV — Cheer | https://upward.hipfog.com/practice/cheer (`?day=mon`..`thu`, `?at=HH:MM`) |
| Health check | https://upward.hipfog.com/api/health |
| Weekly court QR sheet | Admin → Courts → Print QR codes (valid until Sunday 23:59 `America/Chicago`) |

> **Local dev & legacy paths:** When running locally, replace `https://upward.hipfog.com` with `http://localhost:3000`. Every legacy `/upwardbasketballscores/...` path (pages, assets, `/api/...`, `/ws`) continues to work as an alias. The old full-day `/schedule` screen was retired 2026-10-20 and returns `404`.

Game-day flow: in Admin → Today press **Start on court** for a game (or let the scorekeeper scan the weekly court QR code / enter the court PIN and pick today's game). The TV for that court switches live without a refresh.

## Practice clocks (v1.1.0)

On scheduled basketball practice nights (Mon–Thu, non-empty 1-hour slots), every court TV (`/westcourt`, `/eastcourt`, `/fullcourt`, and both halves of `/split`) automatically switches from idle to practice mode at the exact slot start time. The screen shows the slot header, a banner of all teams practicing in that hour, and two synchronized countdown clocks running together: **DEVO** (25:00) and **PRACTICE ENDS** (60:00). Each clock buzzes for 5 s on every court TV at 0:00 (DEVO shows `"Devo time!"` for 10 s after reaching 0, then `00:00`), and both restart automatically at the next slot. After the last slot's END 0:00, TVs return to idle. Any court with an active game stays in game mode without practice buzzes. In Admin → Today, a **Practice clocks** card appears during active slots with **Pause/Resume** and **Restart** controls; pause and restart state is persisted in `settings` (`practice_clock`) scoped to the current hour so it survives server restarts.

## Lobby

With no `?date=` and no `?day=`, the lobby (and `GET /api/public/schedule`, and a `role=schedule` socket with no day or date) opens on the next game day in `America/Chicago`: **today** if today has any games, otherwise the earliest later date that has games. If nothing is scheduled from today on, it stays on **today** and shows the "No games today" screen with the next-event line. It does not open on a past day's finals.

A lobby left on that automatic day keeps it for the whole league-local day, including after the last game goes final, and moves to the next game day at midnight Central. If an admin adds a game on an earlier upcoming day, the lobby moves to that day on the next schedule refresh. `?date=`, `?day=fri|sat`, and `?at=` demo mode do not move on their own. The header shows the weekday and tip-off (dated for future days, e.g. `FRI JAN 15 · 5:15 PM`).

## Practice TVs

With no `?day=`, each practice screen opens on the next day that has slots of **its** kind (basketball or cheer): today if today's weekday has those slots, otherwise the next date within a week whose weekday does. `GET /api/public/practice` also sends `display` for the next day that has slots of either kind. Today stays up for the whole league-local day: before the window it previews the night (`Starts 5:00 PM`), and after the window it keeps the schedule up (`Last practice slot tonight`) instead of going idle. It moves on at midnight Central, when the 60-second poll sees the new date.

A future practice day (Friday looking at Monday) previews that weekday: header `MONDAY` or `MONDAY CHEER`, every slot paging at 12 seconds, `Starts Monday 5:00 PM`, and no current slot. If that screen's kind has no slots at all, it stays on today and shows `"No practice right now"`. `?day=mon` through `thu` wins over the default; `?at=HH:MM` alone keeps today and the previous window (idle outside 60 minutes before through 15 minutes after).

## Run it locally

```bash
cp .env.example .env        # then edit the passwords/PINs
docker compose up --build   # app on http://localhost:3000, Postgres in a volume
```

The first start with `SEED=true` seeds a small starter dataset (10 teams, 3 courts: `full`, `west`, `east`, where Full shares the floor with West and East). The committed dev-only `.env.demo` uses `SEED=demo`: a full demo weekend (22 games, 44 teams, Boys and Girls, cheer squads, and a Mon–Thu practice week).

- **Windows laptop demo**: see [DEMO.md](DEMO.md) and [SETUP.md](SETUP.md) for `Start-Demo.ps1` / `Stop-Demo.ps1` and `docker compose exec app npm run seed:demo[:reset]`.
- **Dev defaults** from `.env.example` / `.env.demo`: admin password `change-me-admin`, PINs `full:1111`, `west:2222`, `east:3333`, `GAME_MINUTES=60`. **Change them in any shared or hosted deployment.**

### Without Docker

Requires Node 20+ and Postgres 14+:

```bash
npm install && npm run build
DATABASE_URL=postgres://user:pass@localhost:5432/scoreboard ADMIN_PASSWORD=... SESSION_SECRET=... COURT_PINS=full:1111,west:2222,east:3333 SEED=true npm start
```

## Deploying

Production runs from the repo's `Dockerfile` against managed Postgres (`DATABASE_URL`) on port `3000`. Set the secrets from `.env.example` along with:

- `PUBLIC_BASE_URL=https://upward.hipfog.com` (used for printed weekly court QR links)
- `TRUST_PROXY=true` (when behind a reverse proxy / TLS terminator)
- `TZ=America/Chicago` (controls schedule/CSV times, tickers, and practice clocks)

Never commit `.env`, and never set `SCOREBOARD_TEST_CLOCK` / `SCOREBOARD_TEST_NOW` in production (the server refuses to boot if set under a production `NODE_ENV`). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [SETUP.md](SETUP.md) for backup, restore, and court TV kiosk setup.

## Real 2027 season

- `npm run seed:season:dry` parses `data/season-2027/` and prints the counts and whether a real run would refuse; it writes nothing.
- `npm run seed:season` replaces demo data (or a previous 2027 import) with the real season, loads the bundled 2027 team and cheer mascot logos (`deliverables/logos/manifest-2027.json`), and stores `season_data` along with `practice_start` / `practice_end` in `settings` (leaving season colors and `season_name` untouched).
- If the database already has other games, or any game has score events or a non-scheduled status, it refuses until you pass `--reset` (`node dist/src/seed-season.js --reset`).
- With real data loaded, `SEED=demo` and `npm run seed:demo` print `SKIPPED`; use `npm run seed:demo:reset` to switch back to demo data. The server only imports the real season on startup when `SEED=season`.

## CSV / Google Sheets

Templates live in `deliverables/sheets-templates/` (also `samples/`):

- `courts.csv`: `slug,name,location,conflicts_with`
- `teams.csv`: `name,short_name,grade,gender,coach,logo_url` (legacy color columns are ignored with a warning; season colors apply to all teams)
- `schedule.csv`: `id,date,time,court,grade,gender,division,home,away,minutes,swap_colors,home_locker,away_locker`
- `cheer_squads.csv`: `name,coach`
- `cheer_slots.csv`: `date,time,squad,locker`

Import in **Admin → Import / Export** in the order courts → teams → schedule. When editing an exported schedule in Google Sheets, **keep the `id` column** so changed games update instead of duplicating. Endpoints: `GET /api/export/{courts,teams,schedule}.csv`, `POST /api/import/{courts,teams,schedule}.csv` (admin).

## Tests

```bash
npm install
npm test                                    # TypeScript build + unit/DB suites (dist/test/*.test.js)
node scripts/smoke.mjs                      # end-to-end API/WS smoke suite (188 checks, repeatable on a used DB)
bash scripts/run-e2e.sh                     # runs Playwright E2E suites on a fresh test DB with test clock
node scripts/release1-screenshots.mjs       # Release 1 visual & feature verification (26 checks)
node scripts/release2-practice-e2e.mjs      # v1.1.0 practice clocks browser E2E & screenshots (12 checks)
node scripts/latency.mjs                    # tap -> TV latency (median/p95)
node scripts/gen-templates.mjs [friday]     # regenerate example CSV templates from the demo seed plan
```

The Docker build runs the unit tests and fails the image build if any fail. Individual Playwright E2E scripts (`flow-e2e.mjs`, `offline-e2e.mjs`, `admin-today-e2e.mjs`, `lockout-e2e.mjs`, `colors-e2e.mjs`, `cheer-colors-e2e.mjs`, `cheer-admin-e2e.mjs`) accept `CHROME_PATH` and `BASE_URL`.

## Upgrading an existing database

Migrations run automatically and idempotently on server startup — no wipe is needed (`court-1`/`court-2` rename, `full` court conflict rules, 6×6:00 period migration for scheduled games, practice schedule tables, reschedule audit log, and hex color normalization). Take a `pg_dump` before upgrading (see [SETUP.md](SETUP.md)). For a fresh local demo seed, run `docker compose down -v`.

## Who edits what

UI look and feel lives in `public/*.css` and `public/*.html`. Application logic lives in `public/*.js` and `src/`. Pages bind data via `data-bind="..."` elements, CSS variables (`--season-light`, `--season-dark`, etc.), and state classes so styling can be updated without changing JavaScript.

## Releases & documentation

- **v1.1.0 Build & QA Report**: [docs/releases/v1.1.0-report.md](docs/releases/v1.1.0-report.md)
- **Setup & Operations**: [SETUP.md](SETUP.md), [DEMO.md](DEMO.md)
- **Architecture & Planning**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/POC.md](docs/POC.md), [docs/PLAN.md](docs/PLAN.md), [UpwardScoreboard-Bugs.md](UpwardScoreboard-Bugs.md)
- **Deliverables**: `deliverables/` contains `UpwardScoreboard-POC.md`, mockups, screenshots, diagrams (PNG + `.mmd`), mascot logos, and Sheets templates.

## Known limitations

- **Demo practice range**: When running demo data (`SEED=demo`), no season start or end date is stored, so the weekly Monday–Thursday practice template rolls forward indefinitely. When the real season is loaded (`npm run seed:season`), `settings.practice_start` and `settings.practice_end` bound both the practice TVs and court TV practice clocks to the active season.
