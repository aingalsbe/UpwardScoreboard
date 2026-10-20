# Lobby v2 mockup: data needs (aligned with docs/plans/locker-rooms-coaches.md)

Mockups: `saturday-split.html/.png` (West + East, live + next each, plus ONE spanning cheer row for the live slot and a
smaller one for the next slot), `friday-full.html/.png` (one Full Court panel: live + next, no cheer). Every locker pill has a sample value;
the empty-pill rule (`.locker[data-empty]` → hidden) is in `lobby.css` but not demoed.

**Cheer rule (Aaron, 2026-10-16):** cheer is ONE squad per TIME SLOT, shared by West and East (2nd–4th grade Saturday
split-court slots only); some slots have none. Full Court (Friday) never shows cheer.
**Coaches:** first name only on the TV ("Coach Mike").
Shared style: `lobby.css`. All names are SAMPLE DATA.

## Fields the mockup uses → Devon's plan
| Mockup element | Field (plan) | Exists today? |
|---|---|---|
| Header `SATURDAY 11:00 AM` | slot `scheduled_at` formatted in league TZ (`data-bind=header`) | yes (scheduled_at) |
| Court panel / Full Court span | `courts.slug`, `conflicts_with`, lobby `span="full"` logic | slug + conflicts_with yes; lobby selection new |
| Team name (home first) | `teams.name` (+ theme override), `short` | yes |
| Team coach (line under name, first name only: "Coach Mike") | `teams.coach` (store first name, or a `coach_display`) | **new** |
| Team Locker Room pill | `games.home_locker`, `games.away_locker` (per game, ≤8 chars) | **new** |
| LIVE + score + period + clock | game `status=active`, `history.present` scores/period/clock | yes |
| UP NEXT + tip-off time | earliest `scheduled` game today per court (`data-bind=time`) | data yes; lobby `next` selection new |
| Cheer squad name (per time slot) | today `games.cheer` (per game) → see "Cheer model" | partly (per game) |
| Cheer coach (first name) | plan: `games.cheer_coach` → per slot | **new** |
| Cheer Locker Room | plan: `games.cheer_locker` → per slot | **new** |
| Cheer slot assignment (date + time, both courts) | slot = league date + start time | **new** (today per game) |

## Cheer model (per time slot) — options for Devon
- **A. `cheer_slots` table (recommended):** `id, date, start_time, squad, coach, locker, logo_*`, unique `(date, start_time)`.
  The lobby joins the slot of the live games (and of the next games) by league date + time; no duplication, and editing one
  row fixes both courts. CSV: `cheer_slots.csv` with `date,time,squad,coach,locker` (match by date+time; blank clears).
- **B. Keep it on games:** write the same cheer/coach/locker onto both West and East games in the slot (admin writes both;
  import warns if the two disagree). Fewer schema changes, but two copies can drift; the lobby picks the West copy.
- Either way the TV payload gets one `cheer` object per slot (`now`, `next`), not per court; the scorekeeper never gets it.

## Hooks used in the HTML
- **UP NEXT (Aaron, 3:00 PM):** ONE full-width `section.next-bar[data-slot="next"][data-state="upcoming"]` with
  `data-bind="time"` ("UP NEXT · Tip-off 12:00 PM") replaces the per-court UP NEXT tags; next game sections carry no status
  line. Next rows are slightly smaller and dimmed (all text ≥10:1). Friday: next game sits below the bar.
`data-court=west|east|full`, `data-slot=now|next`, `data-row=home|away|cheer` (cheer row sits in a spanning
`section.cheer-band[data-court="both"][data-slot=now|next]`, omitted when the slot has no squad), `data-state=live|upcoming`,
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
- Cheer sits between the live and UP NEXT bands, spanning both courts ("Cheering both courts · 11:00 AM"); the next slot's
  squad is a smaller spanning row at the bottom ("Next cheer · 12:00 PM"). West/East live and next rows stay aligned.

## Open questions for Aaron
1. Multiple coaches per team (head + assistant)? With first names only, "Coach Mike & Dana" fits on the line.
2. Default locker per team (`teams.default_locker`) to pre-fill each game, or always set per game?
3. Cheer model: `cheer_slots` table (A) vs. copies on both games (B)? Does a squad keep the same coach all season
   (then a `cheer_squads` lookup could feed the slot)?
