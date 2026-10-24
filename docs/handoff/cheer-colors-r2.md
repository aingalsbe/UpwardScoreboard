# Cheer colors — Round 2 (handoff for Grok Build)

Branch: `feature/cheer-colors` at 59d0882. Round 1 package: `docs/handoff/cheer-colors.md` (read it for architecture).

## Rules for grok (hard)
- Do NOT commit, push, or touch git history. Do NOT touch `.env*`, `compose.yaml`, `docker-compose.yml`, Docker containers or volumes, or the running DB.
- Edit ONLY the allowed files below. Keep changes small; match the existing style.
- Do not change the practice underline behavior (it keeps alternating as is).
- When done, run `npm run build` and `node --test dist/test/cheer-colors.test.js`, then stop and summarize.

## Allowed files
1. `src/server.ts`
2. `src/db.ts`
3. `src/color.ts`
4. `public/season.js`
5. `public/lobby.css`
6. `public/admin.js`
7. `public/admin.css`
8. `public/admin.html`
9. `test/cheer-colors.test.ts`
10. `scripts/cheer-colors-e2e.mjs`

## Fixes

### F1 (blocker, Avery R22): dimmed "next" cheer row contrast
`public/lobby.css` has `.cheer-band.next .row.cheer { filter: brightness(.82); }`. It darkens the row AFTER its text
color (`--season-cheer-primary-fg`) was picked, so mid-tone Cheer Primary colors drop under 4.5:1.
Fix: remove that filter and dim the next cheer row in a way that does not change the background or text colors
(e.g. smaller size/width, a dashed/thinner border, or opacity on a non-text decoration). Do not use filter/opacity on the
row or its text. (Alternative allowed: compute fg against the dimmed color in BOTH server.ts and season.js — but the
CSS-only fix is preferred.)

### F2 (Avery P3a): sanitize bad cheer values from the DB
If `season_cheer_primary` / `season_cheer_secondary` in settings is not a valid hex (e.g. `nope`), `loadSeason()` in
server.ts must fall back to season light / dark respectively (same as season.js), so `GET /api/settings/season` and the
injected `<style id="season-vars">` first paint never carry an invalid value.

### F3 (Avery P3b): `seed-demo --reset` resets cheer colors
`seedDemo('reset')` in db.ts must overwrite season_cheer_primary=#FFC72C and season_cheer_secondary=#800000 (upsert
DO UPDATE) together with light/dark. `if-needed` mode keeps DO NOTHING.

### F4 (Sage 1 / Avery P3c): admin cheer swatch sample text follows auto text color
In `seasonCheck()` (admin.js) set `--sample-fg` on each cheer `.season-swatch` to `#000` or `#fff` from the same
black/white pick used for the contrast row. CSS: `.season-swatch.cheer .swatch-sample{color:var(--sample-fg,#111);text-shadow:none}`.

### F5 (Sage 2): primary vs secondary warning
When contrast(Cheer Primary, Cheer Secondary) < 1.5, the season check shows a row:
`⚠ Cheer primary vs secondary only N:1 — practice cards will look the same.` (N with the existing ratio formatter).

### F6 (Sage 3): white-swap info row
When a cheer color is replaced by white on the black practice cards (on-dark rule: color-on-black < 4.5:1), show an info
row, e.g. `ℹ Cheer secondary #800000 is only 1.9:1 on the black practice cards — shown as white there.`

### F7 (Sage 4): lobby cheer row cue
`.row.cheer` gets `border: .4rem dashed var(--season-cheer-primary-fg)` so it is distinct from the gold HOME rows. Must not
change any text/background contrast.

## Acceptance criteria
- AC1: No `filter`/`opacity` applies to `.row.cheer` (now or next) or its text in lobby.css.
- AC2: With Cheer Primary #FF00AA, #777777 and #7A7A7A, the lobby's NEXT cheer row has ≥4.5:1 for the "Locker Room"
  label and the locker pill number against their actual rendered backgrounds (and the now row too).
- AC3: cheer-colors-e2e adds the mid-tone check. Repro: `SCOREBOARD_TEST_NOW=2026-10-31T13:05:00Z`, demo reset, start
  games 4 and 5 so the 09:00 cheer slot is "next", set Cheer Primary to each of the three colors via PUT
  /api/settings/season, measure computed colors in the browser (walk ancestors for the effective background), assert ≥4.5.
  Restore the season afterwards.
- AC4: A stored invalid cheer value (e.g. `nope`) makes GET /api/settings/season return light/dark for that field, and the
  HTML `season-vars` style contains the fallback, never `nope`. Unit test (DB-backed, skip without TEST_DATABASE_URL).
- AC5: `seedDemo('reset')` resets both cheer colors to #FFC72C/#800000; `if-needed` does not overwrite. Unit test (DB).
- AC6: Admin cheer swatch sample text color = the auto pick (#000/#fff); no text-shadow.
- AC7: Admin shows the ⚠ primary-vs-secondary row when ratio < 1.5 and not otherwise.
- AC8: Admin shows the ℹ white-swap row for a cheer color with < 4.5:1 on black (e.g. #800000) and not for e.g. #FFC72C.
- AC9: Lobby `.row.cheer` has a .4rem dashed border in `--season-cheer-primary-fg`; contrast unchanged.
- AC10: Round-1 ACs still hold; practice underline unchanged; basketball practice unchanged.
- AC11: `npm run build` clean; all unit tests pass (with DB); e2e smoke, colors, cheer-colors, cheer-admin, flow,
  admin-today, lockout, offline pass.

## Tests to add
- test/cheer-colors.test.ts: AC4, AC5 (DB), plus a pure check that the lobby.css has no filter on `.row.cheer` and has the
  dashed border rule (AC1/AC9).
- scripts/cheer-colors-e2e.mjs: AC2/AC3 mid-tone check; AC6–AC8 admin checks if cheap.

## Commands
`npm run build`, `node --test dist/test/cheer-colors.test.js`. (On Windows, pass files, not the dist/test directory.)
