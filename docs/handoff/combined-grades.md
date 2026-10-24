# Handoff Brief — Combined Grade Divisions, Mixed Kindergarten & "Lady " Girls Teams (`feature/combined-grades`)

## Context & Goal
Update UpwardScoreboard grade/division options, team naming, database migration, seeds, logo matching, CSV templates, and UI across the app to match Aaron's league division structure:

1. **4 Canonical Grade Bands**:
   - `Kindergarten`
   - `1st-2nd Grade`
   - `3rd-4th Grade`
   - `5th-6th Grade`

2. **Exact 7 Basketball Divisions (`divisionLabel(grade, gender)`)**:
   - `Kindergarten` *(Kindergarten is mixed boys and girls — NO Boys/Girls split! `gender` is `null`)*
   - `1st-2nd Grade Boys`
   - `1st-2nd Grade Girls`
   - `3rd-4th Grade Boys`
   - `3rd-4th Grade Girls`
   - `5th-6th Grade Boys`
   - `5th-6th Grade Girls`

3. **K–2nd Score-Hiding / Simplified Scorekeeper Rule**:
   - Both `Kindergarten` and `1st-2nd Grade` trigger the K–2nd score-hiding / simplified scorekeeper rule (`isScoreHiddenGrade` = `true`, `hidesScore(gradeOrder(grade))` = `true`).
   - `3rd-4th Grade` and `5th-6th Grade` show full scores (`isScoreHiddenGrade` = `false`, `hidesScore(gradeOrder(grade))` = `false`).

4. **"Lady " Prefix on All Girls Teams**:
   - All girls teams have `Lady ` in front of their mascot name (e.g. `Lady Stars`, `Lady Comets`, `Lady Bearcats`, `Lady Huskies`).
   - Seeded girls teams (`GIRLS` in `src/schedule.ts`, `demoSeedPlan`, `samples/teams.csv`, `samples/schedule.csv`) must use `Lady <Mascot>`.
   - Auto-derived 3-letter `short_name` for teams starting with `Lady ` should strip leading `Lady ` first (e.g., `Lady Stars` -> `STA`, `Lady Comets` -> `COM`, `Lady Bearcats` -> `BEA`) so girls teams don't all default to `LAD`.
   - Database migration must prepend `Lady ` to any existing `gender = 'Girls'` team whose name does not already start with `Lady ` (case-insensitive).
   - Logo matching (`src/logo-files.ts`) must strip leading `Lady ` and normalize combined/legacy grades so both `Lady Stars` and `Stars` match mascot logos cleanly without losing any logos.

---

## Detailed Specifications by File

### 1. `src/schedule.ts`
- Export canonical constants:
  ```ts
  export const GRADES = ['Kindergarten', '1st-2nd Grade', '3rd-4th Grade', '5th-6th Grade'] as const;
  export const DIVISIONS = [
    'Kindergarten',
    '1st-2nd Grade Boys',
    '1st-2nd Grade Girls',
    '3rd-4th Grade Boys',
    '3rd-4th Grade Girls',
    '5th-6th Grade Boys',
    '5th-6th Grade Girls',
  ] as const;
  export const BOYS = ['Eagles', 'Lions', 'Bears', 'Hawks', 'Tigers', 'Rams', 'Knights', 'Warriors', 'Panthers', 'Falcons', 'Wildcats', 'Mustangs'];
  export const GIRLS = ['Lady Stars', 'Lady Comets', 'Lady Lightning', 'Lady Sparks', 'Lady Hornets', 'Lady Cardinals', 'Lady Blaze', 'Lady Jaguars', 'Lady Storm', 'Lady Thunder', 'Lady Doves', 'Lady Bluebirds'];
  ```
