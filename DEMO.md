# UpwardScoreboard laptop demo (one page)

Windows laptop, Docker Desktop, repo in C:\AIProjects\UpwardScoreboard (its own git repo, nested under C:\AIProjects). All values are demo-only.

## Logins (dev only)

| Login | Value |
|---|---|
| Full court PIN | 1111 |
| West court PIN | 2222 |
| East court PIN | 3333 |
| Admin password (http://localhost:3000/admin) | change-me-admin |

Demo values only; the printed QR cards never show a PIN (they say "enter the court PIN" as the fallback).

## Start and stop

Start (PowerShell, in C:\AIProjects\UpwardScoreboard):

    powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1

It checks Docker, builds and starts the app, waits until it answers, loads the demo weekend if needed, and opens two Edge windows: scorekeeper on the left, TV on the right. On a Saturday they show West (PIN 2222); any other day they show Full (PIN 1111), because the next games are Friday's Full Court games. Add -Schedule to also open the lobby TV (/upwardbasketballscores/lobby) as a third window (scorekeeper | TV | lobby, a third of the screen each; it shows ?day=sat on Saturday, else ?day=fri). Add -Reseed for a fresh start (wipes and reloads the demo games). Add -NoBrowser to skip the windows, or -WindowsOnly to just reopen the two windows (app already running). The windows are Edge app windows with their own demo profile, so your normal Edge is not affected.

Stop:

    powershell -ExecutionPolicy Bypass -File .\Stop-Demo.ps1          (keeps data)
    powershell -ExecutionPolicy Bypass -File .\Stop-Demo.ps1 -Wipe    (deletes all data)

Manual equivalent:

    docker compose up -d --build
    docker compose exec app npm run seed:demo            (only if nothing is scheduled in the demo weekend)
    docker compose exec app npm run seed:demo:reset      (wipe and reseed)
    docker compose restart app                           (after a reseed)
    docker compose down          (or: docker compose down -v to wipe)

No .env is needed: docker compose reads the committed .env.demo. A .env (copy .env.example .env) overrides it.

## Links and logins

| What | Address | Login |
|---|---|---|
| Scorekeeper, West (left window) | http://localhost:3000/score/west | PIN 2222 |
| TV, West (right window) | http://localhost:3000/upwardbasketballscores/westcourt | none |
| Admin | http://localhost:3000/admin | password change-me-admin |
| Lobby TV (live + next per court) | http://localhost:3000/upwardbasketballscores/lobby (alias /lobby); ?day=fri, ?day=sat or ?date=YYYY-MM-DD | none |

Other courts: Full PIN 1111 (/score/full, /upwardbasketballscores/fullcourt), East PIN 3333 (/score/east, /upwardbasketballscores/eastcourt). Both half courts on one TV: /tv/split.

## Demo data: the demo weekend

The demo seed is one weekend, picked relative to today (America/Chicago): today and tomorrow if today is Friday, yesterday and today if it's Saturday, otherwise the upcoming Friday and Saturday.

- Friday: Full Court 17:30, 18:30, 19:30 (5th and 6th grade).
- Saturday: West and East every hour 08:00–15:00 (2nd grade 08–10, 3rd 11–13, 4th 14–15; each hour one Boys and one Girls game), then Full Court 16:30, 17:30, 18:30 (5th and 6th grade).
- Every team plays exactly once. A few Saturday split games have a cheer squad (one per game).

The scorekeeper lists today's games on its court; when there are none today it lists the court's next game day (the demo weekend), with the day in front of the time.

**Mascot logos (Sage, 2026-10):** the demo seed gives all 44 teams and 4 cheer squads a logo from `deliverables/logos/manifest.json` (served at `/team-logos/teams/<slug>.png` and `/team-logos/cheer/<slug>.png`). An existing database that was seeded earlier: `node dist/src/load-logos.js --dry-run`, then without `--dry-run` (fills only empty logos; an Admin upload or URL is kept).

**Lobby logos:** the lobby shows each team's mascot beside its name (live and Up Next rows) and the squad's logo on the cheer row; no logo -> a round initial badge. Court TVs, overlay and scorekeeper are unchanged. **Last game of the day:** if a court has nothing after its live game, that game stays on the lobby through the 2nd half until it goes final (no early "No more games"). **One court rolled:** Up Next is one time slot (the soonest start not already on top); the top cheer row follows the slot still being played.

**Idle screens (no games, no practice):** the lobby and both practice TVs show the next event, whichever comes first: "Next: Games Saturday, Oct 24 · First tip-off 9:00 AM" or "Next: Practice Monday, Oct 26 · 5:00 PM" (the cheer TV counts only nights with cheer; tonight's practice counts until it ends). With nothing scheduled: "No games or practices scheduled". Try `/lobby?day=sat&at=22:00`, `/practice/cheer?day=tue&at=12:00`.

## Practice TVs (Mon–Thu)

- Basketball: `/upwardbasketballscores/practice/basketball` (alias `/practice/basketball`, or `/lobby?practice=basketball`). Pages are the night's 1-hour slots (West 1/2, East 1/2; empty = "Open"): the current slot (from 10 min before it starts) 12 s, then the next slot 8 s. Before the first slot, all slots page at 12 s with "Starts 5:00 PM".
- Cheer: `/upwardbasketballscores/practice/cheer` (alias `/practice/cheer`): one card per room, all evening (no times), 9 per page.
- On from 60 min before the night's first slot to 15 min after its end; otherwise "No practice right now" + the next event. Each team/squad shows its mascot logo, or the initial badge.
- Demo: `?day=mon&at=17:10` (also `day=wed&at=16:40`, `day=fri` for the idle screen). The route shows bottom right for the first minute (`?setup=1` always, `?setup=0` never).
- Demo week (seeded with the demo weekend): Mon + Tue 5–9 PM, Wed 4:30–6:30 PM, Thu 5–6 PM (44 teams, once each); cheer Mon + Thu: Room 20, Room 28/30, Kids Street, Foundry.
- Edit: Admin > **Practice (Mon–Thu)** (`/admin/practice`): night on/off + hours, a team per court per slot, cheer rooms, "Copy this night to", Save week.

## Optional: sign in with the QR code

1. Admin > Courts > Print QR codes.
2. A phone on the same Wi-Fi cannot reach "localhost". Find the laptop address with ipconfig (IPv4, e.g. 192.168.1.20) and set PUBLIC_BASE_URL=http://192.168.1.20:3000 in .env, then run Start-Demo.ps1 again so the printed codes use it. Windows Firewall may ask to allow Docker; allow it on private networks.
3. Scan the West code: the phone signs in without a PIN. To skip all this, just type PIN 2222.

## The 2-minute flow

(Saturday: West, PIN 2222. Any other day: Full, PIN 1111. Optional third window: the lobby TV, Start-Demo.ps1 -Schedule.)

1. Scorekeeper: type the PIN. The court's games are listed (on a weekday: Friday's, with the day shown).
2. Tap the first game (e.g. "5th Grade Boys · Eagles vs Lions" on Full, or "2nd Grade Boys · Eagles vs Lions" on West), then confirm "Load ... Court?". The TV switches from Next up to the game; the schedule highlights it as LIVE.
3. Tap +2 for the home team (always listed first, on the left), +3 for the away team. TV and schedule update instantly.
4. Add a foul for the away team.
5. Start the clock, let it run a few seconds, stop it.
6. Take a timeout for the home team (the clock stops, a timeout dot goes out).
7. Tap Undo: the last action is reversed on the TV.
8. Tap Complete game and confirm. The score locks, the TV shows Next up with the final score, and the schedule shows FINAL.

Game rules (2026-10): **6 periods of 6:00 (36-minute game), 3 per half**, halftime after P3. Every screen labels the period the same way: **"1st Half · P1"–"1st Half · P3", "2nd Half · P4"–"2nd Half · P6"**, then "OT", "OT2". Show it: tap Next period three times (or let P3's clock run out): the TV shows HALFTIME, team fouls go back to 0 (bonus is per half) and each team has 2 timeouts again. Prev right after an accidental Next restores fouls, timeouts and the clock.

**K–2nd Grade (Pre-K, K, 1st, 2nd in any spelling: "2nd Grade", "Gr 2", "grade-1", "Kindergarten", ...): no score on the TV, overlay or lobby**, only clock, period and possession. The scorekeeper for these games has **no points, fouls or timeouts** (buttons hidden; the server refuses them, even from an old screen); it notes "K–2nd Grade: no score, fouls or timeouts". Undo/Redo still work for clock, period and possession taps; Prev/Next period stay. To demo a score, load a 3rd Grade or older game.

**Lobby halftime roll-up:** when a court's live game reaches halftime (P3 at 0:00, or P4 and later) it leaves the lobby; that court's next game moves to the top slot with **"Tip-Off: 12:00 PM"** where the score goes, and Up Next shows the game after it (11:00 at half -> top 12:00, Up Next 1:00). The top game switches to the live display once the scorekeeper starts it (status live). Same for Full Court (if a Full game rolls off, the soonest next game(s) on any court move up). The cheer row follows the top slot's hour.

**Demo it without games running:** `/lobby?day=sat&at=11:10` shows the 11:00 games live (P2); `at=11:18` is halftime (P3 0:00) and already rolled off: top shows 12:00 "Tip-Off", Up Next 1:00. Demo clock: 6:00 periods from tip-off, P1–P3 in minutes 0–18, halftime 18–20, P4–P6 from +20 min.

Point out: Maroon/Gold season colors (home Gold, away Maroon), the grade and gender in the header ("5th Grade Boys"), the church name, and that the TV and schedule need no login. Saturday games with a cheer squad: 09:00 West, 11:00 East, 12:00 West, 14:00 East.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Docker is not running" | Open Docker Desktop, wait for "Engine running", run Start-Demo.ps1 again |
| Port 3000 in use | Close the other app (find it: netstat -ano or Get-NetTCPConnection -LocalPort 3000), or stop an older copy with docker compose down |
| Demo already played / wrong day | Start-Demo.ps1 -Reseed (if no game is active) |
| Scorekeeper says locked after wrong PINs | Wait for the countdown (30 s) |
| Screens look stale | Refresh the browser windows (F5) |
| First start is slow | The first build downloads images; later starts take seconds |
