# Plan

Team: **Devon** (backend, architecture), **Sage** (TV/controller/admin UI), **Avery** (QA), **Morgan** (PM and coordination with Aaron and the league).

| Phase | Goal | Milestones | Owners |
|---|---|---|---|
| **0. POC** (done, this repo) | Prove live sync, multi-court, reconnect and clock accuracy | Reducer + tests; WS server; TV/overlay/controller/admin; CSV; docker compose; smoke test; screenshots | Devon (build), Sage (restyle pass), Avery (test plan below), Morgan (demo to Aaron) |
| **1. Pilot: one Saturday, one court** | Real game with a real volunteer | Aaron picks the host → Devon deploys (≈ $13/mo Render) • Sage: final TV look plus phone-first controller review, with a 1-page scorekeeper cheat sheet • Avery: dry run on the actual gym Wi-Fi with the actual TV device (Fire TV + Fully Kiosk or a Chromebook) • Keepthescore free board as a fallback • Morgan: recruit 1 scorekeeper + 1 backup, collect feedback | All |
| **2. Season rollout** | All courts, all Saturdays | Import the season schedule from the league Google Sheet (CSV, then the Sheets API) • per-game-day PINs/QR codes from Admin • Google sign-in for admins • results export / standings page • PIN rate-limit, backups verified • DB migrations tool | Devon (backend), Sage (admin + standings UI), Avery (regression each release), Morgan (training, rollout comms) |
| **3. Streaming** | Families can watch | OBS overlay polish (Sage) • YouTube channel and consent policy (Morgan + church leadership) • one volunteer trained on OBS • optional phone-camera path test (Avery) | Sage, Morgan, Avery, Devon (support) |

## What Avery should test (pilot readiness)

1. Two courts at once: scores, fouls and clock never cross courts.
2. Pull the TV's Wi-Fi or power for 30 s mid-game, then reconnect. The score and clock must match the controller exactly (compare to a stopwatch).
3. Refresh or close the scorekeeper page mid-game: no lost state, and the PIN is remembered.
4. Two phones scoring the same game: every tap counts once, and the "2 scorekeepers" pill shows.
5. Airplane mode for 5 s, tap +2, then reconnect: applied exactly once ("taps sending…" pill clears).
6. Undo/redo across score, fouls and the clock. Undoing a basket must not stop the running clock.
7. Clock: start/stop spam, ±1 s, Set clock, auto-stop at 0, tenths under 1:00, next period resets it, timeout stops it.
8. Bonus tag appears at the configured foul count and resets at halftime.
9. Admin: create a team with an uploaded logo and with a URL logo, a court, a game with color overrides, then Start it. The TV switches without a refresh.
10. CSV: export → edit in Google Sheets → re-import (good and bad rows). Check times in the league time zone.
11. Security: TV/overlay can't score (try with the browser devtools); a wrong PIN, or another court's PIN, is rejected; admin API needs login.
12. Devices: the real TV stick (sleep/screensaver), an iPhone Safari controller, an Android Chrome controller, 1080p and 4K TVs, and OBS browser-source transparency.
13. Load: about 50 viewers on one court with no lag (simple script).

## Open decisions for Aaron (max 5)

1. **Host**: Render (~$13/mo, recommended), DigitalOcean (~$12–20/mo), or Fly.io (~$42/mo)? Who owns the account and card?
2. **Streaming path**: TV only for the pilot, then OBS → YouTube? Do we need a consent/photo policy for minors first?
3. **How many courts** run at once, and which TV device per court (Fire TV + Fully Kiosk vs. Chromebook/mini PC)? Is the gym Wi-Fi usable, or do we need a hotspot?
4. **Who are the scorekeepers**: a parent volunteer per game, or a trained crew? That decides PIN-per-court vs. per-person logins.
5. **League rules**: quarters or halves, period length, timeouts per game, foul count for the bonus, when fouls reset, overtime length. These map directly to `games.rules` (defaults: 4 × 8 min, 3 timeouts, bonus at 7, reset at half).
