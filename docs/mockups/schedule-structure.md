# Lobby schedule TV: proposed markup (Sage → Devon)
Route `/upwardbasketballscores/schedule`, 1920x1080. Mockup: `schedule-mockup.html` / `.png`. Styles come from a future `public/schedule.css` (Sage).

```html
<html data-conn="online|offline|connecting" data-day="sat|fri">   <!-- JS sets both -->
<body data-role="schedule">
  <header class="top">
    <div class="brand"><span data-bind="brand">LBC Upward</span><small data-bind="church-name"></small></div>
    <div class="day" data-bind="day">Saturday, Oct 24</div>
    <span class="conn" data-bind="connText">● Live</span>
  </header>
  <div class="split heads"><h2 class="court-head">West Court</h2><h2 class="court-head">East Court</h2></div>
  <div class="earlier" data-bind="earlier"></div>                 <!-- "▲ 6 earlier finals"; empty = hidden -->
  <main class="sched-view">
    <div class="sched-track" data-page="0" style="--offset: 0px">   <!-- JS sets --offset + data-page -->
      <div class="split">                                         <!-- omitted on Fridays (Full only) -->
        <section class="court-col" data-court="west">
          <div class="slot" data-time="11:00">
            <article class="game" data-state="active" data-winner="">   <!-- + .has-cheer if squad -->
              <span class="time" data-bind="time"></span>
              <div class="body">
                <div class="grade-label" data-bind="grade-label">3rd Grade Girls</div>
                <div class="teams">
                  <span class="chip home" data-bind="home-name"></span>      <!-- home ALWAYS first/left -->
                  <span class="score"><b data-bind="home-score"></b><i>–</i><b data-bind="away-score"></b></span>
                  <span class="chip away" data-bind="away-name"></span>
                </div>
                <div class="cheer"><img class="cheer-logo" data-bind="cheer-logo" alt="" hidden><span data-bind="cheer"></span></div>
              </div>
              <div class="side"><span class="status-tag" data-bind="status-tag"></span>
                <span class="pc"><span data-bind="period"></span> <span data-bind="clock"></span></span></div>
            </article>
          </div> …
        </section>
        <section class="court-col" data-court="east"> … </section>
      </div>
      <div class="full-row"><div class="slot" data-time="4:30">
        <article class="game" data-state="upcoming" data-span="full"> …same children… </article>
      </div></div>
    </div>
  </main>
  <footer class="foot"><i class="on"></i><i></i></footer>   <!-- one <i> per page -->
</body>
```

## Attributes / classes JS must set
- `.game[data-state]`: `complete | active | upcoming`. `[data-span="full"]` on Full Court games (inside `.full-row`).
- `.game[data-winner]`: `home | away | tie` on complete games (winner chip stays solid + ★, loser chip goes outline).
- `.score` only for active/complete; for upcoming render `<span class="score vs">vs</span>`.
- `status-tag` text: `✓ FINAL`, `● LIVE`, `🕒 UP NEXT` (first upcoming), else `🕒 <time>`. Icon + word, never color alone.
- `period`/`clock` only for active. Cheer = ONE squad per game: add `.has-cheer` to the article; logo optional (1em).
- Season colors: root `--season-light` / `--season-dark` (same as TV). Swap changes colors only, never order.

## Paging / auto-scroll
- CSS: `.sched-track { transform: translateY(var(--offset)); transition: transform .8s }`, none under `prefers-reduced-motion`.
- JS: on each state, set `--offset` = −(top of the slot before the first non-complete game, relative to the track),
  clamped to the track end; set `data-page`, footer dots, `earlier`. If live+next don't fit, page every ~12 s.

## Offline
- Root `data-conn`: `.conn` pill grey + dashed, `.sched-view` dashed frame + slight desaturation (as tv.css).
