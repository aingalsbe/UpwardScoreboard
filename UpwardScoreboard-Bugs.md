# UpwardScoreboard Bugs

Open bugs and known issues. When an item is fixed, move it to the Fixed table and add the commit hash.

## Open

| ID | Found | Area | Issue | Notes |
|----|-------|------|-------|-------|

## Fixed

| ID | Fixed | Commit | Issue |
|----|-------|--------|-------|
| A1 | 2026-10-17 | bb2be61 | **Admin Today: a completed game doesn't show its result** (reported by Aaron via Morgan). Symptom: after Complete, the game vanished from Admin's Today games list instead of showing the final. Root cause: client-side filter in public/admin.js:63, `games.filter((g) => g.status !== 'complete')`; the server (`GET /api/games`) already returned the game with status and final score. Fix: Today shows every non-complete game plus today's completed games, ordered by time slot then court, with the result inline (complete: final score home first + ✓ FINAL, + TIE when equal; active: live score + ● LIVE; scheduled unchanged); updates live over the schedule WebSocket push (score, load, complete, reopen, edit); card layout at ≤ 600px, no horizontal scroll at 390px. Tests: unit (admin-today), smoke payload checks, scripts/admin-today-e2e.mjs. |
