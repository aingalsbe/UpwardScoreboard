# Combined Grade Bands & Lady Mascot Names — Round 3 Handoff (`feature/combined-grades`)

## Summary of Round 3 Fixes (Avery R23b)

### 1. [P2-a] Genuine mascot illustrations for all 8 new `deliverables/logos/teams/3rd-4th-grade-*` PNGs
- Generated 8 distinct cartoon mascot illustrations (`512×512` PNG, `<= 300 KB`, solid `#000000` background, Upward season palette `#FFC72C` / `#800000` / `#FFFFFF` / `#000000`, bold vector outlines, no text) for the 8 new 3rd-4th Grade mascots:
  - `deliverables/logos/teams/3rd-4th-grade-boys-panthers.png` (`79,008` bytes, SHA-256 `fc6cf90c8965560e...`) — cartoon black/maroon panther cub with golden-yellow headband holding a basketball.
  - `deliverables/logos/teams/3rd-4th-grade-boys-knights.png` (`102,048` bytes, SHA-256 `81df867bc1d4cfd6...`) — cartoon medieval knight in white/gold armor & maroon/gold plumed helmet holding a basketball.
  - `deliverables/logos/teams/3rd-4th-grade-boys-warriors.png` (`86,981` bytes, SHA-256 `4929ce6bb08e99ed...`) — cartoon Spartan warrior in golden Corinthian helmet with maroon/white crest holding a basketball.
  - `deliverables/logos/teams/3rd-4th-grade-boys-falcons.png` (`99,381` bytes, SHA-256 `24c1ab50596b22ec...`) — cartoon peregrine falcon with maroon/white plumage & golden headband holding a basketball.
  - `deliverables/logos/teams/3rd-4th-grade-girls-jaguars.png` (`111,702` bytes, SHA-256 `60e260c2d77d2490...`) — cartoon golden-yellow spotted jaguar with maroon rosette spots & headband holding a basketball.
  - `deliverables/logos/teams/3rd-4th-grade-girls-blaze.png` (`93,573` bytes, SHA-256 `82ba80c2bce11138...`) — cartoon upright dancing golden/maroon flame character holding a basketball.
  - `deliverables/logos/teams/3rd-4th-grade-girls-storm.png` (`74,913` bytes, SHA-256 `33f9c66ea97a9ae3...`) — cartoon storm cloud & swirling vortex character with golden headband holding a basketball.
  - `deliverables/logos/teams/3rd-4th-grade-girls-thunder.png` (`104,848` bytes, SHA-256 `d6c266d08eb7cb0b...`) — cartoon golden/maroon thunderbird mascot holding a basketball.
- Added a regression test in `test/combined-grades.test.ts` asserting that all 8 `3rd-4th-grade-*` PNGs are `<= 300 KB` and have unique SHA-256 hashes that do not match any other PNG in `deliverables/logos/teams/`.

### 2. [P2-b] Fit 17-char `Lady Timberwolves` and all `Lady <Mascot>` names on `/tv/<court>`, `/tv/split`, and `/lobby` across all viewports
- **`public/tv.css`:**
  - Base `.name`: `font-size: 2.25rem; letter-spacing: .02rem;` (so 17-char `LADY TIMBERWOLVES` measures `531px <= 545px` at `1920×1080`, `398px <= 409px` at `1440×900`, and `270px <= 305px` on `/tv/split` at `1920×1080` / `222px <= 305px` at `1440×900`).
  - `@media (max-aspect-ratio: 5/4)` `.name`: `font-size: 1.9rem; letter-spacing: .01rem;` (so on `/tv/split` at `1280×1024`, where `.name` is `260px` wide, `LADY TIMBERWOLVES` measures `245px <= 260px`, `LADY CARDINALS` `196px`, `LADY BLUEBIRDS` `193px`, `LADY MUSTANGS` `193px`, and `LADY LIGHTNING` `191px`).
- **`public/lobby.css`:**
  - `.who .name`: `3.7rem`; `.game.next .who .name`: `3.1rem`; `main.split .band.now .who .name`: `2.8rem`; `main.split .band.next .who .name`: `2.8rem` (so `Lady Timberwolves` measures `290px <= 295px` on `/upwardbasketballscores/lobby` at `1920×1080`, `1440×900`, and `390×844`).

### 3. [P3] `loadLogos(pool)` on an upgraded `f6c4bc1` 44-team DB returns `unmatched.length === 0`
- **`src/logo-files.ts`:**
  - Updated `run()` to perform a two-pass match: Pass 1 claims all exact `mascot|division` matches in `seen` first; Pass 2 runs `fallback` for remaining rows and claims an unclaimed entry in the row's division, `'kindergarten'`, or any remaining unclaimed manifest slot when a fallback mascot is shared across divisions.
  - Added `assert.deepEqual(rep.teams.unmatched, [])` to the 44-team `f6c4bc1` upgrade test in `test/combined-grades.test.ts`.
