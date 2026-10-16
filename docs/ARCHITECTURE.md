# Architecture

## Stack (and why)

**One TypeScript Node 20 server (`node:http` + `ws` + `pg`) that serves plain HTML/CSS/JS pages, plus Postgres. One container, one database.**

- **Few moving parts for a volunteer to keep alive.** There's no separate frontend build, Redis, queue or object store. Logos live in Postgres too, so backups of the database cover everything.
- **Realtime over WebSockets in the same process** gives two-way, low-latency updates. Commands and state flow over one socket, and every managed host listed below supports WebSockets. SSE would also work for the read-only TV, but the controller needs to send commands, and one protocol is simpler.
- **TypeScript on the server** for the logic that matters (the reducer, validation and auth), with unit tests. The **pages are framework-free ES modules** (about 150 lines each) so Sage can restyle them with CSS only and nobody has to maintain a React/Vite toolchain. If the UI grows (standings, stats), moving the pages to Vite + React is a contained change because the WebSocket protocol stays the same.
- **Only 2 runtime dependencies** (`ws`, `pg`), which means little upgrade churn.
- It deliberately differs from the research's Turborepo/Express/Socket.IO/Prisma suggestion. The cloud-only requirement removed the court box and local mode, which were the main reason for that heavier stack. Raw SQL with a single idempotent `SCHEMA` file (applied at boot) is enough at this size. Adopt a migration tool (e.g., node-pg-migrate) before the first schema change after launch.

```
 phone/tablet (Score)        TV device (Display)      OBS laptop (Overlay)      Admin browser
        │  WS cmds/state            │ WS state                │ WS state             │ REST + cookie
        └──────────────┬────────────┴─────────────┬───────────┘                      │
                       ▼                           ▼                                  ▼
            ┌──────────────────────── app container (Node 20, TS) ─────────────────────────┐
            │  static pages  │  /ws  per-court rooms  │  REST /api/*  │  /logos/:id           │
            │                ▼                                                              │
            │       per-game queue → reducer (src/game.ts) → persist → broadcast snapshot   │
            └───────────────────────────────┬──────────────────────────────────────────────┘
                                            ▼
                               Postgres: teams, courts, games(history jsonb), game_events
```

## Data model (Postgres)

| Table | Key columns |
|---|---|
| `teams` | id, name (unique), short_name, primary_color, secondary_color, logo_url, logo_data (bytea), logo_mime |
| `courts` | id, slug (unique, used in URLs and PINs), name, location, current_game_id → games |
| `games` (unique natural key: court_id + scheduled_at + home + away, `NULLS NOT DISTINCT`) | id, court_id, home_team_id, away_team_id, scheduled_at, division, status (scheduled/live/final), theme jsonb (per-matchup name/color/logo overrides), rules jsonb (period count/length, timeouts, bonus, foul reset), history jsonb ({present, past[], future[]}), final_home, final_away |
| `game_events` | id, game_id, seq, client_cmd_id, actor (`pin:west`, `admin`, `system`), command jsonb, created_at. This is the append-only audit log. |

Next: `seasons`, `divisions`, `users(id, email, role)`, `court_pins(court_id, pin_hash, valid_on)`.

## Realtime design