- Update `normalizeGrade(v: unknown): string | null`:
  - Empty / whitespace -> `null`.
  - Kindergarten variants (`K`, `k`, `kg`, `kinder`, `kindergarten`, `Kindergarten Grade`, `Kindergarten Boys`, `Kindergarten Girls`, `K Boys`, `K Girls`) -> `'Kindergarten'`.
  - 1st / 2nd / 1st-2nd variants (`1`, `1st`, `1st Grade`, `Grade 1`, `First`, `First Grade`, `2`, `2nd`, `2nd Grade`, `Grade 2`, `Second`, `Second Grade`, `1-2`, `1-2nd`, `1st-2nd`, `1st–2nd`, `1st/2nd`, `1st-2nd Grade`, `1st–2nd Grade`, `Grades 1-2`, `Grade 1-2`) -> `'1st-2nd Grade'`.
  - 3rd / 4th / 3rd-4th variants (`3`, `3rd`, `3rd Grade`, `Grade 3`, `Third`, `Third Grade`, `4`, `4th`, `4th Grade`, `Grade 4`, `Fourth`, `Fourth Grade`, `3-4`, `3-4th`, `3rd-4th`, `3rd–4th`, `3rd/4th`, `3rd-4th Grade`, `3rd–4th Grade`, `Grades 3-4`, `Grade 3-4`) -> `'3rd-4th Grade'`.
  - 5th / 6th / 5th-6th variants (`5`, `5th`, `5th Grade`, `Grade 5`, `Fifth`, `Fifth Grade`, `6`, `6th`, `6th Grade`, `Grade 6`, `Sixth`, `Sixth Grade`, `5-6`, `5-6th`, `5-6th Grade`, `5th-6th`, `5th–6th`, `5–6th`, `5th/6th`, `5th-6th Grade`, `5th–6th Grade`, `Grades 5-6`, `Grade 5-6`) -> `'5th-6th Grade'`.
  - Single grades 7..12 (`Grade 11`, `7th`, etc.) -> `'7th Grade'..'12th Grade'`.
  - If `t.length > 30`, throw 400 Error. Otherwise return `t`.
- Add `normalizeDivision(v: unknown): string | null`:
  - Empty / whitespace -> `null`.
  - If `v` matches `<grade> [Boys|Girls]` or `<grade>` where `<grade>` normalizes to one of `GRADES`, return `divisionLabel(normGrade, normGender)` (which returns `'Kindergarten'` for any Kindergarten input including `'Kindergarten Boys'` / `'Kindergarten Girls'`, and e.g. `'1st-2nd Grade Boys'` for `'2nd Grade Boys'` or `'1st-2nd Boys'`).
  - Otherwise return trimmed `v` unchanged (so custom game divisions like `'Renamed 123'` or `'Floor 123'` stay intact).
- Update `gradeOrder(g: string | null | undefined): number`:
  - `if (!g) return 100;`
  - `if (g === 'Kindergarten') return 0;`
  - `const n = gradeNumbers(g); if (!n || !n.length) return 99;`
  - `if (n.length === 1) return n[0];`
  - `if (n.length === 2 && n[1] === n[0] + 1) return n[0] === 1 ? 2 : n[0];` (so `'1st-2nd Grade'` -> `2`, `'3rd-4th Grade'` -> `3`, `'5th-6th Grade'` -> `5`; preserves `[1, 2, 2, 2, 0, -1, 3, 99, 100]` for single-grade inputs in `test/round2.test.ts`, and makes `hidesScore(gradeOrder('1st-2nd Grade')) === true` and `hidesScore(gradeOrder('3rd-4th Grade')) === false`!).
- Update `divisionLabel(grade, gender)`:
  ```ts
  export const divisionLabel = (grade: string | null | undefined, gender: string | null | undefined) =>
    grade === 'Kindergarten' ? 'Kindergarten' : [grade, gender].filter(Boolean).join(' ') || null;
  ```
- Update `SeedGame` and `demoSeedPlan(w)`:
  - `SeedGame.gender`: `'Boys' | 'Girls' | null` (`null` for `Kindergarten`).
  - Keep the 22 games (44 teams, each playing once):
    - Friday Full Court (`17:30`, `18:30`, `19:30`): `grade: '5th-6th Grade'`, genders `['Boys', 'Girls', 'Boys']`.
    - Saturday split courts (`west`, `east`, hours `8..15` = 16 games):
      - `h === 8` (`08:00` West & East, 2 games = 4 teams): `grade: 'Kindergarten'`, `gender: null` (paired from `BOYS`: `Eagles vs Lions`, `Bears vs Hawks`).
      - `h === 9 || h === 10` (`09:00` & `10:00` West & East, 4 games = 8 teams): `grade: '1st-2nd Grade'`, West = `'Boys'`, East = `'Girls'` on even hour and swapped on odd hour (`const genders: ('Boys' | 'Girls')[] = h % 2 === 0 ? ['Boys', 'Girls'] : ['Girls', 'Boys']`).
      - `h >= 11 && h <= 15` (`11:00`–`15:00` West & East, 10 games = 20 teams): `grade: '3rd-4th Grade'`, alternating `'Boys'` / `'Girls'` per hour as before (5 Boys games = 10 Boys teams, 5 Girls games = 10 Girls teams).
    - Saturday Full Court (`16:30`, `17:30`, `18:30`): `grade: '5th-6th Grade'`, genders `['Girls', 'Boys', 'Girls']`.
  - Note: in `pair(grade, gender)`, use `gender === 'Girls' ? GIRLS : BOYS` and key the `used` counter by `${grade}|${gender ?? ''}`.
