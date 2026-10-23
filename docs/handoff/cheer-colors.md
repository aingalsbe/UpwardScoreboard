# Handoff: Season cheer colors (Cheer Primary / Cheer Secondary)

Author: Devon (Sr Developer) · Brief: Morgan (PM, priority high) · Base: origin/main 28f3148 · Branch: feature/cheer-colors
This file is both the architecture/AC package for QA (Avery) and the prompt file for the headless Grok Build run.

## 0. Rules for the implementer (Grok) — read first
1. Work ONLY in the files listed in section 3. Do not create, edit, rename or delete anything else.
2. Do NOT `git commit`, do NOT `git push`, do not create branches, do not stash. Leave all changes uncommitted in the working tree.
3. Do NOT read, edit or write `.env`, `.env.*`, `compose.yaml`, `docker-compose.yml`, or anything under Docker volumes. Do not run `docker` or `docker compose` at all (no up/down/restart). Do not connect to any database.
4. "Prisma migration": this repo does NOT use Prisma. Schema/data migrations are idempotent SQL functions in `src/db.ts` called from `migrate()` (see `migrateColors`). Add the migration that way (section 2.2). Do not add Prisma or any dependency; do not change package.json / package-lock.json.
5. Run the unit tests with `npm test` (it runs `tsc -p .` then `node --test dist/test/`). DB-backed tests skip without TEST_DATABASE_URL; that is expected. Do not set TEST_DATABASE_URL. Fix any TypeScript errors and any failure you caused.
6. Keep the existing code style (compact, comments explain WHY, Aaron/Sage notes). Don't reformat untouched code.
7. Shell commands you may run (others are not approved in this headless run and will end it): `npm ci` (node_modules is not installed yet), `npm test`, `npm run build`, `node ...`, `npx tsc ...`, `git status`, `git diff`, `git log`. Use your file edit tools for all file changes.
8. Finish with a summary: every changed/added file with a one-line description, and the `npm test` result (tests / pass / fail / skipped counts).

## 1. Background (what exists today)
- Stack: Node 20 + TypeScript (`src/`), plain `pg` (no ORM), Postgres; plain-JS display pages in `public/`.
- Season colors: settings rows `season_name`, `season_dark`, `season_light` (uppercase `#RRGGBB`, canonicalised by `migrateColors()` in `src/db.ts`).
- `src/server.ts`: `let season = { name, dark, light }`, `loadSeason()`, `GET/PUT /api/settings/season` (PUT validates via `color()` / `normHex`, requires dark darker than light), `GET /api/public/season`, `seasonMsg()` + `broadcastSeason()` on the `role=season` WebSocket, `seasonStyle()` which injects `<style id="season-vars">` (vars `--season-light/-dark`, `-fg` = black/white by WCAG, `-on-dark` = the color if >= 4.5:1 on black else white) into every HTML page before `</head>`.
- `public/season.js`: role=season socket; `apply(s)` sets the same vars live on `<html>` and fires window `season`.
- Admin (`public/admin.html` + `admin.js`): `#season-form` with a swatch (`input[type=color][data-hex-for=...]`) + hex box per color, `seasonCheck()` contrast panel, submit -> PUT.
- Cheer today uses tints of the season light: lobby `lobby.css` `--pink: color-mix(season-light 45%, #fff)` on `.row.cheer`; practice `practice.css` `--pink`/`--teal` (tints of light/dark) on `.card.pink/.card.teal`; court TV `tv.css` `.cheer` is a neutral white-on-dark line in the center column.

