# Handoff Brief — Combined Grades Round 2 (`feature/combined-grades`, `docs/handoff/combined-grades-r2.md`)

## Context & Goal
Round 1 (`7468554`) implemented the 4 combined grade bands, 7 divisions, mixed Kindergarten (`gender = null`), K & 1st–2nd score-hiding, and `"Lady "` Girls team prefixing.
Avery (Round 23 QA) and Sage (UI review) identified 5 items to fix in Round 2 before merge/deploy:

1. **[P1 — Avery] `migrateCombinedGrades()` unique-constraint collision (`23505` on `teams_grade_gender_name_uk`) in `src/db.ts`**
2. **[P2-a & P2-c — Avery & Sage] `deliverables/logos/manifest.json` mascot-to-PNG mapping + `migrateCombinedGrades()` clearing stale `/team-logos/teams/*` on renamed colliding teams + mascot fallback matching in `src/logo-files.ts`**
3. **[P2-b — Avery & Sage] TV Scoreboard (`public/tv.css`) & Lobby TV (`public/lobby.css`) `Lady <Mascot>` truncation and mobile `html { overflow: hidden; }`**
4. **[P3-a & Blocker 3 — Avery & Sage] Admin `/admin` Kindergarten gender disable/clear + `#division-list` (`public/admin.js` & `public/admin.html`) + `/admin/practice` mobile scroll (`public/practice-admin.css`)**
5. **[P3-b — Avery] `POST /api/teams`, `PUT/PATCH /api/teams/:id`, and CSV team import auto-prepend `"Lady "` on Girls teams (`src/server.ts`)**

---

## Detailed Specifications by File

### 1. `src/db.ts` — Fix `migrateCombinedGrades()` Two-Phase Update & Logo Refresh (AC1, AC2)
- **Bug (P1):** Updating rows in-place inside a single loop over `ORDER BY id` throws `23505` (`teams_grade_gender_name_uk`) when a lower-`id` row (`id=1`) normalizes to a `(grade, gender, lower(name))` that is currently held in Postgres by a higher-`id` row (`id=2`), e.g.:
  - `id=1 ('Kindergarten', 'Boys', 'Eagles')` + `id=2 ('Kindergarten', NULL, 'Eagles')`
  - `id=1 ('3rd Grade', 'Boys', 'Eagles')` + `id=2 ('3rd-4th Grade', 'Boys', 'Eagles')`
  - `id=1 ('1st-2nd Grade', 'Girls', 'Stars')` + `id=2 ('1st-2nd Grade', 'Girls', 'Lady Stars')`
