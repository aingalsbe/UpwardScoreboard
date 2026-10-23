# Plan: reschedule a game (new date and/or time)

Status: **APPROVED** by Aaron 2026-10-23, with the changes under "Approved decisions" (they override the proposal below). Built on branch feature/reschedule.

## Approved decisions (Aaron, 2026-10-23)
1. **Moved note is public.** "Moved from <Day> <time>" shows on the lobby and Up Next (and any schedule list) until the game is final. Never on court TVs, the overlay or the scorekeeper.
2. **Fri/Sat only**, judged on the league-local date (LEAGUE_TZ). Any other day is a hard 409.
3. **Date and tip-off time only; no court picker.** Court and lockers are never changed or cleared. Checks still run: shared floor, same court, team double-booked, natural-key duplicate. Cheer comes from the new hour. Only `scheduled` games can move.
3b. **Game hours (QA r17, DEFAULT for Aaron to confirm):** no game-day hours were configured anywhere (the split-court 08:00–16:00 rule is only a warning), so tip-off must be 08:00–21:00 league time (last tip 21:00). Constant `GAME_TIP_WINDOW` in src/schedule.ts. Outside -> 409.
3c. **Plain edit = reschedule rules (QA r17):** a `PUT /api/games/:id` that changes `scheduled_at` gets the same Fri/Sat + game-hours checks, sets `moved_from` on the first move and writes a `game_changes` row (kind `reschedule`; court/length-only edits log kind `edit`). An impossible date (2026-02-30) is a 400.
3d. **Create + import (follow-up, Aaron via Morgan):** `POST /api/games` and schedule.csv import use the same `gameTimeErrors` validator. Create -> 409 `{errors[]}`. Import: a new row or a changed time that breaks the rule is rejected with `row N: <date> <time>: <reasons> (row not imported)`; unchanged exported rows still round-trip. The dry-run preview reports the same errors (409 `{errors, preview}`).
3d. **Note text (QA r17):** "Moved from Sat 10/24 11:00 AM" when the date changed; "Moved from 11:00 AM" when only the time changed.
4. **No swap.** Logged as a backlog item in UpwardScoreboard-Bugs.md.
- `time` is optional in the API and defaults to the current tip-off; the dialog pre-fills it.
- Kept from the proposal: `POST /api/games/:id/reschedule {date,time?,reason?,dryRun?}` in one transaction with a row lock; dry-run preview (conflicts + cheer at old and new hour); `games.moved_from` set on the first move only; `game_changes` audit table, History view and `GET /api/games/:id/changes`; CSV `moved_from_date`/`moved_from_time` (read-only; import keeps the move and warns); same-court and team checks also on the plain PUT; additive schema only.

The proposal text below is kept for history; where it mentions a court choice, locker clearing or practice-night warnings, the decisions above win.

## Today (what the code already does)
- `games`: `court_id`, `scheduled_at` (timestamptz), `duration_min`, `status` (scheduled | active | complete), `home_locker` / `away_locker` (free text, 8 characters max, per game, change weekly). The natural key `(court_id, scheduled_at, home, away)` makes schedule.csv imports idempotent.
- Courts: `west`, `east`, `full`. The shared floor is `courts.conflicts_with` (Full lists west + east, symmetric). `floorConflict(court, ts, dur, exceptId)` rejects an overlap with a game on a *conflicting* court. It does **not** check same-court overlap or a team playing twice.
- `cheer_slots(date, slot_start on the hour, squad_id, locker)`: one squad per league-local hour, shared by West/East/Full. A game belongs to the slot its start falls in (09:05 -> 09:00). The cheer squad is tied to the hour, not to a game.
- `PUT /api/games/:id` with `court_id` / `scheduled_at` / `duration_min` already moves a game. It applies only `floorConflict` and the duplicate-key check, accepts any status, and records nothing.

## Proposal
**UI.** In Admin > Schedule, add a "Reschedule…" button on each *scheduled* game. A dialog offers a date, a time (the hour grid plus free minutes), a court (West / East / Full), and an optional reason (40 chars). A live preview shows any conflicts, what happens to the lockers, and "Cheer at the new time: <squad> / none". Saving shows a confirm when there are warnings.

