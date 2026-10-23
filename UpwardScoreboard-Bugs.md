# UpwardScoreboard Bugs

Open bugs and known issues. When an item is fixed, move it to the Fixed table and add the commit hash.

## Open

| ID | Found | Area | Issue | Notes |
|----|-------|------|-------|-------|

## Fixed

| ID | Fixed | Commit | Issue |
|----|-------|--------|-------|
| L3 | 2026-10-20 | d1c92a2 | **POC deliverable still pointed at the retired schedule screen** (Avery, low). deliverables/UpwardScoreboard-POC.md referenced the deleted scripts/schedule-paging-e2e.mjs and listed /upwardbasketballscores/schedule in the URL table. Fix: the table lists the lobby TV (/upwardbasketballscores/lobby, alias /lobby) and notes the schedule screen was retired 2026-10-20 (404); the paging/hooks text is marked historical. |
| L2 | 2026-10-20 | 227bdc7 | **Pick on a cheer-slot-conflict failed for a legacy name** (Avery, low). Symptom: 'pick an existing cheer squad (squad_id)' when the candidate wasn't a squad yet. Fix: new POST /api/cheer-slots/pick (Admin's Pick button uses it) creates the squad by name (no coach; the legacy data has none) and sets the slot in one transaction; a second click changes nothing; names that are neither squads nor candidates for that slot are rejected (400). Tests: db-cheer (create + assign, idempotent, conflict cleared, random name rejected). |
| L1 | 2026-10-20 | d3c1bef | **Lobby UP NEXT preferred the next Full Court game while a Full game was live** (Avery, low). Repro: Sat, Full at 7:00 AM live, split games at 8:00, next Full 5:30 PM: UP NEXT showed Full 5:30 PM. Fix: planLobby() in public/lobby-view.js picks the soonest next game(s) across all courts when Full is live (or nothing is), so the 8:00 split games show next in the mixed layout with court labels. Tests: lobby-view (Avery's repro + Full-sooner case). |
| A3 | 2026-10-17 | 868a155 | **Reopening a final from CSV import goes to 0–0 LIVE** (Avery). Symptom: import West 9:00 as complete 10–16, Reopen: the game is LIVE at 0–0. Root cause: a game completed by the CSV status import never ran on the server, so it has no game state (history), only final_home/final_away; getRuntime() in src/server.ts built a fresh 0–0 state for it and REOPEN made that live. Fix: getRuntime() starts such a game's state from its stored final score, so Reopen continues 10–16 LIVE (TV and Admin), and completing again keeps it. Tests: smoke (import complete 10–16, reopen, API + TV show active 10–16). |
| A2 | 2026-10-17 | 868a155 | **Admin game edit form loses its Away selection every 10 s** (Avery). Symptom: Schedule > Edit > change Away > wait 10 s: it jumps back (15 -> 7). Root cause: the 10 s full refresh (render() in public/admin.js) rebuilt the Court/Home/Away selects' options, which drops the selection, and then forced Away to the second team. Fix: render() keeps the current Court/Home/Away values when it rebuilds the options and only applies the default Away to an empty (new) form; Clear restores the default. Tests: admin-today-e2e (change Away, WebSocket push + 10 s refresh, still selected). |
| A1 | 2026-10-17 | bb2be61 | **Admin Today: a completed game doesn't show its result** (reported by Aaron via Morgan). Symptom: after Complete, the game vanished from Admin's Today games list instead of showing the final. Root cause: client-side filter in public/admin.js:63, `games.filter((g) => g.status !== 'complete')`; the server (`GET /api/games`) already returned the game with status and final score. Fix: Today shows every non-complete game plus today's completed games, ordered by time slot then court, with the result inline (complete: final score home first + ✓ FINAL, + TIE when equal; active: live score + ● LIVE; scheduled unchanged); updates live over the schedule WebSocket push (score, load, complete, reopen, edit); card layout at ≤ 600px, no horizontal scroll at 390px. Tests: unit (admin-today), smoke payload checks, scripts/admin-today-e2e.mjs. |

## Rule changes (planned)

- **Shipped 2026-10 (six periods + young-grade scores):** all games are 6 periods of 6:00 (36 minutes), 3 per half (halftime after P3). Labels everywhere: "1st Half · P1–P3", "2nd Half · P4–P6", "OT"/"OT2" (the old "Q1"/plain number labels are gone). Team fouls and bonus reset at halftime; timeouts are 2 per half and refill at halftime; overtime continues the 2nd half (no reset). Scheduled games were migrated; finals and active games keep their old rules. Kindergarten–2nd Grade games show no score on TV, overlay, lobby or /api/public/* (scorekeeper still records it). Judge period/score-display bugs against these rules.
- Cheer: "one cheer squad per game" will change to **one squad per time slot** (date + start time, shared across West, East and Full; optional). Bugs about per-game cheer should be judged against the new rule once it ships. See docs/plans/locker-rooms-coaches.md and docs/POC.md "Next feature".