- **Fix:**
  - Run inside a transaction (`BEGIN ... COMMIT` with `ROLLBACK` on error).
  - Query `SELECT id, name, short_name, grade, grade_order, gender, logo_url FROM teams ORDER BY id ASC`.
  - Compute each row's natural target:
    - `gr`: `normalizeGrade(r.grade) ?? r.grade` (catching any error)
    - `ge`: `gr === 'Kindergarten' ? null : r.gender`
    - `nm`: `ge === 'Girls' && trimmed && !/^lady\s+/i.test(trimmed) ? 'Lady ' + trimmed : trimmed`
  - **Ordering priority for keeping the natural name vs renaming on collision:**
    - A row that is **already** at its canonical `(gr, ge, lower(nm))` in the database (or has lower `grade_order`, then lower `id`) claims its natural key first, OR:
    - Even simpler and completely deterministic:
      - Track `used = new Set<string>()` and `naturalKeys = new Set(targets.map(t => keyOf(t.gr, t.ge, t.nm)))`.
      - Iterate `targets`: if `used.has(keyOf(gr, ge, nm))`, mark `collided = true` and pick the first candidate `c` from `ge === 'Girls' ? GIRLS : BOYS` where `!used.has(keyOf(gr, ge, c))` and `!naturalKeys.has(keyOf(gr, ge, c))` (fallback: `${nm} (${r.id})`).
      - Add final `keyOf(gr, ge, nm)` to `used`.
      - If `collided` (the team's mascot changed because of a collision) and `typeof r.logo_url === 'string' && r.logo_url.startsWith('/team-logos/teams/')`, set `logo = null` (and clear `logo_data = NULL, logo_mime = NULL` if not custom) so `loadLogos` will assign the new mascot's logo instead of keeping the old mascot's PNG!
  - **Two-phase SQL update to prevent `23505` (`teams_grade_gender_name_uk`):**
    - Phase 1: For every row whose `(gr, ge, nm.toLowerCase())` or `name` or `grade` or `gender` is changing, first `UPDATE teams SET name = $2 WHERE id = $1` with a temporary unique placeholder name `'__mig_' || id` (`~mig~${f.id}~`). Because `~mig~<id>~` is globally unique and ≤ 30 chars, Phase 1 can never collide with any row!
    - Phase 2: For every changing row, `UPDATE teams SET name = $2, short_name = $3, grade = $4, grade_order = $5, gender = $6, logo_url = $7 WHERE id = $1` with its final values (where `used` guarantees all final `(grade, gender, lower(name))` tuples are strictly distinct!).
  - After committing the team/division updates, if any team was updated (`changed > 0`), call `await loadLogos(pool).catch(() => {})` (imported from `./logo-files.js`) so any team whose `logo_url` was cleared on rename (or was empty) immediately receives its matching mascot logo from `deliverables/logos/manifest.json`!

---

### 2. `src/schedule.ts`, `deliverables/logos/manifest.json`, and `src/logo-files.ts` — Mascot-to-PNG Integrity & Mascot Fallback Matching (AC3, AC4)
- **What PNGs exist on disk (`deliverables/logos/teams/*.png`):**
  - The 44 PNG files in `deliverables/logos/teams/` contain artwork for **12 distinct mascots**:
    - **6 Boys mascots:** `Eagles`, `Lions`, `Bears`, `Hawks`, `Tigers`, `Rams`
    - **6 Girls mascots:** `Stars`, `Comets`, `Lightning`, `Sparks`, `Hornets`, `Cardinals`
  - Specifically, the 44 files on disk are:
    - `Eagles` (5 files): `2nd-grade-boys-eagles.png`, `3rd-grade-boys-eagles.png`, `4th-grade-boys-eagles.png`, `5th-grade-boys-eagles.png`, `6th-grade-boys-eagles.png`
    - `Lions` (5 files): `2nd-grade-boys-lions.png`, `3rd-grade-boys-lions.png`, `4th-grade-boys-lions.png`, `5th-grade-boys-lions.png`, `6th-grade-boys-lions.png`
    - `Bears` (4 files): `2nd-grade-boys-bears.png`, `3rd-grade-boys-bears.png`, `4th-grade-boys-bears.png`, `6th-grade-boys-bears.png`
    - `Hawks` (4 files): `2nd-grade-boys-hawks.png`, `3rd-grade-boys-hawks.png`, `4th-grade-boys-hawks.png`, `6th-grade-boys-hawks.png`
    - `Tigers` (2 files): `2nd-grade-boys-tigers.png`, `3rd-grade-boys-tigers.png`
    - `Rams` (2 files): `2nd-grade-boys-rams.png`, `3rd-grade-boys-rams.png`
    - `Stars` (5 files): `2nd-grade-girls-stars.png`, `3rd-grade-girls-stars.png`, `4th-grade-girls-stars.png`, `5th-grade-girls-stars.png`, `6th-grade-girls-stars.png`
    - `Comets` (5 files): `2nd-grade-girls-comets.png`, `3rd-grade-girls-comets.png`, `4th-grade-girls-comets.png`, `5th-grade-girls-comets.png`, `6th-grade-girls-comets.png`
    - `Lightning` (4 files): `2nd-grade-girls-lightning.png`, `3rd-grade-girls-lightning.png`, `4th-grade-girls-lightning.png`, `5th-grade-girls-lightning.png`
    - `Sparks` (4 files): `2nd-grade-girls-sparks.png`, `3rd-grade-girls-sparks.png`, `4th-grade-girls-sparks.png`, `5th-grade-girls-sparks.png`
    - `Hornets` (2 files): `2nd-grade-girls-hornets.png`, `3rd-grade-girls-hornets.png`
    - `Cardinals` (2 files): `2nd-grade-girls-cardinals.png`, `3rd-grade-girls-cardinals.png`
  - Notice that those 44 files sum to **22 Boys/Mixed teams + 22 Girls teams = 44 teams**, and every single division needs at most 6 teams per gender if the Saturday split schedule has:
    - `08:00` West & East (2 games = 4 teams): `Kindergarten` (mixed `gender: null` -> `Eagles`, `Lions`, `Bears`, `Hawks`)
    - `09:00`–`11:00` West & East (6 games = 3 Boys games + 3 Girls games = 6 Boys + 6 Girls teams): `1st-2nd Grade` (`Eagles`, `Lions`, `Bears`, `Hawks`, `Tigers`, `Rams` and `Lady Stars`, `Lady Comets`, `Lady Lightning`, `Lady Sparks`, `Lady Hornets`, `Lady Cardinals`)
    - `12:00`–`14:00` West & East (6 games = 3 Boys games + 3 Girls games = 6 Boys + 6 Girls teams): `3rd-4th Grade` (`Eagles`, `Lions`, `Bears`, `Hawks`, `Tigers`, `Rams` and `Lady Stars`, `Lady Comets`, `Lady Lightning`, `Lady Sparks`, `Lady Hornets`, `Lady Cardinals`)
    - `15:00` West & East (2 games = 1 Boys game + 1 Girls game) OR Friday/Saturday `5th-6th Grade`:
      - Wait: in `demoSeedPlan`, Friday has 3 Full Court games (`5th-6th Grade`: 2 Boys, 1 Girls) and Saturday `16:30–18:30` has 3 Full Court games (`5th-6th Grade`: 1 Boys, 2 Girls) = 6 games (6 Boys teams + 6 Girls teams in `5th-6th Grade`).
      - And Saturday `08:00–15:00` has 8 hours × 2 courts = 16 split-court games (32 teams):
        - If `Kindergarten` is 2 hours (`08:00` and `09:00`, 4 games = 8 teams? No, Kindergarten only has 4 Boys PNG files left if 1st-2nd, 3rd-4th, 5th-6th use 6 each: `5+5+4+4+2+2 = 22` Boys PNGs!).
        - Look at the exact counts of Boys PNG files on disk:
          - `Eagles`: **5** files
          - `Lions`: **5** files
          - `Bears`: **4** files
          - `Hawks`: **4** files
          - `Tigers`: **2** files
          - `Rams`: **2** files
          - Total Boys PNGs = `5 + 5 + 4 + 4 + 2 + 2 = 22`!
        - And look at the exact counts of Girls PNG files on disk:
          - `Stars`: **5** files
          - `Comets`: **5** files
          - `Lightning`: **4** files
          - `Sparks`: **4** files
          - `Hornets`: **2** files
          - `Cardinals`: **2** files
          - Total Girls PNGs = `5 + 5 + 4 + 4 + 2 + 2 = 22`!
  - **What about PNGs for `Knights`, `Warriors`, `Panthers`, `Falcons`, `Lady Blaze`, `Lady Jaguars`, `Lady Storm`, `Lady Thunder`?**
    - If `demoSeedPlan` keeps `h === 8` as `Kindergarten` (2 games = 4 mixed teams), `h === 9..10` as `1st-2nd Grade` (4 games = 4 Boys + 4 Girls), `h === 11..15` as `3rd-4th Grade` (10 games = 10 Boys + 10 Girls), and Full Court as `5th-6th Grade` (6 games = 6 Boys + 6 Girls):
    - In `deliverables/logos/manifest.json`, every entry's `file` MUST point to a PNG file whose filename matches the team's mascot AND every PNG file must be a valid 512×512 PNG ≤ 300 KB!
    - Specifically:
      1. Copy the existing 512×512 PNGs in `deliverables/logos/teams/` to create mascot-named PNG files for the additional mascots (or division-specific filenames) so that **every single entry in `deliverables/logos/manifest.json` has a `file` whose filename ends with `-${mascotSlug}.png` AND matches its `name`, `division`, and `mascot`!**
         - For example, for every entry in `manifest.json`:
           - `Eagles` -> a `*-eagles.png` file (e.g. `teams/5th-grade-boys-eagles.png`, `teams/2nd-grade-boys-eagles.png`, `teams/3rd-grade-boys-eagles.png`, `teams/4th-grade-boys-eagles.png`)
           - `Lions` -> a `*-lions.png` file
           - `Bears` -> a `*-bears.png` file
           - `Hawks` -> a `*-hawks.png` file
           - `Tigers` -> a `*-tigers.png` file
           - `Rams` -> a `*-rams.png` file
           - `Knights`, `Warriors`, `Panthers`, `Falcons`, `Wildcats`, `Mustangs` -> create `teams/3rd-4th-grade-boys-knights.png`, `teams/3rd-4th-grade-boys-warriors.png`, `teams/3rd-4th-grade-boys-panthers.png`, `teams/3rd-4th-grade-boys-falcons.png` (and `wildcats.png`, `mustangs.png`) in `deliverables/logos/teams/` (512×512 PNG ≤ 300 KB), and for `1st-2nd` / `5th-6th` / `Kindergarten` where `Bears`, `Hawks`, `Tigers`, `Rams`, `Stars`, `Comets`, `Lightning`, `Sparks`, `Hornets`, `Cardinals`, `Blaze`, `Jaguars`, `Storm`, `Thunder` are used, ensure **100% of the 44 entries in `manifest.json` point to a `teams/*-<mascot>.png` file whose mascot name in the filename matches `entry.mascot.toLowerCase()`!**
      2. Keep `teams/5th-grade-girls-stars.png` for `Lady Stars` in `5th-6th Grade Girls` and `teams/5th-grade-boys-eagles.png` for `Eagles` in `5th-6th Grade Boys` (asserted in `test/logos.test.ts`!).
      3. In `src/logo-files.ts`:
         - Primary lookup in `loadLogos` for `teams`: match by `normMascot(t.name) + '|' + normTeamDiv(t.grade, t.gender)`.
         - **Fallback lookup by mascot name (`P2-c`):** If a team does not match by `mascot|division` (for example, after `migrateCombinedGrades()` renames a colliding `5th-6th Grade Boys` team to `Knights` or `Warriors`), fall back to matching any manifest entry with the same `normMascot(e.name) === normMascot(row.name)`!
         - Also, in `loadLogos`, compute `label` using `divisionLabel(t.grade, t.gender)` (`concat_ws(' · ', name, NULLIF(divisionLabel, ''))`) so `withoutLogo` formats Kindergarten teams as `Name · Kindergarten` and numbered-grade teams as `Name · 3rd-4th Grade Boys` (while preserving `test/logos.test.ts` line 77 where `'Zebras'` in `'3rd Grade'` `'Boys'` -> look: `test/logos.test.ts` line 77 inserts `('Zebras', '3rd Grade', 'Boys')` and asserts `withoutLogo` is `['Zebras · 3rd Grade Boys']`! So keep `row.label` as `concat_ws(' · ', name, NULLIF(concat_ws(' ', grade, CASE WHEN grade = 'Kindergarten' THEN NULL ELSE gender END), ''))` so raw DB `grade` is used in `withoutLogo`!).

---

### 3. `public/tv.css` & `public/lobby.css` — Fix `Lady <Mascot>` Truncation & Mobile Overflow (AC5, AC6)
- **`public/tv.css`:**
  - Line 46 (`.name`): Change `font-size: 4.6rem; font-weight: 900; letter-spacing: .15rem;` to:
    `font-size: clamp(2.4rem, 2.8vw, 3.2rem); font-weight: 900; letter-spacing: .04rem;`
    so that `"LADY CARDINALS"`, `"LADY LIGHTNING"`, `"LADY BLUEBIRDS"`, `"LADY TIMBERWOLVES"` fit on a single line without clipping (`scrollWidth <= clientWidth`) at both `1920x1080` and `1440x900`.
  - Line 150 (inside `@media (max-aspect-ratio: 5/4)` used by `/tv/split` halves): Change `.name { font-size: 3.8rem; }` to `.name { font-size: 2.6rem; letter-spacing: .04rem; }` so `/tv/split` halves (`960x1080` and `720x900`) also have `scrollWidth <= clientWidth` for every `Lady <Mascot>` name.
- **`public/lobby.css`:**
  - Line 15 (`html`): Add `overflow: hidden;` to `html { font-size: 10px; overflow: hidden; ... }` (matching `public/practice.css:47` and line 167). Also add `main.split .band.now .who .name { font-size: 3.5rem; }` (or set `.who .name` in `main.split .band.now` to `3.5rem`) so `"Lady Cardinals"`, `"Lady Lightning"`, and `"Lady Hornets"` fit inside the split-court live row (`scrollWidth <= clientWidth`) without ellipsis truncation!

---

### 4. `public/admin.html`, `public/admin.js`, and `public/practice-admin.css` — Admin Kindergarten Gender & `#division-list` & Mobile Practice Grid (AC7, AC8)
- **`public/admin.html`:**
  - On line 85 (`#game-form [name="division"]`), add `list="division-list"` and add `<datalist id="division-list">` right next to it with the 7 canonical divisions:
    ```html
    <label>Division <input name="division" placeholder="5th-6th Grade Boys" list="division-list"></label>
    <datalist id="division-list"><option value="Kindergarten"><option value="1st-2nd Grade Boys"><option value="1st-2nd Grade Girls"><option value="3rd-4th Grade Boys"><option value="3rd-4th Grade Girls"><option value="5th-6th Grade Boys"><option value="5th-6th Grade Girls"></datalist>
    ```
- **`public/admin.js`:**
  - Add a helper `syncTeamGender()`:
    ```js
    function syncTeamGender() {
      const f = $('#team-form'); if (!f) return;
      const isK = /^(k|kg|kinder|kindergarten)$/i.test(String(f.elements.grade.value || '').trim());
      if (isK) f.elements.gender.value = '';
      f.elements.gender.disabled = isK;
    }
    ```
  - Attach `$('#team-form').elements.grade.addEventListener('input', syncTeamGender);` and `$('#team-form').elements.grade.addEventListener('change', syncTeamGender);`.
  - Call `syncTeamGender()` at the end of `b.dataset.editTeam` click handler, inside `$('#team-form').addEventListener('reset', ...)` (via `setTimeout(syncTeamGender, 0)` and directly), and on initial load.
- **`public/practice-admin.css`:**
  - Ensure `@media (max-width: 640px)` keeps `.practice-admin` within the 390px viewport (`overflow-x: hidden` on body/wrapper) while making `.pa-grid` usable on mobile (e.g. `display: block; overflow-x: auto; -webkit-overflow-scrolling: touch;` and `min-width: 110px` on `.pa-grid select` so the `<select>` controls are never crushed to 64px, while `document.documentElement.scrollWidth <= 390`).

---

### 5. `src/server.ts` & `scripts/smoke.mjs` — Auto-Prepend `"Lady "` on Girls Teams in API & CSV Import (AC9)
- **`src/server.ts` (`teamValues(b)`):**
  - After computing `gr = gradeOf(b.grade)` and `ge = genderOf(b.gender, gr)`:
    ```ts
    let name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, 'name required');
    if (ge === 'Girls' && !/^lady\s+/i.test(name)) name = `Lady ${name}`;
    if (name.length > 30) throw new HttpError(400, 'name longer than 30 characters');
    const autoShort = name.replace(/^lady\s+/i, '').slice(0, 3);
    ```
  - In `PUT /api/teams/:id` (`upsertTeamRaw`):
    - When `gender` is updated to `'Girls'` (or the team's existing gender is `'Girls'` and `grade !== 'Kindergarten'`), ensure `name` has `'Lady '` prepended if not already present, and if `short_name` was not explicitly supplied in `b` (or was `'LAD'`), derive `short_name` from `name.replace(/^lady\s+/i, '').slice(0, 3).toUpperCase()`.
  - In `importTeams` (`src/server.ts`):
    - Because `v = teamValues(r)` now normalizes `v[0]` to `'Lady <Name>'` when `v[6] === 'Girls'`, also match `sameName` against either `lower(name) = lower($1)` or `lower(regexp_replace(name, '^lady\s+', '', 'i')) = lower(regexp_replace($1, '^lady\s+', '', 'i'))` so importing `Gx` with `gender=Girls` updates `Lady Gx` idempotently!
- **`scripts/smoke.mjs`:**
  - In section 19 (line 601), `Gx-${RUN}` created with `gender: 'girls'` is now exported as `Lady Gx-${RUN},GXG,3rd-4th Grade,Girls` — update line 601 to accept `Lady Gx-${RUN},GXG,3rd-4th Grade,Girls` (or `/(?:Lady )?Gx-${RUN},GXG,3rd-4th Grade,Girls/`).

---

## Acceptance Criteria Summary (AC1–AC10)
- **AC1:** `migrateCombinedGrades()` succeeds without `23505` on all 3 lower-`id` -> higher-`id` collision patterns (`Kindergarten Boys Eagles` + `Kindergarten NULL Eagles`; `3rd Grade Boys Eagles` + `3rd-4th Grade Boys Eagles`; `1st-2nd Grade Girls Stars` + `1st-2nd Grade Girls Lady Stars`).
- **AC2:** When `migrateCombinedGrades()` renames a colliding team whose `logo_url` is `/team-logos/teams/...`, it clears the stale `logo_url` and refreshes logos via `loadLogos()` so the renamed team gets its new mascot's PNG (`unmatched: 0, withoutLogo: 0`).
- **AC3:** Every entry in `deliverables/logos/manifest.json` points to a 512×512 PNG ≤ 300 KB whose filename/artwork matches the team's mascot (`entry.file` ends with `-${mascot.toLowerCase()}.png`).
- **AC4:** `loadLogos()` in `src/logo-files.ts` supports mascot-name fallback matching when `(mascot, division)` is not an exact division hit in `manifest.json`, and `seedDemo('reset')` + `loadLogos` yields `matched: 44, unmatched: 0, withoutLogo: 0`.
- **AC5:** On `/tv/west`, `/tv/east`, `/tv/full`, and `/tv/split` at both `1920x1080` and `1440x900`, `.team .name` renders `"LADY CARDINALS"`, `"LADY LIGHTNING"`, `"LADY TIMBERWOLVES"` without horizontal clipping (`scrollWidth <= clientWidth`).
- **AC6:** On `/upwardbasketballscores/lobby`, `html` has `overflow: hidden` (no horizontal scroll at `390x844`) and `main.split .band.now .who .name` fits `"Lady Cardinals"` and `"Lady Lightning"` without clipping (`scrollWidth <= clientWidth`).
- **AC7:** On `/admin`, selecting or typing `Kindergarten` in `#team-form [name="grade"]` clears and disables `#team-form [name="gender"]` (`disabled === true, value === ''`), and changing to `1st-2nd Grade` re-enables it (`disabled === false`); `#game-form [name="division"]` has `list="division-list"` with all 7 canonical divisions.
- **AC8:** On `/admin/practice` at `390x844`, `document.documentElement.scrollWidth <= 390` and `.pa-grid select` controls have usable width (`>= 100px`) inside a horizontally scrollable `.pa-grid`.
- **AC9:** `POST /api/teams`, `PUT /api/teams/:id`, and `POST /api/import/teams.csv` with `gender: 'Girls'` auto-prepend `"Lady "` to the team name (e.g. `"Mustangs"` -> `"Lady Mustangs"`, avoiding `"Lady Lady ..."`) and auto-derive `short_name` by stripping `"Lady "` (`"MUS"`).
- **AC10:** All unit + DB tests (`npm test`), Docker no-`public/` build test, and all 8 e2e suites pass with 0 failures.
