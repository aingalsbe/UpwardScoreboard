# Church League Scoreboard (POC)

Live youth-basketball scoreboard for the church league: a scorekeeper on the bench taps big buttons on a phone/tablet, and the score shows instantly on the gym TV (and an optional OBS stream overlay), with team names, colors and logos per matchup.

* **Score**: `/score/<court>` mobile-first bench controller (PIN per court)
* **Display**: `/tv/<court>` full-screen TV board, `/overlay/<court>` transparent OBS scorebug (public, read-only)
* **Admin**: `/admin` teams, colors, logos, courts, schedule, start a game, CSV import/export

One Node/TypeScript container + Postgres. See [docs/POC.md](docs/POC.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PLAN.md](docs/PLAN.md).

## Run it locally

```bash
cp .env.example .env        # then edit the passwords/PINs
docker compose up --build   # app on http://localhost:3000, Postgres in a volume
```

The first start seeds 6 teams, 2 courts (`court-1`, `court-2`) and 5 games for today (`SEED=true`).

| What | URL |
|---|---|
| Court picker | http://localhost:3000/ |
| Admin | http://localhost:3000/admin (password = `ADMIN_PASSWORD`) |
| Court 1 scorekeeper / TV / overlay | http://localhost:3000/score/court-1 · /tv/court-1 · /overlay/court-1 |
| Court 2 scorekeeper / TV / overlay | http://localhost:3000/score/court-2 · /tv/court-2 · /overlay/court-2 |

Dev defaults from `.env.example`: admin password `change-me-admin`, PINs `court-1:1111`, `court-2:2222`. **Change them in any shared or hosted deployment.**

Game-day flow: in Admin → Today press **Start on court** for a game. The TV for that court switches to the matchup, and the scorekeeper page unlocks with the court PIN.

## Tests

```bash
npm install
npm test                  # reducer unit tests (score, fouls/bonus, clock, timeouts, undo/redo, validation)
node scripts/smoke.mjs    # end-to-end against a running server: 2 courts, WS sync, reconnect, undo, CSV
CHROME_PATH=/usr/bin/google-chrome node scripts/screenshots.mjs   # writes docs/screenshots/*.png
```

The Docker build also runs the unit tests and fails if they fail.

## Without Docker

You need Node 20+ and a Postgres 14+ database.

```bash
npm install && npm run build
DATABASE_URL=postgres://user:pass@localhost:5432/scoreboard ADMIN_PASSWORD=... SESSION_SECRET=... COURT_PINS=court-1:1111 SEED=true npm start
```

## Deploying (on paper, not done yet)

Build the same `Dockerfile` on a managed host, attach the host's managed Postgres as `DATABASE_URL`, set the env vars from `.env.example` as secrets, and expose port 3000. See ARCHITECTURE.md → Hosting.

## Who edits what

UI look and feel (Sage) lives only in `public/*.css` and the markup in `public/*.html`. Logic is in `public/*.js` and `src/`. Pages fill `data-bind="..."` elements and set CSS variables and classes, so you can restyle without touching JavaScript.

## Environment

See `.env.example`. Never commit `.env`.

## Box note

On the dev box Docker inter-container traffic was blocked by a leftover `iptables-legacy` FORWARD DROP policy. This was fixed with `iptables-legacy -I FORWARD -i br-+ -j ACCEPT` (and `-o br-+`). That's not needed on a normal Docker install.