**API.** `POST /api/games/:id/reschedule {date, time, court, reason?, dryRun?}` returns `200 {game, warnings[], lockers: 'kept'|'cleared'}`, or `409 {errors[]}`. `dryRun: true` drives the preview. Everything runs in one transaction with `SELECT … FOR UPDATE` on the game. The plain `PUT` keeps working for small edits, but is tightened to the same checks (below).

**Which games can move.** Only `status='scheduled'`. A live game is refused with 409 "end or reset the game first", and a final game is also refused. If the game is the court's `current_game_id` (queued "Next up"), it is fine to move; `refreshAllCourts()` then re-picks the court's next game.

**Conflict checks (hard errors, 409):**
1. Shared floor: the existing `floorConflict`, so Full blocks West + East and vice versa.
2. Same court: any other game on that court whose `[start, start+dur)` overlaps. This check is new and also closes the gap in today's PUT.
3. Team double-booked: home or away already has an overlapping game on any court. New.
4. Natural-key duplicate (same court, time and teams), as today.
5. The new night must not be a practice night (Aaron's answer 5: a night is all practice or all games). This is a **warning**, because practice is weekly and Mon–Thu. Saturday games never trip it.
Soft warnings: a time off the hour grid, and moving into the past.

**Locker rooms.** They stay with the game by default, because rooms are assigned per game. They are **cleared** (set to NULL, side by side) when, in the new hour, another game or the cheer slot (`cheer_slots.locker`) already uses that room. The response and the preview say which side was cleared, so the admin can re-assign it, or run the existing "fill lockers" action. Cleared rooms show as hidden pills on the lobby, as today.

**Cheer does not move.** `cheer_slots` belongs to the date + hour and is shared by every court. The old hour's squad still cheers for whatever else plays then. The moved game simply joins the new hour's slot (or no cheer). Moving the squad would steal it from the other court's game. The preview shows both hours' squads; the admin edits cheer_slots separately if wanted. If the move leaves the old hour with no games, a warning says "Cheer slot Sat 11:00 now has no games".

**Lobby.** A new nullable column `games.moved_from timestamptz` (plus `moved_from_court`) is set on the first move only, so the original time is kept across re-moves. On the game's day, the lobby and schedule pages show a small note, "Moved from Sat 11:00" (or "Moved from West"), under the matchup. It shows on Up Next and the schedule list only, not on court TVs, the overlay or the scorekeeper. A "Clear note" admin button removes it.

**CSV.** schedule.csv exports the **new** date/time/court, plus optional columns `moved_from_date` and `moved_from_time`. They are read-only on import and ignored if present. Re-import: a row **with an id** updates that game, so an old export re-imported would silently *undo* the move. To prevent this, import compares the row's time with `moved_from`. If the row equals the original time and the game has `moved_from`, it keeps the move and warns "game #12 was rescheduled on <date>; kept the new time (edit the game to change it)". A row **without an id** matches on the natural key. The old-time row no longer matches, so it would create a duplicate game. The same `moved_from` lookup (court, original time, teams) catches this and skips it with the same warning.

**Audit trail.** A new table `game_changes(id, game_id FK cascade, at timestamptz default now(), actor text, kind 'reschedule', before jsonb {date,time,court,home_locker,away_locker}, after jsonb, reason text)`. One row is written per move in the same transaction. Admin > Schedule gets a "History" link per game, plus a `/api/games/:id/changes` GET. It is additive and safe on the droplet (CREATE IF NOT EXISTS), and pg_dump runs first as always.

## Open questions for Aaron (answered above)
1. Should parents see "Moved from …" at all, or only admins? And how long: that day only, or until the game is played?
2. Should a move into a practice night be a warning (proposed) or a hard block?
3. Lockers: auto-clear on a clash (proposed), or keep them and just warn?
4. When a game moves to another day, should the old hour's cheer squad follow if the old hour becomes empty? (Proposed: no, warning only.)
5. Swap two games in one action (common for a gym mix-up), or move one at a time?
6. Should a re-import ever be allowed to override a move (e.g. a column `force=true`)?

## Rough estimate
About 1.5–2 days: the API and checks (½ day), the dialog plus preview (½ day), the migration plus audit plus the lobby note (¼ day), CSV export/import handling (¼ day), and tests (same-court, team, Full floor, live refusal, lockers, cheer unchanged, CSV re-import keeps the move) plus docs (½ day).
