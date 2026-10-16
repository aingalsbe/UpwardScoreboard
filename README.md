# UpwardScoreboard (POC)

Live youth-basketball scoreboard for the church league: a scorekeeper on the bench taps big buttons on a phone/tablet, and the score shows instantly on the gym TV (and an optional OBS stream overlay), with team names, colors and logos per matchup.

* **Score**: `/score/<court>` mobile-first bench controller (PIN per court)
* **Display**: `/tv/<court>` full-screen TV board, `/overlay/<court>` transparent OBS scorebug (public, read-only)
* **Admin**: `/admin` teams (grade + gender), colors, logos, courts, schedule (with warnings), start a game, CSV import/export
* **Schedule**: `/upwardbasketballscores/schedule` (alias `/schedule`) lobby TV: all courts for one day, live; `?day=fri|sat` (demo weekend) or `?date=YYYY-MM-DD`

One Node/TypeScript container + Postgres. See [docs/POC.md](docs/POC.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PLAN.md](docs/PLAN.md).

## Run it locally

```bash
cp .env.example .env        # then edit the passwords/PINs
docker compose up --build   # app on http://localhost:3000, Postgres in a volume
```

The first start seeds 10 teams in 4 grades, 3 courts (`full`, `west`, `east`; Full shares the floor with West and East) and 7 games for today, branded Lenexa Baptist Church with the 2026–27 Upward Maroon/Gold season colors (`SEED=true`). The committed `.env.demo` uses `SEED=demo` instead: the demo weekend (this Fri/Sat, or the upcoming one; 22 games, 44 teams, Boys and Girls, one cheer squad on four Saturday split games). See DEMO.md and section 3.5 of deliverables/UpwardScoreboard-POC.md.

| What | URL |
|---|---|
| Court picker | http://localhost:3000/ |
| Admin | http://localhost:3000/admin (password = `ADMIN_PASSWORD`) |
| Full scorekeeper / TV / overlay | http://localhost:3000/score/full · /upwardbasketballscores/fullcourt · /upwardbasketballscores/fullcourt/overlay |
| West scorekeeper / TV / overlay | http://localhost:3000/score/west · /upwardbasketballscores/westcourt · /upwardbasketballscores/westcourt/overlay |
| East scorekeeper / TV / overlay | http://localhost:3000/score/east · /upwardbasketballscores/eastcourt · /upwardbasketballscores/eastcourt/overlay |
| West + East on one TV | http://localhost:3000/tv/split |
| Schedule (lobby TV, all courts) | http://localhost:3000/upwardbasketballscores/schedule · /schedule · ?day=fri · ?day=sat · ?date=YYYY-MM-DD |
| Weekly court QR sheet | Admin > Courts > Print QR codes (valid until Sunday 23:59 America/Chicago) |

Dev defaults from `.env.example`: admin password `change-me-admin`, PINs `full:1111`, `west:2222`, `east:3333`, `GAME_MINUTES=60` (default game length for the shared-floor rule). **Change them in any shared or hosted deployment.**

Game-day flow: in Admin → Today press **Start on court** for a game. The TV for that court switches to the matchup, and the scorekeeper page unlocks with the court PIN (the device then keeps a 12 h session for that court). When editing an exported schedule in Sheets, **keep the `id` column** so changed games update instead of duplicating.

## Tests

```bash
npm install
npm test                  # reducer unit tests (score, fouls/bonus, clock, timeouts, undo/redo, validation)
CHROME_PATH=/usr/bin/google-chrome node scripts/offline-e2e.mjs  # Playwright setOffline: Offline in <5 s, clock freezes, recovers
CHROME_PATH=/usr/bin/google-chrome node scripts/lockout-e2e.mjs # wrong PINs on east don't affect signed-in west; queued tap delivered
CHROME_PATH=/usr/bin/google-chrome node scripts/flow-e2e.mjs    # QR sign-in, picker, complete lock, resume, TV switching
node scripts/smoke.mjs    # end-to-end (169 checks, incl. gender, warnings, schedule screen route + live updates, home first; repeatable on a used DB): 3 courts + shared-floor rule, grades (team names unique per grade), season colors, cheer squads, QR flow, statuses, sync, reconnect, undo, idempotent CSV, errors, logos, lockouts, sessions.
                          # Repeatable on a used DB (own uniquely named fixtures); waits out an admin-login lock left by a previous run
node scripts/latency.mjs  # tap -> TV latency (median/p95)
CHROME_PATH=/usr/bin/google-chrome node scripts/screenshots.mjs   # writes docs/screenshots/*.png
node scripts/schedule-screenshots.mjs  # schedule screen ?day=fri / ?day=sat (on a fresh demo seed; reseed after)
node scripts/gen-templates.mjs [friday] # regenerate the example teams/schedule CSVs from the demo seed plan
```

The Docker build also runs the unit tests and fails if they fail.

## Without Docker

You need Node 20+ and a Postgres 14+ database.

```bash
npm install && npm run build
DATABASE_URL=postgres://user:pass@localhost:5432/scoreboard ADMIN_PASSWORD=... SESSION_SECRET=... COURT_PINS=full:1111,west:2222,east:3333 SEED=true npm start
```

## Deploying (on paper, not done yet)

Build the same `Dockerfile` on a managed host, attach the host's managed Postgres as `DATABASE_URL`, set the env vars from `.env.example` as secrets, and expose port 3000. See ARCHITECTURE.md → Hosting.

## Who edits what

UI look and feel (Sage) lives only in `public/*.css` and the markup in `public/*.html`. Logic is in `public/*.js` and `src/`. Pages fill `data-bind="..."` elements and set CSS variables and classes, so you can restyle without touching JavaScript.

## Environment

See `.env.example`. Never commit `.env`. `TZ` defaults to `America/Chicago` (league in the Kansas City area) and controls CSV times, the ticker and admin times.

## CSV / Google Sheets

Templates are in `deliverables/sheets-templates/` (also `samples/`): `courts.csv` (`slug,name,location`), `teams.csv` (`name,short_name,primary_color,secondary_color,logo_url`), `schedule.csv` (`date,time,court,division,home,away`). Import in Admin → Import / Export in the order courts → teams → schedule. Endpoints: `GET /api/export/{courts,teams,schedule}.csv`, `POST /api/import/{courts,teams,schedule}.csv` (admin).

## Deliverables

`deliverables/` is the upload folder: `UpwardScoreboard-POC.md` (main doc), mockups, screenshots, diagrams (PNG + .mmd) and Sheets templates.

## Box note

On the dev box Docker inter-container traffic was blocked by a leftover `iptables-legacy` FORWARD DROP policy. This was fixed with `iptables-legacy -I FORWARD -i br-+ -j ACCEPT` (and `-o br-+`). That's not needed on a normal Docker install.

## Upgrading an existing database

No wipe needed: on start, `court-1`/`court-2` are renamed to `west`/`east` (games kept), `full` is added with `conflicts_with = west east`, statuses live/final become active/complete, and new columns get defaults. Idempotent. For a fresh demo seed: `docker compose down -v`.

## Laptop demo (Windows)

See DEMO.md: `Start-Demo.ps1` / `Stop-Demo.ps1`, demo data via `SEED=demo` (in the committed dev-only `.env.demo`) or `docker compose exec app npm run seed:demo[:reset]`.
