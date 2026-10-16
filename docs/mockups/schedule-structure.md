# Lobby schedule TV: markup + paging (Sage ↔ Devon, as built in ad6409f)

Route `/upwardbasketballscores/schedule` (alias `/schedule`, `?day=fri|sat`, `?date=YYYY-MM-DD`), 1920x1080.
Look: `public/schedule.css` (Sage). Logic: `schedule.js` + `schedule-view.js` (Devon). Mockup: `schedule-mockup.html/.png`.

```html
<html data-conn="online|offline|connecting" data-day="sat" data-date="…" data-phase="early|midday|end"
      data-page="0" data-pages="1" class="overflows? has-active? no-games?" style="--offset;--page">
<body data-role="schedule">
  <header class="top"> brand · church-name · day · <span class="conn" data-bind="connText"> </header>
  <div class="split heads">West Court | East Court</div>          <!-- hidden when the day has no split games -->
  <div class="sched-pinned">                                      <!-- live + UP NEXT only; never translated -->
    <div class="split"><section class="court-col" data-court="west"><div class="slot" data-time="…">…game…</div></section>…</div>
    <div class="full-row"><div class="slot">…game[data-span=full]…</div></div>
  </div>
  <main class="sched-view">                                       <!-- the paged frame -->
    <div class="sched-track" data-page data-offsets="0,…" style="--offset">   <!-- ONLY this moves -->
      …later upcoming blocks (.split / .full-row)…
      <div class="earlier" data-bind="earlier">▲ N earlier finals</div>
      …recent finals blocks, each .game[data-compact="true"]…
    </div>
    <p class="empty" hidden></p>
  </main>
  <footer class="foot"><i class="on"></i><i></i></footer>         <!-- one <i> per page; empty if 1 page -->
```

```html
<article class="game has-cheer?" data-state="complete|active|upcoming" data-winner="home|away|tie"
         data-next="true"? data-span="full"? data-compact="true"? data-swapped data-game-id data-court>
  <span class="time" data-bind="time"></span>
  <div class="body">                                              <!-- display:contents in CSS -->
    <div class="grade-label" data-bind="grade-label"></div>
    <div class="teams"><span class="chip home" data-wear style="--team-color;--team-fg"></span>  <!-- home ALWAYS first -->
      <span class="score"><b data-bind="home-score"></b><i>–</i><b data-bind="away-score"></b></span>  <!-- or .score.vs -->
      <span class="chip away" …></span></div>
    <div class="cheer"><img class="cheer-logo" data-bind="cheer-logo" hidden><span class="cheer-name" data-bind="cheer"></span></div>
  </div>
  <div class="side"><span class="status-tag" data-bind="status-tag"></span><span class="pc">period clock</span></div>
</article>
```

## Layout rules (CSS)
- Game grid: `time | grade | cheer…` over `time | teams | tag`; the tag is its own column, so no tag can cover names.
  Cheer may run above the tag; live games: tag + clock span both lines. Fixed rows: 127px, compact finals 72px.
- Chips: `background: var(--team-color, wear)`, `color: var(--team-fg, wear fg)` (Contrast.bestText). Swap = colors only.
- Status never color-only: ✓ FINAL / ✓ FINAL · TIE / ● LIVE / 🕒 UP NEXT / 🕒 time + frame (dashed final, white live).
  Winner chip solid + ★; loser chip outline + stripe in its color.
- West/East slots line up within a block; empty slots only in the track (pinned omits them).

## Paging (schedule-view.js)
- Pinned: every live game + the first upcoming per court (UP NEXT). Never moves; never inside the track.
- Track: later upcoming (time order), then `.earlier`, then the most recent finals that fit (compact);
  older finals collapse into the `▲ N earlier finals` count.
- Pages: offsets in `data-offsets`; every ~12 s JS sets `--offset` + `data-page` (root + track) and the foot dots.
  `data-pages="1"` and no dots when nothing overflows. CSS animates `transform` (.8s), none under reduced motion.
- `data-phase`: early (no finals) · midday · end (all final: nothing pinned, finals fill the screen).

## Offline
- Root `data-conn`: grey dashed `.conn` pill; dashed frame + slight desaturation on `.sched-view` and `.sched-pinned`; clocks freeze.
