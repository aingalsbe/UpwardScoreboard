# Lobby v2 mockup: data needs (aligned with docs/plans/locker-rooms-coaches.md)

Mockups: `saturday-split.html/.png` (West + East, live + next each; West live has a cheer squad, East doesn't;
East next has no away locker → hidden pill), `friday-full.html/.png` (one Full Court panel: live with cheer + next).
Shared style: `lobby.css`. All names are SAMPLE DATA.

## Fields the mockup uses → Devon's plan
| Mockup element | Field (plan) | Exists today? |
|---|---|---|
| Header `SATURDAY 11:00 AM` | slot `scheduled_at` formatted in league TZ (`data-bind=header`) | yes (scheduled_at) |
| Court panel / Full Court span | `courts.slug`, `conflicts_with`, lobby `span="full"` logic | slug + conflicts_with yes; lobby selection new |
| Team name (home first) | `teams.name` (+ theme override), `short` | yes |
| Team coach (line under name) | `teams.coach` | **new** |
| Team Locker Room pill | `games.home_locker`, `games.away_locker` (per game, ≤8 chars) | **new** |
| LIVE + score + period + clock | game `status=active`, `history.present` scores/period/clock | yes |
| UP NEXT + tip-off time | earliest `scheduled` game today per court (`data-bind=time`) | data yes; lobby `next` selection new |
| Cheer squad name | `games.cheer` (one per game) | yes |
| Cheer coach | `games.cheer_coach` | **new** |
| Cheer Locker Room | `games.cheer_locker` | **new** |
| Cheer court + game assignment | implied by the game row the cheer sits on | yes |

## Hooks used in the HTML
`data-court=west|east|full`, `data-slot=now|next`, `data-row=home|away|cheer`, `data-state=live|upcoming`,
`data-bind=header|name|coach|locker|time|clock|home-score|away-score`; empty locker → `.locker[data-empty]` (hidden,
column kept so names stay centered). Coaches only in the lobby payload; never in `forRole('score')` (plan).

## Differences from the plan (to settle with Devon)
1. Slot name: plan says `data-slot="now|next"`, the relay said `live|next`. Mockup uses the plan's **`now`**; state says `live`.
2. Extra binds the plan didn't list: `clock`, `home-score`, `away-score` (and a period label beside the clock).
3. Empty locker: plan hides it; mockup uses `visibility:hidden` (keeps the column) rather than removing it.
4. `data-state="empty"` (court with nothing live/next) isn't drawn in these two scenes; CSS would show a quiet "No game" row.

## Design choices
- Season colors vs slides: Home row = season Gold #FFC72C (slides' gold brightened to the season value), black text 13.5:1.
  Away row = black like the slides, with a Maroon #800000 rim and maroon ring on the AWAY pill (white text 21:1).
- Cheer row = the slides' pink (#F47CC6, black text 9.3:1): cheer belongs to neither team, so not a season color.
- Status never color-only: "● LIVE" + red tag + score/clock; "🕒 UP NEXT" + "Tip-off 12:00 PM".
- Fonts: header Anton (grey fill, black outline, like the slides' condensed caps); rows Montserrat 800/900
  (closest available to the slides' rounded sans). Court tabs are the slides' skewed parallelograms (West black, East grey).
- UP NEXT rows line up across West/East whether or not a court has a cheer squad.

## Open questions for Aaron
1. Multiple coaches per team (head + assistant)? Plan: one free-text field ("Smith / Jones"); the line fits ~30 chars.
2. Default locker per team (`teams.default_locker`) to pre-fill each game, or always set per game?
3. (from the plan) Is the cheer coach per squad (same coach every game) → `cheer_squads` table, or per-game text OK?
