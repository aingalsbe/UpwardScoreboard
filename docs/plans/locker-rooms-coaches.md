# Plan: locker rooms, coaches, cheer by time slot, lobby TV "live + next"

**Status (2026-10-20):** Phase 1 BUILT (schema, migration, API/snapshot, CSV + templates, tests). Phase 2 BUILT: Admin (Cheer tab: squads + cheer-by-hour editor, slot warnings with "Pick", coach on Teams, lockers in the game editor, CSV cards) and the lobby TV v2 at `/upwardbasketballscores/lobby` (alias `/lobby`; Sage's lobby-v2 mockup, selection in `public/lobby-view.js`). Screenshots: `docs/screenshots/lobby-v2-built/`.
Morgan's rulings: a slot is the scheduled 1-hour block (date + start floored to the hour, `slot_start` on the hour); a migration conflict creates no slot and raises `cheer-slot-conflict` with the candidates; the payload carries only the coach's first name; with no live game, a court shows its next game.

Owner: data/API/JS (me); look and CSS: Sage. Mockup: `/workspace/uploads/lobby/slide-01..15.png`. It shows the `FRIDAY 5:15 PM` header, WEST/EAST panels, a gold Home row and a black Away row, a Locker Room pill per team, and a pink CHEER row spanning both courts. The mockup has no coach.

## Rules (Aaron, 2026-10-20)
- Cheer is **one squad per time slot** (date + start time), shared by West, East and Full. It is optional, and some slots have none. This **supersedes** "exactly one cheer squad per game".
- Locker rooms change **every week for every team**. Each game has its own `home_locker`/`away_locker` with **no default or pre-fill**. The cheer locker is set per slot.
- Coaches are set for the whole season, with **1 coach per team** (basketball and cheer), entered as a **first name** only. The renderer adds "Coach ", e.g. "Coach Mike". The scorekeeper never sees it.

## Schema (src/db.ts, additive and idempotent)
- `games.home_locker`, `games.away_locker`: TEXT NULL, max 8, free text ('CH', '2').
- `teams.coach`: TEXT NULL, first name, max 30.
- `cheer_squads(id serial PK, name TEXT UNIQUE NOT NULL, coach TEXT NULL, logo_url TEXT, logo_data BYTEA, logo_mime TEXT)`.
- `cheer_slots(id serial PK, date DATE NOT NULL, start_time TIME NOT NULL, squad_id INT NOT NULL REFERENCES cheer_squads ON DELETE CASCADE, locker TEXT NULL, UNIQUE(date, start_time))`. A slot with no row means that slot has no cheer.
- **Migration (one-time, in a transaction):**
  1. Insert distinct `trim(games.cheer)` into squads, taking the first non-null logo per name.
  2. Group games by league-TZ date and time and insert a slot where exactly one squad is present.
  3. Do not insert a slot for a group with more than one distinct squad. List each such group (`date time: A (game #x), B (game #y)`) in the startup log and in `/api/warnings` (`cheer-slot-conflict`) until an admin picks one.
- **Conflict check (2026-10-20):** 0 conflicts in the demo seed (`demoSeedPlan`), in `samples/schedule.csv` and in the template. Each has 4 squads in 4 distinct Saturday slots (09:00, 11:00, 12:00, 14:00). I could not query the live box DB: `db:5432` is reachable, but the box has neither `psql` nor the `pg` package. Run the read-only check query in the migration PR before deploying.
- `games.cheer*` stays **read-only** during the transition. Nothing writes to it, and readers use `cheer_slots`. **Drop it** in the release after the next import cycle, once the conflict list is empty and an export → re-import round-trip matches.

## API / snapshot
- `GAME_SELECT` gets the lockers and `h.coach`/`a.coach`. `cheerView(r)` now reads the slot for the game's date+time, via a `LEFT JOIN cheer_slots` + `cheer_squads`, and returns `{ name, logo, locker, coach }`.
- The court snapshot, `scheduleSnapshot` and `/api/public/schedule` get the lockers and the coach. The lobby payload adds `cheer` per slot.
- **Scorekeeper:** `forRole('score')` already drops `cheer`. It also deletes `home.coach`/`away.coach`, and the `today`/`upNext` lists never select coach. A test scans the whole score payload and fails on any `coach` key.
- `/api/warnings`: add `cheer-slot-empty` (a slot with no games at that date+time) and `cheer-slot-conflict`. The existing `cheer-not-allowed` rule (2nd–4th grade, Saturday split courts) now checks against slots.

## Admin
- New **Cheer Squads** page: name, coach first name, logo (upload/URL, same validation as team logos).
- Teams form: a Coach (first name) field.
- Schedule: a **cheer-by-time-slot editor** with one row per distinct game time on the day (squad dropdown or "none", plus locker).
- The game editor keeps Home locker and Away locker. Its per-game cheer fields are removed.

## CSV (described here only; templates and generator are NOT edited yet)
- `cheer_squads.csv`: `name,coach[,logo]`, matched by name.
- `cheer_slots.csv`: `date,time,squad,locker`, matched by date+time. A blank squad deletes the slot. An unknown squad is an error.
- `schedule.csv`: adds `home_locker,away_locker`. `teams.csv`: adds `coach`.
- Idempotency is the same everywhere: an absent column is untouched, a blank cell clears the value, and a second run reports 0 changes.
- **Legacy files:** `cheer`/`cheer_logo` and `home_cheer`/`away_cheer` in schedule.csv are mapped to a slot for the row's date+time, creating the squad if needed. If two rows give different squads for one slot, the first one is kept and a warning is raised.
- Template change for `scripts/gen-templates.mjs` → `deliverables/sheets-templates/` and `samples/`: add the two new files, drop `cheer,cheer_logo` from schedule.csv in favor of the lockers, add `coach` to teams.csv, and update the README.

## Lobby TV data (JS; Sage styles)
- Per court: `live` is the active game. `next` is **exactly one** game: the earliest scheduled game today after the live one, or after now if nothing is live. Live and next always render.
- Full Court: when it is live or next first, it gets a single panel spanning both courts (the existing `conflicts_with` logic).
- Cheer row: the squad for the slot being shown, which **spans both courts**, with its locker and "Coach X". There is no row when the slot has no cheer.
- Header: the slot time, `FRIDAY 5:15 PM` in league TZ.
- Hooks: `data-court`, `data-slot="live|next"`, `data-row="home|away|cheer"`, `data-bind="name|locker|coach|header"`, `data-state`, plus `data-empty` on a missing locker or coach.

## Tests and estimate
- Tests:
  - migration: a backfill, a conflict, and a re-run.
  - slot CSV import, with idempotency and legacy mapping (including a conflict).
  - warnings.
  - deep scan of the scorekeeper payload for coach.
  - lobby selection: live+next, next only, Full span, a cheer slot and no cheer.
- **Estimate: ~4–5 dev days.** Schema and migration 1, API/warnings 0.5, Admin (squads page plus the slot editor) 1–1.5, CSV and legacy mapping 1, lobby JS 0.5, tests 0.5, plus Sage's CSS.

## Open questions
1. Is a cheer "slot" the exact start time? What happens when West starts at 9:00 and East at 9:05?
2. On a conflict at migration, which squad should be kept, or must an admin decide?
3. Where does the coach go, given the mockup shows none: under the team name or in the row?
4. When nothing is live on a court, should the panel show only the next game, or "next" plus the one after?