- In `scheduleWarnings(games)`:
  - For the cheer grade check on Saturday split courts, allow `go >= 0 && go <= 4` (so `Kindergarten`, `1st-2nd Grade`, and `3rd-4th Grade` do not warn, while `5th-6th Grade` with `go = 5` warns with message containing `2nd–4th grade`).

### 2. `src/db.ts`
- Update `SEED_TEAMS` and `seedIfEmpty()` to use `'1st-2nd Grade'`, `'3rd-4th Grade'`, `'5th-6th Grade'`.
- Update `seedDemo()`:
  - Accept `gender: string | null` in `team(...)`.
  - Compute `short_name` as `name.replace(/^lady\s+/i, '').slice(0, 3).toUpperCase()`.
  - Set `games.division` to `divisionLabel(g.grade, g.gender)` (so Kindergarten games get `'Kindergarten'` instead of `'Kindergarten null'`).
- Add idempotent migration `migrateCombinedGrades()` called inside `migrate()`:
  - Runs in a transaction after table/index creation:
  - Fetches all rows from `teams` ordered by `grade_order ASC, id ASC`.
  - For each team:
    - `targetGrade = normalizeGrade(t.grade) ?? t.grade`
    - `targetOrder = gradeOrder(targetGrade)`
    - `targetGender = targetGrade === 'Kindergarten' ? null : t.gender`
    - `targetName = targetGender === 'Girls' && !/^\s*lady\s+/i.test(t.name) ? 'Lady ' + t.name.trim() : t.name.trim()`
    - Check if `(targetGrade ?? '', targetGender ?? '', targetName.toLowerCase())` is already in `seenKeys` (which happens when an existing DB had e.g. both `3rd Grade Boys Eagles` and `4th Grade Boys Eagles`). If it collides:
      - Pick the first unused name in `targetGender === 'Girls' ? GIRLS : BOYS` whose key `(targetGrade ?? '', targetGender ?? '', candidate.toLowerCase())` is not in `seenKeys` and not already in `teams` for that division (fallback: `${targetName} (${(t.grade || '').split(' ')[0] || t.id})`).
      - Update `short_name` to `targetName.replace(/^lady\s+/i, '').slice(0, 3).toUpperCase()`.
      - If `t.logo_url` starts with `/team-logos/teams/`, set `logo_url = NULL` so `loadLogos` can fill the matching mascot logo.
    - Also if `t.short_name === 'LAD'` or (`targetName !== t.name` and `t.short_name === t.name.slice(0, 3).toUpperCase()`), set `short_name = targetName.replace(/^lady\s+/i, '').slice(0, 3).toUpperCase()`.
    - To avoid transient unique-index conflicts while updating rows in place, update colliding/changing rows safely (e.g. update `grade`, `grade_order`, `gender`, `name`, `short_name`, `logo_url` per row after resolving `seenKeys`).
  - Also normalize `games.division` for any `games` row where `division IS NOT NULL`: if `normalizeDivision(r.division)` differs from `r.division`, update `games.division`.

### 3. `deliverables/logos/manifest.json` & `src/logo-files.ts`
- Update `deliverables/logos/manifest.json` so its 44 `teams` entries match the exact 44 `(name, division)` pairs of the new `demoSeedPlan`, pointing 1-to-1 to the 44 existing PNG files in `deliverables/logos/teams/*.png` (keeping `"teams/5th-grade-girls-stars.png"` on `Lady Stars` in `5th-6th Grade Girls` and `"teams/5th-grade-boys-eagles.png"` on `Eagles` in `5th-6th Grade Boys`).
- In `src/logo-files.ts`:
  - Add helpers to normalize team keys:
    - Strip optional leading `lady ` from team name: `const baseName = (s: string) => norm(s).replace(/^lady\s+/, '');`
    - Normalize division via `normalizeDivision`: `const normDiv = (grade: string | null, gender: string | null) => norm(divisionLabel(normalizeGrade(grade) ?? grade, normalizeGrade(grade) === 'Kindergarten' ? null : gender) ?? '');`
    - For manifest entries: `const manKey = (t: { name: string; division: string }) => baseName(t.name) + '|' + norm(normalizeDivision(t.division) ?? t.division);`
    - For DB team rows: `const dbKey = (t: { name: string; grade: string | null; gender: string | null }) => baseName(t.name) + '|' + normDiv(t.grade, t.gender);`
  - That way:
    - All 44 demo seed teams match 44/44 manifest entries (`matched: 44, unmatched: 0, withoutLogo: 0`).
    - A team named `'  STARS '` with `'5TH  grade'` and `'Girls'` (as in `test/logos.test.ts`) has `dbKey` = `'stars|5th-6th grade girls'`, matching `Lady Stars · 5th-6th Grade Girls` (`/team-logos/teams/5th-grade-girls-stars.png`)!
    - For `label` on `withoutLogo` rows, use `divisionLabel(t.grade, t.gender) ?? ''` so Kindergarten teams format as `Name · Kindergarten` and numbered grades format as `Name · 3rd-4th Grade Boys`.

