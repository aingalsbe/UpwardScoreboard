// Real 2027 season logos (LBC mascots): manifest-2027.json covers all 52 teams in data/season-2027, files 512x512 PNG <= 300 KB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LOGO_DIR, LOGO_MAX_BYTES, MANIFEST_2027, readManifest, norm, logoFile, logoUrl } from '../src/logo-files.js';

const noFiles = !fs.existsSync(path.join(LOGO_DIR, MANIFEST_2027)) && 'manifest-2027.json not present';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('manifest-2027: 52 unique teams, every file a 512x512 PNG <= 300 KB, no colors', { skip: noFiles }, () => {
  const m = readManifest(LOGO_DIR, MANIFEST_2027);
  assert.equal(m.teams.length, 52); assert.equal(m.cheer.length, 0);
  assert.equal(new Set(m.teams.map((t) => norm(`${t.name}|${t.division}`))).size, 52);
  for (const e of m.teams) {
    assert.match(e.file, /^teams\/2027-[a-z0-9-]+\.png$/);
    assert.equal((e as any).colors, undefined, 'season colors only');
    const f = path.join(LOGO_DIR, e.file), b = fs.readFileSync(f);
    assert.ok(b.subarray(0, 8).equals(PNG), `${e.file} is a PNG`);
    assert.ok(b.length <= LOGO_MAX_BYTES, `${e.file} ${b.length} bytes`);
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [512, 512], `${e.file} 512x512`);
    assert.equal(logoFile(logoUrl(e.file)), f);
  }
  assert.equal(readManifest().teams.length, 44, 'demo manifest unchanged');
});

test('manifest-2027 matches every team in data/season-2027 by name + division', { skip: noFiles }, () => {
  const csvPath = path.resolve(LOGO_DIR, '../../data/season-2027/Upward Game Schedule 2027.csv');
  if (!fs.existsSync(csvPath)) return;
  const lines = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const hdr = lines[0].split(','); const di = hdr.indexOf('DivisionName'), hi = hdr.indexOf('HomeTeam'), ai = hdr.indexOf('AwayTeam');
  const teams = new Set<string>();
  for (const l of lines.slice(1)) { const c = l.split(','); teams.add(norm(`${c[hi]}|${c[di]}`)); teams.add(norm(`${c[ai]}|${c[di]}`)); }
  assert.equal(teams.size, 52);
  const man = new Set(readManifest(LOGO_DIR, MANIFEST_2027).teams.map((t) => norm(`${t.name}|${t.division}`)));
  assert.deepEqual([...teams].filter((t) => !man.has(t)), []);
});
