# Grok Build handoff: real-season 2027 team logos (LOCAL ONLY)

## (a) Context
- Repo (laptop): `C:\AIProjects\UpwardScoreboard` (path taken from grok-build-queue.md / docs/handoff/real-season-2027.md). Node >=20 / TypeScript (`tsc`, `node --test`), Postgres 16, Docker compose services `app` + `db` (user/db `scoreboard`).
- Base: `feature/real-season-2027` @ `060379e` (= GitHub main). Work on fresh local branch `feature/team-logos`.
- Logo source on laptop: `C:\Users\ainga\Downloads\LBC_Upward_Mascots\` (7 folders `01_Kindergarten` … `07_5th-6th_Grade_Boys`, 52 PNGs + README.txt).
- Mapping: `docs/handoff/team-logos-mapping.csv` (division, logo_file, team key, team_name, match_method). **52/52 logos map to 52/52 teams, all exact** (file stem = team name incl. `Lady `; Kindergarten files prefixed `Kindergarten_`, grade folders prefixed e.g. `3rd_4th_Boys_`). No gaps.
- Why logos are blank today: `deliverables/logos/manifest.json` + `teams/*.png` hold the 44 DEMO mascots; `src/seed-season.ts` (~l.222) deliberately skips logo load for the real season; real team names/divisions don't match the demo manifest.
- Relevant code:
  - `src/logo-files.ts` — `LOGO_DIR=deliverables/logos`, `LOGO_ROUTE=/team-logos/`, `LOGO_MAX_BYTES=300 KB`, `readManifest`, `loadLogos` (matches `normMascot(name)|division`, strips `Lady `; fills only empty `teams.logo_url` unless `--overwrite`), `logoFile` (route regex: `/team-logos/(teams|cheer)/[a-z0-9-]+.png`).
  - `src/load-logos.ts` — CLI: `node dist/src/load-logos.js [--dry-run] [--overwrite]`.
  - `src/db.ts` (~l.278) — auto `loadLogos(pool)` on startup when `needsLogoRefresh`.
  - DB: `teams.logo_url / logo_data / logo_mime`, `cheer_squads.logo_*`. Server payload `src/server.ts` (~l.196–229) → `/logos/<id>` or `logo_url`.
  - Render: `public/logo-badge.js`, `public/lobby.js`/`lobby-view.js` (Lobby), `public/display.js` + `tv.html`/`overlay.html` (court), `public/practice.js` (practice).
  - Tests: `test/logos.test.ts` (asserts **44 teams + 4 cheer, every file 512x512 PNG <= 300 KB**), `test/combined-grades.test.ts` (~l.54–95, manifest/Lady/size checks), `test/scorekeeper-no-logos.test.ts`.

## (b) Goal + acceptance criteria
Goal: every real-2027 team shows its LBC mascot logo wherever a logo slot already exists.
- Avery:
  1. All 52 real teams have a logo after startup/load; loader report `teams: matched 52 … unmatched 0, rows with no manifest logo 0`.
  2. Logos appear on Lobby, court (TV/overlay) and practice screens in the EXISTING slots only; no new UI slots/markup.
  3. Teams/squads with no logo (e.g. cheer squads, any future team) fall back exactly as today.
  4. Season colors rule unchanged: every team uses season colors only; team/manifest colors ignored.
  5. Counts unchanged: 52 teams, 208 games (plus practices/cheer as today).
  6. Demo seed still works (demo manifest/tests intact or updated consistently).
  7. Unit + e2e pass.
- Sage (visual): logos are not distorted/cropped; non-square source art (768x512, 384x512, 384x341) fits square slots (letterboxed, centered); backgrounds are NOT transparent (see image facts) and must look acceptable on dark and light screens; Lobby normal/compact/tight density still fits; cheer grid unaffected.
- Image facts (source): 52 PNGs, mixed sizes: 12× 512x512 (K, 3rd-4th Girls), 8× 768x512 (1st-2nd Girls, 5th-6th Girls), 8× 384x512 (5th-6th Boys), 24× 384x341/342 (1st-2nd Boys, 3rd-4th Boys). Only 12 are already square. Modes: Kindergarten RGBA (alpha 0–254); all others RGB (opaque backgrounds, per README). Sizes 178–494 KB; **20 files exceed the 300 KB `LOGO_MAX_BYTES` limit** (all Kindergarten, 1st-2nd Girls, 3rd-4th Girls, 5th-6th Girls).

## (c) Boundaries
- Allowed: `deliverables/logos/**` (new PNGs + manifest), `src/logo-files.ts`, `src/load-logos.ts`, `src/seed-season.ts` (logo-load step only), logo tests (`test/logos.test.ts`, `test/combined-grades.test.ts` logo assertions, new `test/*logos*.test.ts`), `scripts/` helper for logo conversion if needed.
- Never touch: `.env*`, `compose.yaml`, `docker-compose.yml`, unrelated WIP, UI layout/CSS (unless a strictly necessary sizing fix Sage needs, flag it first).
- No `git commit`, no `git push`, no deploy/droplet/SSH, no `docker compose down`.

## (d) Ordered steps
1. Backup ALREADY DONE by Devon: `C:\Users\ainga\Backups\UpwardScoreboard\pre-team-logos-20261103-174348.dump`. Do NOT run pg_dump, docker, or any DB command. Do NOT rebuild containers (Devon rebuilds). Only edit files, generate padded logo PNGs (python/node), and run build + unit tests.
2. Copy + normalize logos using the mapping CSV: write each to `deliverables/logos/teams/2027-<division-slug>-<mascot-slug>.png` (lowercase `[a-z0-9-]`, e.g. `2027-3rd-4th-grade-girls-lady-bearcats.png`), converted to **512x512 PNG <= 300 KB** (fit inside square, keep aspect, pad; keep alpha for Kindergarten; no cropping of art). Keep demo files untouched.
3. Manifest: keep demo `manifest.json` as is; add a real-season manifest (e.g. `deliverables/logos/manifest-2027.json`, same schema, 52 teams, `name` = exact team name incl. `Lady `, `division` = canonical label, NO colors used). Add a `manifest` option to `readManifest`/`loadLogos`/`load-logos.ts` (`--manifest 2027`), choose the 2027 manifest when the DB holds the real season (e.g. teams match it), and run the 2027 load at the end of `seed-season` and on startup for empty real-team logos. Fill-only-empty semantics unchanged.
4. Tests: extend `test/logos.test.ts` for the 2027 manifest (52 entries, unique, files exist, 512x512, <= 300 KB, every real team in `data/season-2027` matched, unmatched 0); keep the demo 44+4 assertions passing.
5. (Skip: Devon rebuilds with `docker compose up -d --build app` and runs the loader.)
6. Run `npm run build` and the unit tests (section e). No docker, no DB.

## (e) Proof
- `npm run build` then unit under node 24: `node --test "dist/test/*.test.js"` (report pass/fail/skip counts).
- e2e (Devon runs after rebuild; skip): `bash scripts/run-e2e.sh` (or the existing `scripts/*-e2e.mjs` it runs) + `npm run smoke`; report counts or why skipped.
- Report: `git status --short` changed-file list, unit test counts, the 52 generated files (dims/bytes). Devon checks loader/DB counts.
- Leave ALL changes uncommitted for Devon review.

## Run command (laptop, repo root, fresh branch, output logged)
```powershell
cd C:\AIProjects\UpwardScoreboard
git switch feature/real-season-2027; git switch -c feature/team-logos
$ts = Get-Date -Format yyyyMMdd-HHmmss
grok --prompt-file docs/handoff/team-logos-local.md --permission-mode acceptEdits --deny "Bash(git push*)" --deny "Bash(git commit*)" --deny "Edit(.env*)" --deny "Edit(compose.yaml)" --deny "Edit(docker-compose.yml)" --deny "Bash(docker compose down*)" --max-turns 60 --output-format json 2>&1 | Tee-Object "C:\Users\ainga\Backups\UpwardScoreboard\grok-team-logos-$ts.json"
```
(This doc and the mapping CSV must be present in the laptop repo first, e.g. copy from the box branch `feature/team-logos`.)