### 4. `src/server.ts`
- In `teamValues(b)`:
  - `const grade = gradeOf(b.grade);`
  - `const gender = grade === 'Kindergarten' ? null : genderOf(b.gender);`
  - `const short = String(b.short_name || name.replace(/^lady\s+/i, '').slice(0, 3)).trim().toUpperCase().slice(0, 4);`
- In `PUT /api/teams/:id`:
  - When `grade` is updated to `'Kindergarten'`, ensure `gender` is set to `null`.
- In `findTeam(name, grade, gender)` (used by `schedule.csv` import):
  - Query by `lower(name) = lower($1)` first; if not found, also try matching with leading `'Lady '` added or stripped (`lower(regexp_replace(name, '^lady\s+', '', 'i')) = lower(regexp_replace($1, '^lady\s+', '', 'i'))`) so schedule CSVs referencing either `Stars` or `Lady Stars` resolve to the team.
- In `POST /api/import/schedule.csv`:
  - When `stated === 'Kindergarten'`, treat `statedGender` as `null`.
- In SQL queries building `label` (`SELECT ... concat_ws(' ', COALESCE(h.grade, a.grade), CASE WHEN COALESCE(h.grade, a.grade) = 'Kindergarten' THEN NULL ELSE COALESCE(h.gender, a.gender) END) AS label`), ensure Kindergarten never appends a gender suffix.

### 5. `public/admin.html`, `public/admin.js`, `public/practice-admin.js`
- `public/admin.html`:
  - Team form Grade input: `placeholder="1st-2nd Grade"` and populate `<datalist id="grade-list">` with `Kindergarten`, `1st-2nd Grade`, `3rd-4th Grade`, `5th-6th Grade`.
  - Game form Division input: `placeholder="1st-2nd Grade Boys" list="division-list"` and add `<datalist id="division-list">` with the 7 divisions (`Kindergarten`, `1st-2nd Grade Boys`, `1st-2nd Grade Girls`, `3rd-4th Grade Boys`, `3rd-4th Grade Girls`, `5th-6th Grade Boys`, `5th-6th Grade Girls`).
- `public/admin.js`:
  - Seed `const DEFAULT_GRADES = ['Kindergarten', '1st-2nd Grade', '3rd-4th Grade', '5th-6th Grade'];` so `[data-grade-filter]` dropdowns and `#grade-list` always include all 4 canonical grades (sorted by grade order) in addition to any team grades.
  - When `#team-form [name="grade"]` changes to `'Kindergarten'` (or `'K'`), set `#team-form [name="gender"]` to `''`.
- `public/practice-admin.js`:
  - Format `teamLabel` using `[t.grade, t.gender].filter(Boolean).join(' ')` so Kindergarten teams (`gender: null`) don't render a double space before `·`.

### 6. Sample CSVs (`scripts/gen-templates.mjs`, `samples/teams.csv`, `samples/schedule.csv`)
- Update `scripts/gen-templates.mjs` so:
  - `short_name` uses `n.replace(/^lady\s+/i, '').slice(0, 3).toUpperCase()`
  - `gender` uses `g.gender ?? ''`
  - `division` uses `divisionLabel(g.grade, g.gender) ?? ''`
- Regenerate `samples/teams.csv` and `samples/schedule.csv`.

### 7. Tests & E2E Scripts
- Update existing unit tests and e2e scripts where old single-grade strings (`'2nd Grade'`, `'3rd Grade'`, `'4th Grade'`, `'5th Grade'`, `'6th Grade'`) or unprefixed `'Stars'` were asserted:
  - `test/grades.test.ts`
  - `test/gender-seed.test.ts`
  - `test/logos.test.ts`
  - `test/six-periods.test.ts`
  - `test/round2.test.ts`
  - `scripts/smoke.mjs`
  - `scripts/flow-e2e.mjs`
  - `scripts/admin-today-e2e.mjs`
- Add `test/combined-grades.test.ts` testing all new ACs (7 divisions, Kindergarten mixed gender=null, K & 1st-2nd score-hiding vs 3rd-4th & 5th-6th score-showing, `Lady ` prefix on girls teams, DB migration with duplicate-name collision resolution, and logo matching).
  - **CRITICAL Docker build rule**: In `Dockerfile`, the `build` stage only copies `package.json`, `tsconfig.json`, `src`, and `test` (NOT `public/`, `samples/`, or `deliverables/`). Any test in `test/*.test.ts` that reads `public/`, `samples/`, or `deliverables/` MUST pass `{ skip: !fs.existsSync(...) }` so `npm test` inside `docker compose build` passes!