- **Server-authoritative state.** Clients send *intent commands* (`{type:"SCORE", team:"home", pts:2}`), never "set score = 42". The server validates them (`parseCommand`), applies them with the pure reducer `src/game.ts`, persists, then broadcasts the new snapshot to everyone on that court.
- **Sequence numbers.** Every accepted change increments `state.seq`, and undo/redo also move `seq` forward, so clients can always trust the higher number. Each change is also appended to `game_events` with its seq.
- **Clock from timestamps.** The state stores `{running, remainingMs, startedAt}` (server epoch ms). Each screen computes `remainingMs − (serverNow − startedAt)`, where `serverNow = Date.now() + offset`, and the offset comes from the best ping round-trip. A server-side timer stops the clock at exactly 0. No client ever ticks the clock down itself.
- **Heartbeat (QA #1).** The server sends a protocol ping and a `time` message every 2 s, and terminates sockets silent for more than 3.5 s (skipping one round if its own event loop stalled). Browsers can't see protocol pings, so clients send an app-level `ping` every 1 s. A 3 s watchdog with no message marks the connection Offline, closes it and reconnects with backoff. `window` offline/online events trigger this immediately. While not Online, TV, overlay and controller freeze the clock at the moment the connection was lost and dim it (`[data-conn]` CSS hook); the snapshot on reconnect restores it. Measured tap-to-TV latency on the box: median 6.3 ms, p95 9.4 ms (`scripts/latency.mjs`).
- **Reconnect resync.** On every WebSocket (re)connect, and when a tab becomes visible, the server sends a **full snapshot**. Snapshots are small (about 2 KB), so the POC doesn't replay deltas. Heartbeat: a ping every 5 s, and dead sockets are terminated.
- **Idempotent retries.** Each command carries a client-generated id. The controller queues un-acked taps and re-sends them after a reconnect. The server remembers the last 500 ids per game and acks duplicates without applying them again.
- **Two controllers on one game.** All changes to a game go through a per-game promise queue, so they're serialized and applied in arrival order. Because commands are relative (+2, foul +1), concurrent taps from two devices both count and never overwrite each other. The clock toggle sends explicit START or STOP based on what that device sees, so a double-press doesn't flip the clock back. Presence is broadcast, and the controller shows "2 scorekeepers" so the bench notices. A controller showing a stale game (the admin switched games) has its commands rejected (`gameId` mismatch) and is resynced. Per-court "lead scorekeeper" locking is a possible later option.
- **Undo/redo** are full snapshots (100 deep, persisted in `games.history`, so they survive a restart). Undoing a non-clock change keeps the live clock.
- **Scale.** One process holds the per-game queues, which is plenty for a league (a handful of courts, dozens of viewers). Running more than one instance would need Postgres `LISTEN/NOTIFY` or row locks. That's documented, not built.

**Time zone.** The container `TZ` (default `America/Chicago`) is the league time zone. The Postgres session uses it, so naive CSV/admin times like `2026-10-24 09:00` are stored as Kansas City time, and exports, the ticker and the admin list show league time. The image includes `tzdata`.

Diagrams: `deliverables/diagrams/architecture.png`, `realtime-sequence.png`, `er-data-model.png` (mermaid sources alongside).

## Auth

POC brute-force protection (QA #3): in-memory limiter (`src/limits.ts`). Admin login: 5 failures per IP lock it for 30 s, doubling to a 15 min maximum, with HTTP 429 and `Retry-After`. PINs (QA round 2): counted per court + device (`pin:<court>:<device>`, the device id is a random id kept in the browser's localStorage), 5 failures lock that device for that court the same way, with a `{locked, retryAfter}` reply the controller shows as a countdown, and the socket is closed (code 4008). A per-IP backstop locks an address only after 50 failures. A correct PIN returns a court session token (`court.exp.hmac`, 12 h) that the controller stores; reconnects authenticate with it, skip the PIN check and are never subject to lockouts. TV/overlay sockets are read-only: their auth attempts are refused and never counted. Set `TRUST_PROXY=true` behind the host's proxy so `X-Forwarded-For` is used. `RATE_LIMIT_BASE_MS` tunes the base lockout. Logos (QA #10): PNG, JPEG, GIF or WebP only, verified by magic bytes, 1 MB maximum (413 with a message); SVG is rejected; logo URLs must be http(s).

POC: `ADMIN_PASSWORD` gives an HMAC-signed, HttpOnly, SameSite=Strict cookie (12 h). Each court's `COURT_PINS` entry unlocks scoring on that court's WebSocket only and yields a 12 h court-scoped session token (signed with `SESSION_SECRET`); unsent taps are persisted in localStorage and resent after re-auth (idempotent command ids). TV and overlay connections are read-only, and the server rejects their commands. Comparisons are constant-time.
Next steps: Google sign-in (OIDC) for admins with a `users` table and roles (admin / scorekeeper / viewer); per-game-day PINs or QR codes generated in Admin and stored hashed; HTTPS is provided by the host.

## Hosting / deploy

All three options run the same `Dockerfile` (1 web service) plus managed Postgres. Deploys are "push to GitHub = auto-deploy", or one CLI command. **Prices were checked on 2026-10-16 with web fetch.** Usage-based items are estimates.

| Host | App | Postgres | Est. monthly | Notes | Source |
|---|---|---|---|---|---|
| **Render (recommended)** | Web service "<1 CPU, 512 MB" **$7/mo** | Managed Postgres "0.1 CPU / 256 MB, 1 GB SSD" **$6/mo** | **≈ $13/mo** (Hobby workspace $0) | Simplest UI. WebSockets are supported. Postgres includes PITR (3 days on Hobby). Bandwidth: 5 GB included, then $0.15/GB, which is fine for score JSON. The free web tier sleeps when idle (my understanding, not verified on the page) and shouldn't be used for game day. | https://render.com/pricing |
| **DigitalOcean App Platform** | Shared fixed 1 vCPU / 512 MiB **$5/mo** | "Development Database" 512 MiB **$7/mo** | **≈ $12/mo** | Cheapest, but the dev database is **not backed up by default** and is deleted with the app. A real managed Postgres cluster costs more (*estimate ~$15/mo, not verified on this page*), making it ≈ $20. | https://www.digitalocean.com/pricing/app-platform |
| **Fly.io** | `shared-cpu-1x` 512 MB **$3.69/mo** | Managed Postgres Basic **$38/mo** + $0.28/GB | **≈ $42/mo** | Great CLI (`fly deploy`), but managed Postgres dominates the cost. Self-run "Fly Postgres" (~$2/mo) is marked unsupported, so it's not recommended for volunteers. No free tier. | https://fly.io/docs/about/pricing/ |

**Recommendation: Render**, about $13/mo (~$156/yr). It's the right balance of price, backups and a volunteer-friendly dashboard. Deploy steps (on paper): create a Render Postgres, create a Web Service from the repo (Docker), set the env vars (`DATABASE_URL` = internal URL, `ADMIN_PASSWORD`, `SESSION_SECRET`, `COURT_PINS`, `TZ=America/Chicago`, `SEED=false`), and set the health check to `/api/health`. A `render.yaml` blueprint can make this one click later.
Volunteer upkeep: none per week. Each season: update the Node base image (rebuild), rotate the PINs, and export the schedule/results CSV as a backup.

## Update (courts, shared floor, season colors, grades, QR scorekeeping flow)

Courts are now full, west and east (Full shares the floor with West and East; GAME_MINUTES default 60 with a per-game override). Statuses are scheduled/active/complete with one active game per court. Scorekeepers sign in with a weekly signed court QR (PIN fallback) and pick today's game. TV links: /upwardbasketballscores/{fullcourt,westcourt,eastcourt} and /overlay variants, plus /tv/split. Season colors (Maroon #800000 / Gold #FFC72C) replace team colors; teams have grades. Full details: deliverables/UpwardScoreboard-POC.md section 3.4.
