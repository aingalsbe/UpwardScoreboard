# Grok Build handoff: Lobby + Practice default to the next event day (feature/real-season-2027)

## (a) Context
- Repo C:\AIProjects\UpwardScoreboard, branch `feature/real-season-2027` at be2d493 (real 2027 season loaded: 52 teams / 208 games, first game day **Fri Jan 15, 2027**; practice is a weekly Mon–Thu template).
- Today the Lobby (`/lobby`, `/upwardbasketballscores/lobby`, served by `public/lobby.html` + `lobby.js`; data via WebSocket `role=schedule` and `GET /api/public/schedule`) shows **today** when no `?date=`/`?day=` is given: `resolveScheduleDay()` in `src/schedule.ts` falls back to `localDate(now)`. In the off-season that is an empty "No games today" screen.
- The Practice TVs (`/practice/{cheer,basketball}`, `/upwardbasketballscores/practice/{cheer,basketball}`, `public/practice.html` + `practice.js` + `practice-view.js`; data `GET /api/public/practice`) show today's weekday and go idle outside 60 min before .. 15 min after the practice window.
- Time is league time America/Chicago (`LEAGUE_TZ`, `localDate`). The test clock (`SCOREBOARD_TEST_CLOCK=1` + `SCOREBOARD_TEST_NOW`, `src/test-clock.ts`) moves server "now".
- There is **no stored season date range** (no setting/table). Do not add one (no schema change).

## (b) Goal and acceptance criteria
With no date/day parameter, Lobby and Practice screens open on the next scheduled day with events, in America/Chicago time.