## 2. Architecture
### 2.1 Data
Two new settings rows: `season_cheer_primary`, `season_cheer_secondary` (uppercase `#RRGGBB`).
Season object everywhere (API, WS, server memory) becomes:
`{ name, dark, light, cheerPrimary, cheerSecondary }` (camelCase keys; values uppercase #RRGGBB).

### 2.2 Migration + defaults (decision)
DEFAULT CHOICE: Cheer Primary = the season LIGHT color, Cheer Secondary = the season DARK color, written once by a migration (stored rows, not a null fallback), so admin always shows real values.
- Add `export async function migrateCheerColors(): Promise<number>` in `src/db.ts`, called in `migrate()` AFTER `migrateColors()`:
  `INSERT INTO settings(key, value) SELECT 'season_cheer_primary', value FROM settings WHERE key='season_light' ON CONFLICT (key) DO NOTHING` and the same for `season_cheer_secondary` from `season_dark`. Idempotent; never overwrites an admin-set value; returns rows inserted.
- Extend `migrateColors()` key list to also canonicalise `season_cheer_primary`, `season_cheer_secondary`.
- Demo seed (`src/db.ts`, the `season_name/season_dark/season_light` seed list ~line 424): also seed `season_cheer_primary` '#FFC72C' and `season_cheer_secondary` '#800000' (ON CONFLICT DO NOTHING like the others).
- Defensive fallback in `loadSeason()`: if a cheer row is missing, cheerPrimary = light, cheerSecondary = dark.

### 2.3 Shared helpers (`src/color.ts`, pure, unit-testable)
Add and export:
- `lumHex(h)` WCAG relative luminance; `fgFor(h)` -> '#000000' if lum > 0.179 else '#FFFFFF'; `onDarkFor(h)` -> h if (lum+0.05)/0.05 >= 4.5 else '#FFFFFF'.
- `seasonCss(s)` -> the full `<style id="season-vars">:root{...}</style>` string. It MUST start exactly like today (`--season-light:..;--season-dark:..;--season-light-fg:..;--season-dark-fg:..;--season-light-on-dark:..;--season-dark-on-dark:..`) and then append `;--season-cheer-primary:..;--season-cheer-secondary:..;--season-cheer-primary-fg:..;--season-cheer-secondary-fg:..;--season-cheer-primary-on-dark:..;--season-cheer-secondary-on-dark:..`. Invalid hex -> '#808080' (same as today's `ok()`).
`server.ts` `seasonStyle()` becomes a call to `seasonCss(season)` (keep the existing `lum` used for PUT validation, or switch it to `lumHex`).

### 2.4 Server (`src/server.ts`)
- `season` default adds `cheerPrimary: '#FFC72C', cheerSecondary: '#800000'`; `loadSeason()` reads the two new keys and maps `season_cheer_primary` -> `cheerPrimary`, `season_cheer_secondary` -> `cheerSecondary` (the current `r.key.slice(7)` trick does not produce camelCase: map explicitly).
- `PUT /api/settings/season`: accepts optional `cheerPrimary`, `cheerSecondary` (#RGB / #RRGGBB any case, via the same `color()`/`normHex` path). Omitted/undefined -> keep the current value. Present but invalid -> 400 with `COLOR_HELP` naming the field. No ordering rule between them. Stores uppercase, then the existing `loadSeason(); refreshAllCourts(); broadcastSeason(); scheduleChanged();`.
- `GET /api/settings/season`, `GET /api/public/season`, `seasonMsg()` automatically carry the new fields (they spread `season`).
- Home/away logic (`teamView`, `color`, `accent`) is NOT changed.

### 2.5 Client
- `public/season.js`: `apply(s)` also sets `--season-cheer-primary`, `--season-cheer-secondary`, their `-fg` and `-on-dark` vars (same `fg`/`onDark` functions) and `data-season-cheer-primary/secondary` on `<html>`; change detection must include the cheer colors (a cheer-only change must re-apply). If a cheer value is missing/invalid, fall back to light (primary) / dark (secondary). `detail` includes cheerPrimary/cheerSecondary. Update the header comment.
- Admin: in `#season-form` add two swatch blocks after Light, same markup pattern as dark/light: label "Cheer primary" (`id="season-cheer-primary"`, `data-hex-for="cheerPrimary"`, hex input `name="cheerPrimary"`) and "Cheer secondary" (`id="season-cheer-secondary"`, `data-hex-for="cheerSecondary"`, `name="cheerSecondary"`), classes `season-swatch cheer`. `admin.js`: prefill both in `loadSeason()` via `setHex` with the touched-guard; send both in the PUT body; `seasonCheck()` adds two info rows "Text on cheer primary (auto black|white): N:1 ✔" (and secondary) and treats an invalid cheer hex as a ⚠ row. The existing `data-hex-for` swatch<->hex sync must work for the new fields (it is generic; verify). Optional small CSS in admin.css for `.season-swatch.cheer`.
- Lobby (`public/lobby.css`): the cheer bar/rows use Cheer Primary: `.row.cheer` background `var(--season-cheer-primary)`, text `var(--season-cheer-primary-fg)`; `.cheer .locker`, `.cheer .side` = background `var(--season-cheer-primary-fg)`, color `var(--season-cheer-primary)`; `.cheer .coach`, `.cheer .row-note` = `var(--season-cheer-primary-fg)`. Do it by redefining `--pink` to `var(--season-cheer-primary)` and replacing the hard-coded `#000` text on cheer with the fg var (add a marked block at the end: `/* SAGE: cheer colors (Morgan brief) ... */`). Home/away rows unchanged.
- Court TV (`public/tv.css`): `.cheer` becomes a bar in Cheer Primary: background `var(--season-cheer-primary)`, color `var(--season-cheer-primary-fg)`, padding/radius so it reads as a bar across the center column; keep the reserved height/visibility behaviour and the logo/📣 rules. Overlay is untouched (it has no cheer).
- Practice cheer (`public/practice.css` + `public/practice.js`): cards alternate Primary / Secondary like the PPT. In practice.js change the card classes from `pink`/`teal` to `primary`/`secondary` (k even = primary, odd = secondary). CSS: `.card.primary .room` background `var(--season-cheer-primary)`, color `var(--season-cheer-primary-fg)`; `.card.primary .team, .card.primary .coach` color `var(--season-cheer-primary-on-dark)`; `.card.primary .team` underline (border-bottom) `var(--season-cheer-secondary-on-dark)`; mirror for `.secondary`. `body.cheer h1` color `var(--season-cheer-primary-on-dark)`. Keep `.pink/.teal` rules working (alias) or remove them consistently.
- Practice basketball: NO cheer content (confirmed in the PPT and mockups). It stays on season light/dark; do not change it.
- Everything else (score, overlay, schedule, admin chrome, QR) stays on home/away season colors.

## 3. Files allowed to change
Modify: `src/color.ts`, `src/db.ts`, `src/server.ts`, `public/season.js`, `public/admin.html`, `public/admin.js`, `public/admin.css`, `public/lobby.css`, `public/tv.css`, `public/practice.css`, `public/practice.js`.
Add: `test/cheer-colors.test.ts`, `scripts/cheer-colors-e2e.mjs`.
Read-only: everything else, including this file, `test/colors.test.ts`, `scripts/colors-e2e.mjs`, `scripts/run-e2e.sh`.
Forbidden: `.env*`, `compose.yaml`, `docker-compose.yml`, `Dockerfile`, `package*.json`, Docker volumes, git operations that write (commit/push/branch/stash/reset/checkout).

## 4. Acceptance criteria (Avery QA)
AC1 Migration: on startup of a DB that has season_light/dark but no cheer rows, `season_cheer_primary` = season_light and `season_cheer_secondary` = season_dark (uppercase). Running migrate() again changes nothing; an admin-set cheer value is never overwritten.
AC2 Canonical storage: `migrateColors()` uppercases legacy cheer values (e.g. `#ff00aa` -> `#FF00AA`, `rgb(0,128,0)` -> `#008000`).
AC3 API GET: `GET /api/settings/season` and `GET /api/public/season` return `cheerPrimary` and `cheerSecondary` as uppercase #RRGGBB.
AC4 API PUT: `PUT /api/settings/season` with `cheerPrimary: '#f0a', cheerSecondary: '#00ccdd'` -> 200, stored/returned `#FF00AA` / `#00CCDD`. Invalid cheer hex (e.g. `blue`, `#12`) -> 400 and nothing changes. Omitting them keeps the previous values. Existing dark/light validation unchanged.
AC5 Admin UI: Season colors card shows Cheer primary + Cheer secondary, each with a swatch and a hex box; prefilled from the server; typing `#036` in the hex box sets the swatch to `#003366`; Save persists both; contrast panel lists auto text color/ratio for both.
AC6 HTML injection: every HTML page's `<style id="season-vars">` still starts with the existing six vars in the same order and also contains `--season-cheer-primary`, `--season-cheer-secondary`, `-fg` and `-on-dark` for both.
AC7 Contrast: for any cheer color, `--season-cheer-*-fg` reaches >= 4.5:1 on it and `--season-cheer-*-on-dark` reaches >= 4.5:1 on #000 (white fallback), server-side and in season.js.
AC8 Live: saving new cheer colors pushes a `kind:'season'` WS message with the new values; open lobby, court TV and practice/cheer pages update the vars and visible colors with no reload.
AC9 Lobby: cheer rows/bar background = Cheer Primary with the auto fg text; home rows = season light, away rows = season dark (unchanged).
AC10 Court TV: the cheer bar (`.cheer` when `.has-cheer`) background = Cheer Primary, text = its fg; home/away panels unchanged.
AC11 Practice cheer (`/practice/cheer`): card 1,3,5… use Cheer Primary (room pill bg; team/coach text in primary-on-dark), cards 2,4,6… use Cheer Secondary; the header "XXX CHEER" uses primary-on-dark.
AC12 Practice basketball (`/practice/basketball`): unchanged; uses only season light/dark; no cheer colors.
AC13 Fallback: if a cheer row is absent, API/WS/HTML use light (primary) / dark (secondary); season.js applies the same fallback if fields are missing.
AC14 No regressions: `npm test` passes (0 fail); existing e2e `colors-e2e.mjs`, `smoke.mjs`, `cheer-admin-e2e.mjs` still pass.
AC15 Scope: only section 3 files changed; `.env`, compose files untouched; no commit.

## 5. Tests to add
`test/cheer-colors.test.ts` (node:test, same pattern as test/colors.test.ts, imports from `../src/color.js`, `../src/db.js`, `./_server.js`):
- Unit (always run): `fgFor`/`onDarkFor` ratio >= 4.5 for a set of colors (#FFFFFF, #000000, #777777, #FF00AA, #00CCDD, #FFC72C, #800000); `seasonCss()` starts with the legacy six vars in order and contains all six cheer vars; invalid hex -> #808080.
- DB/API (skip unless TEST_DATABASE_URL, own DB name containing "test", like colors.test.ts): AC1 (delete cheer rows, run migrate twice, check values + idempotence + no overwrite), AC2, AC3, AC4, AC6 (season-vars on /upwardbasketballscores/lobby, /practice/cheer, /practice/basketball, /tv/<court>, /admin), AC8 (role=season WS gets new cheer values after PUT).
`scripts/cheer-colors-e2e.mjs` (Playwright via playwright-core, same harness style as scripts/colors-e2e.mjs, BASE_URL / ADMIN_PASSWORD / CHROME_PATH env, prints `  PASS`/`  FAIL` lines and a final `result: N passed, M failed`, exit 1 on any fail; restores the original season at the end):
- Open lobby, `/tv/<court>`, `/practice/cheer?day=mon&at=18:00`, `/practice/basketball?day=mon&at=18:00` and count loads.
- In admin set cheer primary `#FF00AA` and secondary `#00CCDD` via the hex boxes and Save (AC5).
- Assert live (no reload) `--season-cheer-primary` on all pages; lobby `.row.cheer` computed background = rgb(255, 0, 170) if a cheer row exists; TV `.cheer` background; practice cheer card 1 `.room` bg = primary, card 2 `.room` bg = secondary (if >= 2 cards); basketball practice `.court` bg still = season light; TV home/away `--home-color/--away-color` unchanged (AC8–AC12).

## 6. Commands
Implementer (laptop, Windows): `npm test`
Reviewer (box, Postgres on 127.0.0.1:55432):
- `npm ci && npm test`
- `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/scoreboard_cheer_test npm test` (create the DB first)
- `npm run build && scripts/run-e2e.sh smoke.mjs colors-e2e.mjs cheer-admin-e2e.mjs cheer-colors-e2e.mjs`
