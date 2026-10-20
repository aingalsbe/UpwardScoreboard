# UpwardScoreboard Bugs

Open bugs and known issues. When an item is fixed, move it to the Fixed table and add the commit hash.

## Open

| ID | Found | Area | Issue | Notes |
|----|-------|------|-------|-------|

## Fixed

| ID | Fixed | Commit | Issue |
|----|-------|--------|-------|
| A3 | 2026-10-17 | 868a155 | **Reopening a final from CSV import goes to 0–0 LIVE** (Avery). Symptom: import West 9:00 as complete 10–16, Reopen: the game is LIVE at 0–0. Root cause: a game completed by the CSV status import never ran on the server, so it has no game state (history), only final_home/final_away; getRuntime() in src/server.ts built a fresh 0–0 state for it and REOPEN made that live. Fix: getRuntime() starts such a game's state from its stored final score, so Reopen continues 10–16 LIVE (TV and Admin), and completing again keeps it. Tests: smoke (import complete 10–16, reopen, API + TV show active 10–16). |
| A2 | 2026-10-17 | 868a155 | **Admin game edit form loses its Away selection every 10 s** (Avery). Symptom: Schedule > Edit > change Away > wait 10 s: it jumps back (15 -> 7). Root cause: the 10 s full refresh (render() in public/admin.js) rebuilt the Court/Home/Away selects' options, which drops the selection, and then forced Away to the second team. Fix: render() keeps the current Court/Home/Away values when it rebuilds the options and only applies the default Away to an empty (new) form; Clear restores the default. Tests: admin-today-e2e (change Away, WebSocket push + 10 s refresh, still selected). |
| A1 | 2026-10-17 | bb2be61 | **Admin Today: a completed game doesn't show its result** (reported by Aaron via Morgan). Symptom: after Complete, the game vanished from Admin's Today games list instead of showing the final. Root cause: client-side filter in public/admin.js:63, `games.filter((g) => g.status !== 'complete')`; the server (`GET /api/games`) already returned the game with status and final score. Fix: Today shows every non-complete game plus today's completed games, ordered by time slot then court, with the result inline (complete: final score home first + ✓ FINAL, + TIE when equal; active: live score + ● LIVE; scheduled unchanged); updates live over the schedule WebSocket push (score, load, complete, reopen, edit); card layout at ≤ 600px, no horizontal scroll at 390px. Tests: unit (admin-today), smoke payload checks, scripts/admin-today-e2e.mjs. |

## Rule changes (planned)

- Cheer: "one cheer squad per game" will change to **one squad per time slot** (date + start time, shared across West, East and Full; optional). Bugs about per-game cheer should be judged against the new rule once it ships. See docs/plans/locker-rooms-coaches.md and docs/POC.md "Next feature".