Lobby
1. New pure helper in `src/schedule.ts`: `nextEventDay(gameDates: string[], today: string): string`: returns `today` if `today` is in `gameDates`, else the smallest date > today, else (**fallback**) `today`. (Fallback decision: no future games -> today, which shows the existing "No games today" idle screen with the next-event line; we never show a past day's finals by default.)
2. `resolveScheduleDay` keeps its exact behavior for a valid `?date=` and for `?day=fri|sat`. Only the no-parameter case changes: it uses the league-local date of the server clock and the game dates from the DB (`SELECT DISTINCT` league-local date of `scheduled_at` where `>= today`), via an async wrapper (e.g. `defaultScheduleDay(pool, nowMs)`); one indexed query, no N+1.
3. Applies to every schedule consumer: `GET /api/public/schedule` (no params), the WebSocket `role=schedule` client (no `date`/`day`), therefore `/lobby`, `/lobby/`, `/upwardbasketballscores/lobby`, `/upwardbasketballscores/lobby/`. The Admin "Today" view and court TVs/overlay/scorekeeper do **not** change.
4. Rollover (decision): a schedule client with no explicit date stores `auto = true`. Its date is re-resolved on the existing schedule refresh tick (and on `resync`); it only changes when the resolved day changes. Because "today with games" stays selected all day, after the last game the Lobby keeps showing today's finals until the league-local date changes (midnight CT), then moves to the next game day. If an admin adds a game on an earlier future day, the auto lobby moves to it on the next tick. Explicit-date clients never move.
5. `?at=` demo mode and `?day=` / `?date=` behave exactly as before (existing tests must pass unchanged).
6. The snapshot already carries `date`; the header shows that date (e.g. Fri Jan 15). When the shown day is in the future, nothing is live and the games show as upcoming; the idle/next-event line must not claim "No more games today" for a future day.

Practice
7. `GET /api/public/practice` adds `display: { date, dow, today: boolean }` = the next day with practice slots: today if today's weekday has slots (of any kind) in `days`, else the next date (up to 7 days ahead) whose weekday has slots. Per screen kind the client picks the next day with slots of **its** kind (basketball or cheer) using the same rule (pure helper in `practice-view.js`, e.g. `practiceDisplayDay(data, kind, today, todayDow)`). No slots of that kind at all -> fallback: today, existing idle screen ("No practice right now" + next-event line), no errors.
8. Rollover (decision): today stays selected for the whole league-local day (also after the window ends: show the day's schedule with "Last practice slot tonight", not idle); it moves on at midnight CT (the 60 s poll picks up the new `now.date`).
9. Preview of a future practice day (e.g. Friday -> Monday) renders that weekday's schedule like the pre-window state: all slots page at 12 s, header "MONDAY" / "MONDAY CHEER", starts text "Monday 5:00 PM" (`Starts Monday 5:00 PM`); no "current" slot. On today before the window it shows the same preview (`Starts 5:00 PM`) instead of idle.
10. `?day=mon..thu` and `?at=HH:MM` demo parameters behave exactly as before (explicit day wins; `at` alone keeps today).
11. Season range: none is stored, so practice is unbounded weekly; documented under Known limitations (no schema change).

Both
12. No console errors and no 5xx for: empty DB, no future games, no practice slots, practice slots for only one kind.
12a. Follow-up (Aaron, Oct 30 9:22 PM): when the Lobby shows a day other than league-local today, the header carries the calendar date in the existing style: `FRI JAN 15 · 5:15 PM` (3-letter day, 3-letter month, day, ` · `, time). Today's header is unchanged (`FRIDAY 5:15 PM`); `?at=` demo mode keeps the old header. Fits 1920x1080 and 1280x1024 (no wrap/overflow). Tested in test/lobby-view.test.ts. R26 fix: "today" is the server's league date (`today`, America/Chicago, honors SCOREBOARD_TEST_NOW) carried in every schedule snapshot (WS + `/api/public/schedule`); at midnight CT every open schedule screen gets a fresh snapshot, so a TV left on its own game day shows `SATURDAY 8:00 AM` after midnight. Unknown league date -> dated header (never a guessed weekday). Tested with the test clock in test/next-event-day.test.ts.
13. README "Lobby" and "Practice TVs" sections describe the default day, the fallback and the rollover.
14. Tests (unit, `node --test`): `nextEventDay` (today with games, next date, none -> today, unsorted input); `resolveScheduleDay` unchanged cases; DB test with `SCOREBOARD_TEST_NOW` (or nowMs injection): no-param `/api/public/schedule` returns the next game day, returns today when today has games (also after the last game), today when no future games; `practiceDisplayDay` (Mon with slots, Fri -> Mon, Thu after window -> Thu, cheer-only/basketball-only kinds, no slots -> today); rollover: an auto schedule client changes date only when the clock crosses midnight.
15. Existing suites stay green: `npm test` (with TEST_DATABASE_URL), `scripts/run-e2e.sh` all e2e + smoke on the default test clock and on `E2E_TEST_NOW=2026-10-31T13:00:00-05:00`.

## (c) Boundaries
- Allowed: `src/**`, `public/**`, `test/**`, `docs/**`, `README.md`, `package.json`.
- Never touch `.env*`, `compose.yaml`, `docker-compose.yml`, `Dockerfile`, season color settings, `data/**`, other WIP. No schema change.
- No `git commit`, `git push`, `docker compose down`, deploy. Leave changes uncommitted.
- Do not run the season importer or the demo seed against the laptop's live DB.

## (d) Steps
1. Read `src/schedule.ts` (`resolveScheduleDay`), `src/server.ts` (schedule clients ~L294-470, `/api/public/schedule`, `/api/public/game-days`, `/api/public/practice`), `public/lobby.js`, `public/lobby-view.js`, `public/practice.js`, `public/practice-view.js`, `public/next-event.js`.
2. Implement AC1-6 (server), then AC7-11 (practice), then README (AC13).
3. Add tests (AC14). Run `npm run build` and `npm test`; fix failures.

## (e) Proof (final message)
Files changed, tests added, test counts, and how each AC is met (one line each).

## Run headlessly on the laptop (PowerShell)
```powershell
cd C:\AIProjects\UpwardScoreboard; $ts = Get-Date -Format yyyyMMdd-HHmmss
grok --prompt-file docs/handoff/next-event-day.md --permission-mode acceptEdits --max-turns 120 --output-format json `
  --deny "Bash(git push*)" --deny "Bash(git commit*)" --deny "Bash(docker compose down*)" --deny "Edit(.env*)" --deny "Write(.env*)" --deny "Edit(compose.yaml)" --deny "Edit(docker-compose.yml)" `
  --allow "Edit(src/**)" --allow "Write(src/**)" --allow "Edit(test/**)" --allow "Write(test/**)" --allow "Edit(public/**)" --allow "Write(public/**)" --allow "Edit(docs/**)" --allow "Write(docs/**)" --allow "Edit(package.json)" --allow "Write(package.json)" --allow "Edit(README.md)" --allow "Write(README.md)" `
  *> "C:\Users\ainga\Backups\UpwardScoreboard\grok-next-event-day-$ts.log"
```
