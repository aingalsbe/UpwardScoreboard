# UpwardScoreboard: new-laptop setup

How to get UpwardScoreboard running on a fresh Windows laptop. Checked against `package.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `.env.demo` (key names), `src/server.ts`, `src/db.ts`, `Start-Demo.ps1`, `Stop-Demo.ps1`, `DEMO.md` and `README.md` on Oct 17, 2026.

## 1. Prerequisites

| Tool | Version (from the repo) | Notes |
| --- | --- | --- |
| Windows 10/11 | | Scripts run in Windows PowerShell 5.1 |
| Docker Desktop | any current | Builds the app on `node:20-alpine` (`Dockerfile`) and runs Postgres `postgres:16-alpine` |
| Node.js | **20** (`engines: >=20`, Dockerfile `node:20-alpine`) | Only needed for running tests and `scripts/*.mjs` outside Docker; the app itself runs in Docker |
| npm | comes with Node (repo uses `package-lock.json`) | |
| Git | any current | Git for Windows includes Git Credential Manager |
| Microsoft Edge | | `Start-Demo.ps1` opens Edge app windows (falls back to the default browser) |

**GitHub sign-in:** sign in to GitHub in the browser with the credentials saved in 1Password. Then let Git Credential Manager prompt on the first clone, or run `gh auth login`.

## 2. Git identity

```powershell
git config --global user.name "Aaron Ingalsbe"
git config --global user.email aingalsbe@gmail.com
```

## 3. Clone

```powershell
git clone https://github.com/aingalsbe/UpwardScoreboard C:\AIProjects\UpwardScoreboard
```

## 4. Folder location

Use `C:\AIProjects\UpwardScoreboard`. It is its own git repo (git root is the folder itself), nested under `C:\AIProjects`; Vineyard Manager's repo (`C:\AIProjects`) ignores it via `UpwardScoreboard/` in its `.gitignore`. The Docker Compose project name is pinned (`name: upwardscoreboard` in docker-compose.yml), so the containers and the `upwardscoreboard_pgdata` volume stay the same whatever the folder is.

## 5. Environment files

No `.env` is needed for local use: `docker compose` reads the committed, **dev-only** `.env.demo`. An optional `.env` (gitignored; `git check-ignore .env` holds) overrides it: `Copy-Item .env.example .env`, then change every value. Never commit `.env`, and never use the `.env.demo` values on a hosted server.

| Variable | What it is | Where the value comes from |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Password for `/admin` | Dev value in `.env.demo`; choose your own for anything real |
| `SESSION_SECRET` | Signs admin sessions | Long random string you generate |
| `COURT_PINS` | Scorekeeper PINs, `court:PIN,...` | `.env.demo` (dev); choose your own for real use |
| `POSTGRES_PASSWORD` | Postgres password used by compose | `.env.demo` / compose default |
| `DATABASE_URL` | App's Postgres connection | `.env.example`; compose points it at the `db` service |
| `SEED` | `true` = seed when the DB is empty; `demo` = seed laptop demo data for today | `.env.demo` uses `demo` |
| `PORT` | App port (default 3000) | `.env.example` |
| `LEAGUE_NAME`, `CHURCH_NAME`, `CHURCH_LOGO_URL` | TV header branding (logo optional) | `.env.example` |
| `TZ` | League time zone | `America/Chicago` (compose default too) |
| `GAME_MINUTES` | Game length for the shared-floor overlap rule | `.env.example` (60) |
| `TRUST_PROXY` | `true` behind a reverse proxy (hosted only) | Unset locally |
| `PUBLIC_BASE_URL` | Base URL printed in court QR links (hosted only) | Unset locally |
| `RATE_LIMIT_BASE_MS`, `PIN_IP_BACKSTOP` | Wrong-PIN lockout tuning (defaults 30000 ms, 100) | Unset |

Test-script-only variables (not app config): `BASE_URL`, `CHROME_PATH`, `OUT_DIR`, `PIN1`, `PIN2`, `PINF`, `PIN_EAST`, `E2E_PAUSE_CMD`, `E2E_UNPAUSE_CMD`, `SCENE_DATE`, `N`.

To list a `.env`'s keys without values: `Get-Content .env | ForEach-Object { ($_ -split '=',2)[0] }`

## 6. Start and stop

Both scripts live in the repo root (`C:\AIProjects\UpwardScoreboard`) and run from their own folder (`$PSScriptRoot`), not a hardcoded path.

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1            # start
powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1 -Reseed    # wipe and reload demo games
powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1 -Schedule  # also open the lobby TV
powershell -ExecutionPolicy Bypass -File .\Stop-Demo.ps1             # stop, keep data
powershell -ExecutionPolicy Bypass -File .\Stop-Demo.ps1 -Wipe       # stop and DELETE all data
```

`Start-Demo.ps1` checks Docker, runs `docker compose up -d --build`, waits for `/api/health`, runs `node dist/src/seed-demo.js` in the app container (restarts the app if it seeded), prints the URLs, and opens scorekeeper + TV Edge windows with a throwaway profile. Saturday uses West (PIN 2222), other days Full (PIN 1111). Other switches: `-NoBrowser`, `-WindowsOnly`.

Demo locker rooms + coaches on an existing database (fills only empty fields, never overwrites, no wipe; safe to re-run): `docker compose exec -T app node dist/src/fill-demo.js`. A fresh `-Reseed` (seed-demo `--reset`) already includes them: rooms CH and 1–6, no room used twice in one hour slot (teams and the cheer squad), and a first-name coach on every team and cheer squad.
`Stop-Demo.ps1` runs `docker compose down` (or `down -v` with `-Wipe`).

Manual: `docker compose up -d --build`, `docker compose logs app`, `docker compose down`.

## 7. Database: migrate, seed, back up, restore

- **Migrate:** automatic. The server runs `migrate()` on start, and old schemas are upgraded in place.
- **Seed:** `docker compose exec app npm run seed:demo` (only seeds if needed) or `docker compose exec app npm run seed:demo:reset` (wipe and reseed), then `docker compose restart app`.
- **Six-period migration (2026-10):** also automatic, once (settings key `migration_six_periods`). Every **scheduled** game gets 6 periods (3 per half, 2 timeouts per half); **complete (final) and active games are not touched**. Back up first (dump below). The log line reads `Six-period migration: N scheduled game(s) ...`. A second one-time step (key `migration_six_min_periods`) gives scheduled games **6-minute periods** (rules, saved state and clock set to 6:00); it also runs on a database that already had the six-period step. Log: `Six-minute migration: N scheduled game(s) ...`. Check: `docker compose exec db psql -U scoreboard -d scoreboard -c "SELECT key, value FROM settings WHERE key LIKE 'migration_six%'"`.
- **Data:** everything, including uploaded logos (bytea), lives in Postgres in the `pgdata` volume. One dump covers it all.

Dump (inside the container, then copy out):

```powershell
docker compose exec db pg_dump -U scoreboard -Fc -f /tmp/scoreboard.dump scoreboard
docker compose cp db:/tmp/scoreboard.dump .\scoreboard.dump
```

Restore:

```powershell
docker compose cp .\scoreboard.dump db:/tmp/scoreboard.dump
docker compose exec db pg_restore -U scoreboard -d scoreboard --clean --if-exists /tmp/scoreboard.dump
docker compose restart app
```

**NAS backup is not set up yet** for UpwardScoreboard. GitHub holds the code only; keep dumps somewhere safe yourself.

### Mascot logos

Logos live in git under `deliverables/logos/{teams,cheer}/` with `manifest.json` (512x512 PNG, 300 KB max); the Docker image copies only those (about 11 MB, not the contact sheets). The server serves them at `/team-logos/...` (image/png, cached 1 day) and the DB stores only the path in `teams.logo_url` / `cheer_squads.logo_url` (an uploaded logo still wins). The demo seed fills them. For a database that already has teams:

```
docker compose exec upward-app node dist/src/load-logos.js --dry-run   # report only
docker compose exec upward-app node dist/src/load-logos.js             # fill empty logos (safe to re-run)
docker compose exec upward-app node dist/src/load-logos.js --overwrite # replace existing logos too (not normally needed)
```

Teams match on name + division ("5th Grade Boys"), squads on name, ignoring case and extra spaces. The report lists matched, filled, skipped (already set), manifest entries with no team, and teams/squads with no logo.

**Logos** (team mascots, cheer squads) appear on the lobby, both practice screens, the court TV and the overlay, never on the scorekeeper (the server strips every logo field from scorekeeper messages). A missing or broken logo shows the initial badge on the lobby and practice screens.

### Practice schedule (Mon–Thu)

Tables `practice_days` (day 1–4, basketball hours) and `practice_slots` (basketball: day, 1-hour start, court west1/west2/east1/east2, team; cheer: day, room, squad) are created by the normal start-up migration (additive, no data change). The demo seed fills a demo week; an existing database: `docker compose exec upward-app node dist/src/seed-practice.js` (only when no practice schedule exists). Real teams: Admin > Practice (`/admin/practice`). Displays: `/upwardbasketballscores/practice/basketball` and `/upwardbasketballscores/practice/cheer`.

### Reschedule migration (feature/reschedule)
Additive only, applied automatically on server start: `games.moved_from` (timestamptz, nullable) and a new `game_changes` audit table + index. Nothing is dropped or rewritten. **Take a `pg_dump` before deploying** (see above), then restart the app.
Endpoints (admin cookie): `POST /api/games/:id/reschedule {date, time?, reason?, dryRun?}` (Fri/Sat only; tip-off 08:00–21:00 league time, `GAME_TIP_WINDOW` in src/schedule.ts, a default for Aaron to confirm; `time` defaults to the current tip-off; 409 `{errors[]}` on conflicts) and `GET /api/games/:id/changes` (history). A plain `PUT /api/games/:id` that changes the time follows the same Fri/Sat + hours rules and is logged too. Creating a game (`POST /api/games`, 409 `{errors[]}`) and schedule.csv import use the same validator (`gameTimeErrors`): a new row, or a row that changes a game's time, on another day or outside 08:00–21:00 is not imported and is listed as `row N: <date> <time>: <reason> (row not imported)`; an exported row whose time is unchanged still round-trips. (08:00–21:00 confirmed by Aaron 2026-10-23.) Since round 19 (Aaron 2026-10-23), create and import also block the same checks as reschedule/edit: shared floor, same court in use, a team already playing then (create: 409 with every reason in `errors[]`, shown in full by the Admin game form; import: `row N: <date> <time>: <reasons> (row not imported)`). Final games in a CSV (status `complete`/`final`, or a game already final) are exempt from the Fri/Sat + hours rule (warning `(final game, imported anyway)`) and don't block other finals, so a results restore works; a new final row needs home_score and away_score and is stored as final. schedule.csv export gains read-only `moved_from_date,moved_from_time` columns.

## 8. URLs, ports and dev logins

App on **http://localhost:3000** (health: `/api/health`). Postgres is not published to the host.

| Screen | URL |
| --- | --- |
| Court picker | http://localhost:3000/ |
| Admin | http://localhost:3000/admin |
| Scorekeeper | `/score/full`, `/score/west`, `/score/east` |
| TV | `/upwardbasketballscores/fullcourt`, `/westcourt`, `/eastcourt` (add `/overlay` for OBS) |
| West + East on one TV | `/tv/split` |
| Lobby TV | `/upwardbasketballscores/lobby` (alias `/lobby`, `?day=fri`, `?day=sat`, `?date=YYYY-MM-DD`) |

Dev-only logins (from `.env.demo` / `DEMO.md`): admin password `change-me-admin`; PINs Full `1111`, West `2222`, East `3333`.

## 9. Cron flags

None. UpwardScoreboard has no cron jobs and no `DIGEST_CRON_ENABLED` or `WEATHER_CRON_ENABLED` (those belong to Vineyard Manager).

## 10. Verify checklist

- [ ] `docker compose ps` shows `app` and `db` running/healthy
- [ ] http://localhost:3000/api/health returns 200
- [ ] Admin login works with the dev password
- [ ] A scorekeeper tap shows on the matching TV (3rd Grade or older; K–2nd Grade show no score on the TV, and their scorekeeper has no points/fouls/timeouts, by design)
- [ ] `curl -I http://localhost:3000/team-logos/cheer/lenexa-lil-cheer.png` returns 200 image/png; a team page/TV shows its mascot
- [ ] `/practice/basketball?day=mon&at=17:10` shows Monday 5:00 PM with 4 courts and logos; `/practice/cheer?day=mon&at=17:10` shows the cheer rooms
- [ ] Lobby halftime roll-up: `/lobby?day=sat&at=11:18` shows the 12:00 games on top with "Tip-Off: 12:00 PM" and 1:00 in Up Next
- [ ] The TV period reads like "1st Half · P1" and a new game's clock starts at 6:00
- [ ] Optional, with Node 20: `npm ci` then `npm test`; `npm run smoke` against the running app
- [ ] `git status` shows no `.env`

### Colors

**Every team uses the season colors** (light at home, dark away; "Swap colors" flips a game); there are no individual team colors. The teams API and teams.csv ignore `primary_color`/`secondary_color` (the import result and API response carry a `warnings` note), don't export them, and nothing reads the old DB columns (kept, data untouched). There are no per-game colors either: the game form has no color fields, the games API (`theme.homeColor`/`awayColor`/`homeAccent`/`awayAccent`) and schedule.csv (`home_color`, `away_color`, … columns) ignore them with a `warnings` note (no 400), never return or export them, and no TV, overlay, scorekeeper or lobby reads them. Old values stay in `games.theme`, untouched and unused. Display names (Advanced) remain.

The season colors are hex: Admin shows a hex text box next to the swatch; the API accepts `#RGB` or `#RRGGBB` in any case and stores uppercase `#RRGGBB` (`src/color.ts`). Anything else is a 400 (`dark "rgb(0,0,0)" is not a color; use hex like #1E90FF (#RGB or #RRGGBB)`); old teams.csv color columns are still ignored when invalid. At every start `migrateColors()` (src/db.ts) converts the stored season `rgb()`/`rgba()`/lowercase/3-digit values to `#RRGGBB` (**alpha is dropped**: `rgba(255,0,0,0.5)` becomes `#FF0000`, `rgb(0 128 0 / 50%)` becomes `#008000`; every color is stored opaque. Only color fields, idempotent, safe with games scheduled or live; unreadable values are left and logged; team colors and the retired per-game colors are skipped. An earlier build also uppercased per-game colors; those values are simply unused now). A saved change reaches open TVs, overlays and scorekeepers over the WebSocket with no reload (`scripts/colors-e2e.mjs`).

### Test clock (e2e only)

The e2e scripts create games "now", which is only legal on Fri/Sat 08:00–21:00. `scripts/run-e2e.sh <script...>` runs each script on a fresh `scoreboard_test_e2e` database with the explicit opt-in **`SCOREBOARD_TEST_CLOCK=1`** plus **`SCOREBOARD_TEST_NOW`** set to the next game day (Fri 10:00 league time, from `scripts/_gameday.mjs`). The seed, the server (`src/test-clock.ts`, first import) and the script all shift their clock to that instant and keep ticking; scripts pin Playwright browsers to it (`pinBrowserClock`). Court "today"/"Up next" queries use the app clock instead of SQL `now()` so they follow it. **Never set these in production**: the server refuses to start (exit 1) if either is set while `NODE_ENV` is production-like (anything starting with `prod`, any case; the Docker image sets `production`), if `SCOREBOARD_TEST_NOW` is set without `SCOREBOARD_TEST_CLOCK=1` (exactly `1`), or if the flag is set without a valid time. `E2E_REAL_CLOCK=1` runs on the real clock. Other weekdays can be simulated with a clock-shift preload, e.g. `FAKE_OFFSET_MS=<ms> NODE_OPTIONS="--require /tmp/avery-fakedate.cjs" scripts/run-e2e.sh ...`.

## Common problems

| Problem | Fix |
| --- | --- |
| "Docker is not running" | Open Docker Desktop, wait for "Engine running", run `Start-Demo.ps1` again |
| Port 3000 in use | `Get-NetTCPConnection -LocalPort 3000` to find it, or stop an older copy with `docker compose down` |
| "Container name ... is already in use" | `docker compose up -d --force-recreate` |
| App not healthy after 3 minutes | `docker compose logs app` |
| Demo already played / wrong day | `Start-Demo.ps1 -Reseed` (if no game is active) |
| Scorekeeper locked after wrong PINs | Wait for the countdown (30 s) |
| First start is slow | The first build downloads images; later starts take seconds |
