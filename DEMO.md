# UpwardScoreboard laptop demo (one page)

Windows laptop, Docker Desktop, repo in C:\UpwardScoreboard. All values are demo-only.

## Logins (dev only)

| Login | Value |
|---|---|
| Full court PIN | 1111 |
| West court PIN | 2222 |
| East court PIN | 3333 |
| Admin password (http://localhost:3000/admin) | change-me-admin |

Demo values only; the printed QR cards never show a PIN (they say "enter the court PIN" as the fallback).

## Start and stop

Start (PowerShell, in C:\UpwardScoreboard):

    powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1

It checks Docker, builds and starts the app, waits until it answers, loads the demo weekend if needed, and opens two Edge windows: scorekeeper on the left, TV on the right. On a Saturday they show West (PIN 2222); any other day they show Full (PIN 1111), because the next games are Friday's Full Court games. Add -Schedule to also open the lobby schedule screen as a third window (scorekeeper | TV | schedule, a third of the screen each; it shows ?day=sat on Saturday, else ?day=fri). Add -Reseed for a fresh start (wipes and reloads the demo games). Add -NoBrowser to skip the windows, or -WindowsOnly to just reopen the two windows (app already running). The windows are Edge app windows with their own demo profile, so your normal Edge is not affected.

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
| Schedule (lobby TV, all courts) | http://localhost:3000/upwardbasketballscores/schedule (alias /schedule); ?day=fri, ?day=sat or ?date=YYYY-MM-DD | none |

Other courts: Full PIN 1111 (/score/full, /upwardbasketballscores/fullcourt), East PIN 3333 (/score/east, /upwardbasketballscores/eastcourt). Both half courts on one TV: /tv/split.

## Demo data: the demo weekend

The demo seed is one weekend, picked relative to today (America/Chicago): today and tomorrow if today is Friday, yesterday and today if it's Saturday, otherwise the upcoming Friday and Saturday.

- Friday: Full Court 17:30, 18:30, 19:30 (5th and 6th grade).
- Saturday: West and East every hour 08:00–15:00 (2nd grade 08–10, 3rd 11–13, 4th 14–15; each hour one Boys and one Girls game), then Full Court 16:30, 17:30, 18:30 (5th and 6th grade).
- Every team plays exactly once. A few Saturday split games have a cheer squad (one per game).

The scorekeeper lists today's games on its court; when there are none today it lists the court's next game day (the demo weekend), with the day in front of the time.

## Optional: sign in with the QR code

1. Admin > Courts > Print QR codes.
2. A phone on the same Wi-Fi cannot reach "localhost". Find the laptop address with ipconfig (IPv4, e.g. 192.168.1.20) and set PUBLIC_BASE_URL=http://192.168.1.20:3000 in .env, then run Start-Demo.ps1 again so the printed codes use it. Windows Firewall may ask to allow Docker; allow it on private networks.
3. Scan the West code: the phone signs in without a PIN. To skip all this, just type PIN 2222.

## The 2-minute flow

(Saturday: West, PIN 2222. Any other day: Full, PIN 1111. Optional third window: the schedule, Start-Demo.ps1 -Schedule.)

1. Scorekeeper: type the PIN. The court's games are listed (on a weekday: Friday's, with the day shown).
2. Tap the first game (e.g. "5th Grade Boys · Eagles vs Lions" on Full, or "2nd Grade Boys · Eagles vs Lions" on West), then confirm "Load ... Court?". The TV switches from Next up to the game; the schedule highlights it as LIVE.
3. Tap +2 for the home team (always listed first, on the left), +3 for the away team. TV and schedule update instantly.
4. Add a foul for the away team.
5. Start the clock, let it run a few seconds, stop it.
6. Take a timeout for the home team (the clock stops, a timeout dot goes out).
7. Tap Undo: the last action is reversed on the TV.
8. Tap Complete game and confirm. The score locks, the TV shows Next up with the final score, and the schedule shows FINAL.

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
