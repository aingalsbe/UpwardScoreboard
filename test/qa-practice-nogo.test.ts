// Avery's NO-GO on feature/practice-schedule: lobby header/cheer with mixed hours on top; broken logo -> initial badge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const skip = !fs.existsSync(path.join(PUB, 'lobby-view.js')) && 'public/ not present';
const G = (id: number, court: string, time: string, status = 'scheduled', extra: any = {}) => ({ id, court, time, status, home: { name: `H${id}` }, away: { name: `A${id}` }, ...extra });
const at = (period: number) => ({ period, periods: 6, clock: { running: true, remainingMs: 60_000, startedAt: null } });

test('lobby: West 12:00 live + East 11:00 in the 1st half -> header and cheer follow the earliest game (11:00)', { skip }, async () => {
  const { planLobby } = await import(path.join(PUB, 'lobby-view.js'));
  const games = [G(1, 'west', '11:00', 'complete'), G(2, 'west', '12:00', 'active', at(1)), G(3, 'east', '11:00', 'active', at(2)), G(4, 'east', '12:00'), G(5, 'west', '13:00')];
  const cheer = [{ start: '11:00', name: 'Pep' }, { start: '12:00', name: 'Spirit' }, { start: '13:00', name: 'Hype' }];
  const p = planLobby(games, cheer);
  assert.equal(p.header, '11:00');
  assert.equal(p.cheer.now?.name, 'Pep', 'the 11:00 cheer stays while the 11:00 game is on top');
  // East 11:00 goes final -> East 12:00 moves up, header 12:00, cheer Spirit
  const q = planLobby(games.map((g) => (g.id === 3 ? { ...g, status: 'complete' } : g)), cheer);
  assert.equal(q.header, '12:00'); assert.equal(q.cheer.now?.name, 'Spirit');
});

test('broken logo (404) -> the <img> is swapped for the initial badge, and later renders use the badge', { skip }, async () => {
  const { mascotHtml, onLogoError } = await import(path.join(PUB, 'logo-badge.js'));
  const url = '/team-logos/teams/missing.png';
  assert.match(mascotHtml(url, 'Eagles'), /<img class="mascot"[^>]*data-initial="E"/);
  let replaced: any = null;
  const made: any = { setAttribute(k: string, v: string) { this[k] = v; }, textContent: '' };
  const img: any = { tagName: 'IMG', classList: { contains: (c: string) => c === 'mascot' }, getAttribute: (k: string) => ({ src: url, 'data-initial': 'E' } as any)[k],
    ownerDocument: { createElement: () => made }, replaceWith: (x: any) => (replaced = x) };
  assert.equal(onLogoError({ target: img }), true);
  assert.equal(replaced, made); assert.equal(made.className, 'mascot badge'); assert.equal(made.textContent, 'E');
  assert.match(mascotHtml(url, 'Eagles'), /class="mascot badge"[^>]*>E<\/span>$/, 'remembered as failed: no flicker on re-render');
  assert.equal(onLogoError({ target: { tagName: 'IMG', classList: { contains: () => false } } }), false, 'other images untouched');
  for (const f of ['lobby.js', 'practice.js']) assert.match(fs.readFileSync(path.join(PUB, f), 'utf8'), /installLogoFallback\(\)/, f);
  for (const f of ['tv.js', 'overlay.js', 'score.js']) if (fs.existsSync(path.join(PUB, f))) assert.doesNotMatch(fs.readFileSync(path.join(PUB, f), 'utf8'), /logo-badge/, `${f} untouched`);
});
