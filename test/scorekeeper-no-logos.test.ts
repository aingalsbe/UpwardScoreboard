// Aaron (2026-10-23): logos on the lobby, practice TVs, court TV and overlay; NEVER on the scorekeeper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scorekeeperView, publicView, hasLogoKey } from '../src/payload.js';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const state = () => ({ type: 'state', church: { name: 'LBC', logo: '/church.png' }, game: { id: 1, theme: { homeLogo: '/x.png' }, cheer: { name: 'Pep', logo: '/logos/squad/1' },
  home: { name: 'Eagles', logo: '/team-logos/teams/eagles.png', coach: 'Sam' }, away: { name: 'Bears', logo: '/logos/2' } },
  games: [{ id: 2, home: { name: 'A', logo: '/a.png' }, away: { name: 'B', logo: null } }] });

test('scorekeeper payload carries no logos (court TV / overlay payloads keep them)', () => {
  const s = scorekeeperView(state());
  assert.equal(hasLogoKey(s), false, JSON.stringify(s));
  assert.equal(s.game.home.name, 'Eagles'); assert.equal(s.games[0].home.name, 'A');
  assert.equal(publicView(state()).game.home.logo, '/team-logos/teams/eagles.png', 'TV/overlay keep logos');
});

test('scorekeeper page renders no logos', { skip: !fs.existsSync(path.join(PUB, 'score.js')) && 'public/ not present' }, () => {
  for (const f of ['score.js', 'score.html']) if (fs.existsSync(path.join(PUB, f))) {
    const src = fs.readFileSync(path.join(PUB, f), 'utf8');
    assert.doesNotMatch(src, /logo|mascot/i, f);
  }
});
