# UpwardScoreboard laptop demo (one page)

Windows laptop, Docker Desktop, repo in C:\UpwardScoreboard. All values are demo-only.

## Start and stop

Start (PowerShell, in C:\UpwardScoreboard):

    powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1

It checks Docker, builds and starts the app, waits until it answers, loads today's demo games if needed, and opens two Edge windows: scorekeeper on the left, TV on the right. Add -Reseed for a fresh start (wipes and reloads the demo games). Add -NoBrowser to skip the windows, or -WindowsOnly to just reopen the two windows (app already running). The windows are Edge app windows with their own demo profile, so your normal Edge is not affected.

Stop:

    powershell -ExecutionPolicy Bypass -File .\Stop-Demo.ps1          (keeps data)
    powershell -ExecutionPolicy Bypass -File .\Stop-Demo.ps1 -Wipe    (deletes all data)

Manual equivalent:

    docker compose up -d --build
    docker compose exec app npm run seed:demo            (only if nothing is scheduled today)
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

Other courts: Full PIN 1111 (/score/full, /upwardbasketballscores/fullcourt), East PIN 3333 (/score/east, /upwardbasketballscores/eastcourt). Both half courts on one TV: /tv/split.

## Optional: sign in with the QR code

1. Admin > Courts > Print QR codes.
2. A phone on the same Wi-Fi cannot reach "localhost". Find the laptop address with ipconfig (IPv4, e.g. 192.168.1.20) and set PUBLIC_BASE_URL=http://192.168.1.20:3000 in .env, then run Start-Demo.ps1 again so the printed codes use it. Windows Firewall may ask to allow Docker; allow it on private networks.
3. Scan the West code: the phone signs in without a PIN. To skip all this, just type PIN 2222.

## The 2-minute flow

1. Scorekeeper: type PIN 2222. Today's West games are listed.
2. Tap "2nd Grade Bears vs Dolphins", then confirm "Load ... on West Court?". The TV switches from Next up to the game (with Bears Cheer).
3. Tap +2 for Bears, +3 for Dolphins. The TV updates instantly.
4. Add a foul for Dolphins.
5. Start the clock, let it run a few seconds, stop it.
6. Take a timeout for Bears (the clock stops, a timeout dot goes out).
7. Tap Undo: the last action is reversed on the TV.
8. Tap Complete game and confirm. The score locks, and the TV shows Next up (4th Grade Rams vs Knights) with the final score.

Point out: Maroon/Gold season colors, the grade in the header, the church name, and that the TV needs no login.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Docker is not running" | Open Docker Desktop, wait for "Engine running", run Start-Demo.ps1 again |
| Port 3000 in use | Close the other app (find it: netstat -ano or Get-NetTCPConnection -LocalPort 3000), or stop an older copy with docker compose down |
| Demo already played / wrong day | Start-Demo.ps1 -Reseed |
| Scorekeeper says locked after wrong PINs | Wait for the countdown (30 s) |
| Screens look stale | Refresh the browser windows (F5) |
| First start is slow | The first build downloads images; later starts take seconds |
