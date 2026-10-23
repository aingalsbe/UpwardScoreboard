// Avery's QA on 70f363b: last game stays through the 2nd half, one-court roll-up consistency, lobby logos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const skip = !fs.existsSync(path.join(PUB, 'lobby-view.js')) && 'public/ not present';
const load = () => import(path.join(PUB, 'lobby-view.js'));
const G = (id: number, court: string, time: string, status = 'scheduled', extra: any = {}) => ({ id, court, time, status, home: { name: `H${id}` }, away: { name: `A${id}` }, ...extra });
const at = (period: number, remainingMs = 60_000, running = false) => ({ period, periods: 6, clock: { running, remainingMs, startedAt: null } });
const ids = (band: any) => band && Object.fromEntries(Object.entries(band.courts).map(([k, g]: any) => [k, g?.id ?? null]));

test('M: the last game of the day stays on top through the 2nd half (Full + split), then final -> empty', { skip }, async () => {
  const { planLobby } = await load();
  const fri = [G(1, 'full', '17:30', 'complete'), G(2, 'full', '18:30', 'complete'), G(3, 'full', '19:30', 'active', at(4))];
  const p = planLobby(fri);
  assert.deepEqual(ids(p.now), { full: 3 }); assert.equal(p.empty, false); assert.equal(p.next, null);
  assert.equal(planLobby([fri[0], fri[1], { ...fri[2], status: 'complete' }]).empty, true);
  // split: west's last game at P5 stays; east still rolls to its next game
  const sat = planLobby([G(1, 'west', '18:00', 'active', at(5)), G(2, 'east', '17:00', 'active', at(4)), G(3, 'east', '18:00')]);
  assert.deepEqual(ids(sat.now), { west: 1, east: 3 });
  // demo ?day=sat&at=18:50 with an 18:00 last slot: still shown
  const { demoGames } = await load();
  assert.deepEqual(ids(planLobby(demoGames([G(1, 'west', '18:00'), G(2, 'east', '18:00')], '18:50')).now), { west: 1, east: 2 });
});

test('L(b): one court rolled -> Up Next is one time slot; cheer rows follow the top slot and Up Next', { skip }, async () => {
  const { planLobby } = await load();
  const games = [G(1, 'west', '10:00', 'active', at(2)), G(2, 'east', '10:00', 'active', at(4)),
    G(3, 'west', '11:00'), G(4, 'east', '11:00'), G(5, 'west', '12:00'), G(6, 'east', '12:00')];
  const cheer = ['10:00', '11:00', '12:00'].map((start) => ({ start, name: 'C' + start }));
  const p = planLobby(games, cheer);
  assert.deepEqual(ids(p.now), { west: 1, east: 4 }, 'east 11:00 moves up (Tip-off)');
  assert.deepEqual(ids(p.next), { west: 3, east: null }, 'Up Next = the 11:00 slot only (east 11:00 is already on top)');
  assert.equal(p.nextTime, '11:00');
  assert.equal(p.cheer.now.name, 'C10:00', 'top cheer = the slot still being played');
  assert.equal(p.cheer.next.name, 'C11:00');
});

test('lobby logos: mascot <img> when a logo URL is sent, initial badge otherwise; unsafe URLs fall back', { skip }, async () => {
  const { mascotHtml, initialOf, safeLogo } = await import(path.join(PUB, 'logo-badge.js'));
  assert.match(mascotHtml('/team-logos/teams/5th-grade-boys-eagles.png', 'Eagles'), /^<img class="mascot" data-bind="logo" src="\/team-logos\/teams\/5th-grade-boys-eagles.png"/);
  assert.match(mascotHtml('/logos/squad/3', 'Spirit'), /src="\/logos\/squad\/3"/);
  const b = mascotHtml(null, '  lady sparks');
  assert.match(b, /class="mascot badge"/); assert.match(b, />L<\/span>$/);
  assert.equal(initialOf(''), '?'); assert.equal(initialOf('49ers'), '4');
  for (const bad of ['javascript:alert(1)', '//evil.example/x.png', 'data:image/png;base64,AA']) { assert.equal(safeLogo(bad), null); assert.match(mascotHtml(bad, 'X'), /badge/); }
  assert.match(mascotHtml('/x.png?a="b"', 'X'), /&quot;b&quot;/, 'escaped');
  // the lobby renders the name block with the logo for team rows and the cheer row
  const src = fs.readFileSync(path.join(PUB, 'lobby.js'), 'utf8');
  assert.match(src, /who\(t\.name, t\.coach, t\.logo\)/); assert.match(src, /who\(c\.name, c\.coach, c\.logo\)/);
  for (const f of ['tv.js', 'overlay.js', 'score.js']) if (fs.existsSync(path.join(PUB, f))) assert.doesNotMatch(fs.readFileSync(path.join(PUB, f), 'utf8'), /logo-badge/, `${f} has no mascot badges`);
});
