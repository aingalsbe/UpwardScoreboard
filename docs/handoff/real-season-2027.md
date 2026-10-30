# Grok Build handoff — Real 2027 season import (feature/real-season-2027)

## (a) Context
- Repo: `C:\AIProjects\UpwardScoreboard` (Aaron's Windows laptop). Node ≥20 / TypeScript (`tsc`, `node --test`), Postgres 16 via Docker compose services `app` and `db` (db user `scoreboard`, db name `scoreboard`).
- Branch: `feature/real-season-2027` off `main` @ `bab3d3a`. This branch already contains this doc and the source CSVs in `data/season-2027/` (do not edit the CSVs).
- Relevant files (read first): `src/db.ts` (SCHEMA, migrate, seedDemo, seedIfEmpty, migrateCombinedGrades, divisionLabel, gradeOrder, squadId, setSlotSquad, hourSlot, gameSlot; courts `full/west/east`, `full.conflicts_with={west,east}`; `teams.name` UNIQUE; `teams.coach`/`cheer_squads.coach` ≤30 chars; `cheer_slots` UNIQUE(date, slot_start) on the hour), `src/practice.ts` (PRACTICE_SCHEMA: `practice_days` 1–4 = Mon–Thu with one start/end per day; `practice_slots` is a **weekly** template, basketball `court IN ('west1','west2','east1','east2')`, cheer has `room` only and no start_time), `src/seed-demo.ts`, `src/seed-practice.ts`, `src/load-logos.ts`, `src/logo-files.ts` (`loadLogos`, `norm`, `formatReport`), `src/schedule.ts`, `src/csv.ts`, `src/server.ts` (startup: `SEED=true` → seedIfEmpty, `SEED=demo` → seedDemo), `deliverables/logos/manifest.json`, `test/*.test.ts`.
- Data: `data/season-2027/Upward Game Schedule 2027.csv`, `Upward Basketball Practice Schedule 2027.csv`, `Cheer Game Schedule.csv`, `Cheer Practice Schedule.csv`, `SUMMARY.md`.

## (b) Goal and acceptance criteria
Goal: replace demo/test data with the real 2027 season through an explicit, idempotent, transactional CLI `node dist/src/seed-season.js [--dry-run] [--reset]` (npm scripts `seed:season`, `seed:season:dry`).

Expected counts (computed from the CSVs; match SUMMARY.md):
| Division | Teams | Games |
|---|---|---|
| Kindergarten | 6 | 24 |
| 1st-2nd Grade Boys | 12 | 48 |
| 1st-2nd Grade Girls | 4 | 16 |
| 3rd-4th Grade Boys | 12 | 48 |
| 3rd-4th Grade Girls | 6 | 24 |
| 5th-6th Grade Boys | 8 | 32 |
| 5th-6th Grade Girls | 4 | 16 |
| **Total** | **52** | **208** |
- Games by court: west 80, east 80, full 48 (all 5th-6th). 8 rounds, 16 dates, 1/15/2027–3/6/2027; each team plays 8 games. 16 Friday 8:15 PM games.
- Basketball practices: 468 dated rows = **52 weekly slots** (each team has exactly one fixed day/time/court across 9 weeks 1/4–3/4/2027). Weekly slots by day: Mon 16, Tue 16, Wed 4, Thu 16. Courts 117 rows each (WEST 1/2, EAST 1/2) = 13 weekly slots each.
- Cheer squads: **10** (K 2, 1st-2nd Girls 4, 3rd-4th Girls 3, 5th-6th Girls 1).
- Cheer slots: **80** (10 per Saturday × 8 Saturdays 1/16–3/6/2027), no (date, hour) collisions.
- Cheer practices: 90 dated rows = **10 weekly slots** (Mon 7, Thu 3).
- game_events: 0 after import. Settings `season_dark`, `season_light`, `season_cheer_primary`, `season_cheer_secondary` byte-identical before/after.

Acceptance criteria (each must be covered by a test or the proof report):
1. `--dry-run` prints the counts above (per-division teams and games, total games, practice slots by day, cheer squads, cheer slots, cheer practice slots, warnings) and writes nothing (DB row counts and settings unchanged; whole run inside a transaction that is rolled back).
2. Real run: all demo/test teams, games, game_events, game_changes, cheer_squads, cheer_slots, practice_slots/practice_days are removed and replaced; final counts equal the table above.
3. Idempotent: running twice yields identical table contents (same counts, same natural keys, no duplicates); a test compares a normalized dump of teams/games/cheer/practice rows across two runs.
4. Transactional: an injected failure mid-import (e.g. a malformed CSV fixture) leaves the DB exactly as before.
5. Normalization: trailing/leading spaces trimmed (division names, "Room 22 "); `1st - 2nd Grade Girls` → `1st-2nd Grade Girls`; internal double spaces in coach names collapsed ("Erin  Friesen" → "Erin Friesen"); "Lady " prefix kept on girls team names.
6. Blank coaches (Bobcats, Wolfpack, Raiders, Buckeyes) → `coach IS NULL`; empty GameReferees import as nothing/NULL (no errors).
7. Courts: `Game Court - West`→`west`, `Game Court - East`→`east`, `Game Court - Full`→`full`; practice `WEST 1`→`west1`, `WEST 2`→`west2`, `EAST 1`→`east1`, `EAST 2`→`east2` (existing `practice_slots.court` sub-court values — no schema change needed).
8. Constants (one exported config object in `src/season-config.ts` or top of `seed-season.ts`): `GAME_MINUTES = 60`, `LATEST_GAME_END = '21:00'` (Friday 8:15 PM games end 9:15 PM → reported as a **warning**, not an error, count 16), `CHEER_COURT = 'full'`, `CHEER_OVERLAP_POLICY = 'warn'` (cheer on Full overlapping Saturday basketball is reported, never fails).
9. `loadLogos(pool)` runs after a real import and its `formatReport` output is printed; unmatched teams/squads are listed (expected: only 10 of 52 team names exist in the manifest by name; 0 of 10 cheer squads). No logo failure fails the import.
10. Never runs on server start: `src/server.ts` unchanged in behavior unless an explicit new flag (`SEED=season`) is set; default/`SEED=true`/`SEED=demo` paths untouched.
11. `season_name`: not changed by default. Optional `--season-name "2027 Upward"` flag only (call out to Aaron; current value `2026–27 Upward` arguably still correct).
12. Coaches stored as full names trimmed to ≤30 chars (current schema comment says "first name only" — see Decisions; implement a single `coachDisplay()` helper so the policy is one line to change).
13. Cheer practice: since `practice_slots` cheer rows have no start_time and `practice_days` has one start per day, Spirit Squad's 6:30–7:30 PM is stored via practice_days Mon 18:00–19:00 for everyone and the 6:30 exception is reported as a warning (do not change schema). Basketball practice_days: Mon/Tue/Wed/Thu 17:00–21:00.
14. All existing tests pass (`npm test`), plus new `test/seed-season.test.ts`.

## (c) Boundaries
- Allowed to create/edit: `src/seed-season.ts`, `src/season-config.ts`, `src/season-import.ts` (optional pure parsing module), `test/seed-season.test.ts`, `test/fixtures/season-2027/**`, `package.json` (scripts only), `src/server.ts` (only to add an opt-in `SEED=season` branch, optional), `README.md`/`docs/**` (docs only).
- Read-only: `data/season-2027/**`, `deliverables/logos/**`, everything else.
- Never touch: `.env*`, `compose.yaml`, `docker-compose.yml`, existing season color settings or their defaults, any uncommitted WIP files you did not create.
- Never run: `git commit`, `git push`, any deploy, `docker compose down`, anything against a remote server. Do not run the real (non-dry) import against the laptop's main DB; use the test DB the existing tests use.

## (d) Steps
1. Read the files listed in (a) and the existing tests (`test/_server.ts` for how a test DB is created).
2. Write pure parsing/normalization in `src/season-import.ts` using `src/csv.ts`: parse 4 CSVs, normalize (criteria 5–7), derive weekly practice slots (assert each team/squad has exactly one weekly slot; else error), build a plan object with counts + warnings.
3. Write `src/season-config.ts` constants (criterion 8) and the court maps.
4. Write `src/seed-season.ts` CLI: `migrate()`, BEGIN; delete game_events, game_changes, cheer_slots, practice_slots, practice_days, games, teams, cheer_squads (clear `courts.current_game_id` first); insert teams (name, coach, division as the existing code stores it — follow `divisionLabel`/`gradeOrder` conventions), games (scheduled_at in America/Chicago local time, court by slug), cheer squads, cheer slots (`hourSlot`), practice_days and practice_slots; on `--dry-run` ROLLBACK, else COMMIT then `loadLogos`. `--reset` = required to delete existing non-demo data when the DB already contains games not created by this importer (refuse with a clear message otherwise). Print report.
5. Add npm scripts `seed:season`, `seed:season:dry`.
6. Tests `test/seed-season.test.ts`: parsing counts (criterion table), normalization cases, court mapping, warnings (16 late games, cheer/Full overlaps), dry-run writes nothing, double run identical, rollback on failure, settings colors unchanged, coach NULLs.
7. `npm test`; then `npm run smoke` if the app is up (skip with a note if not).
8. `npm run build && node dist/src/seed-season.js --dry-run` against the local DB and include output.

## (e) Proof (final message, JSON-friendly)
- Commands + results: `npm test` (pass/fail counts), `node --test dist/test/seed-season.test.js`, `npm run smoke` (or why skipped), `node dist/src/seed-season.js --dry-run` full output.
- `git status --porcelain` and `git diff --stat` (changed files must be within allowed list).
- Counts table vs expected, warnings list, logo match report.

## Data issues found
1. Trailing spaces: division "3rd-4th Grade Boys " and "5th-6th Grade Girls " (practice CSV); "Room 22 " (cheer practice).
2. Cheer division "1st - 2nd Grade Girls" vs basketball "1st-2nd Grade Girls".
3. Double spaces in coach names: Heather  Mitchell, Kevin  Shell, Erin  Friesen, Brian  Kempin, Kathy  Wolfe, Hannah  Gorter, Suzie  Carson.
4. Blank coaches: Bobcats, Wolfpack (1st-2nd B), Raiders, Buckeyes (3rd-4th B). GameReferees always empty. Cheer AwayTeamHeadCoachName always empty; cheer "Column1" always 1 (ignore).
5. Coaches on two teams: Wyatt Morgan (Longhorns, Raptors), Jesse Kangas (Lady Razorbacks, Suns), Kevin Juhl (Eagles, Lady Monarchs).
6. 16 Friday 8:15 PM games end 9:15 PM (past a 9 PM limit).
7. Cheer "Game Court - Full" overlaps Saturday West/East games and 5th-6th Full games (2–5 PM).
8. Spirit Squad practices 6:30–7:30 PM vs everyone else 6:00–7:00 (schema has no per-slot cheer time).
9. Practice courts (WEST/EAST 1/2) named differently from game courts.
10. Only 10/52 team names and 0/10 cheer squads match the current logo manifest (manifest holds demo names).

## Decisions for Morgan/Aaron (non-blocking, defaults chosen)
- Friday 8:15 games past 9 PM → default warn.
- Cheer on Full during basketball → default warn; assumed cheer performs at games.
- season_name stays `2026–27 Upward` unless flagged.
- Coach full names vs "first name only" convention.
- New logos needed for 42 teams + 10 squads.

## Run headlessly on the laptop (PowerShell)
```powershell
cd C:\AIProjects\UpwardScoreboard
git fetch C:\path\to\real-season-2027.bundle feature/real-season-2027:feature/real-season-2027
git checkout feature/real-season-2027
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force C:\Users\ainga\Backups\UpwardScoreboard | Out-Null
docker compose exec -T db pg_dump -U scoreboard -Fc scoreboard > "C:\Users\ainga\Backups\UpwardScoreboard\pre-real-season-$ts.dump"
# NOTE: PowerShell 5 '>' re-encodes binary; on PS5 prefer: docker compose exec -T db sh -c "pg_dump -U scoreboard -Fc scoreboard > /tmp/pre.dump"; docker compose cp db:/tmp/pre.dump "C:\Users\ainga\Backups\UpwardScoreboard\pre-real-season-$ts.dump"
grok --prompt-file docs/handoff/real-season-2027.md --permission-mode acceptEdits --max-turns 120 --output-format json `
  --disallowedTools "Bash(git push*)" "Bash(git commit*)" "Bash(docker compose down*)" "Edit(.env*)" "Write(.env*)" "Edit(compose.yaml)" "Edit(docker-compose.yml)" `
  --allowedTools "Edit(src/seed-season.ts)" "Write(src/seed-season.ts)" "Edit(src/season-config.ts)" "Write(src/season-config.ts)" "Edit(src/season-import.ts)" "Write(src/season-import.ts)" "Edit(test/seed-season.test.ts)" "Write(test/seed-season.test.ts)" "Edit(test/fixtures/season-2027/**)" "Write(test/fixtures/season-2027/**)" "Edit(package.json)" "Edit(src/server.ts)" "Edit(docs/**)" "Write(docs/**)" "Edit(README.md)" `
  *> "C:\Users\ainga\Backups\UpwardScoreboard\grok-real-season-$ts.log"
```
(Verify the exact allow/deny flag names with `grok --help` before running; the rule strings above are the intended policy.)
