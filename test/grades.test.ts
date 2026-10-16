import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGrade, gradeOrder, gradeMismatch } from '../src/schedule.js';

test('grade labels normalize and sort', () => {
  assert.equal(normalizeGrade('5'), '5th Grade');
  assert.equal(normalizeGrade('2nd'), '2nd Grade');
  assert.equal(normalizeGrade('3rd grade'), '3rd Grade');
  assert.equal(normalizeGrade('Grade 11'), '11th Grade');
  assert.equal(normalizeGrade('K'), 'Kindergarten');
  assert.equal(normalizeGrade(''), null);
  assert.deepEqual(['5th Grade', '2nd Grade', 'Kindergarten', null, '4th Grade'].sort((a, b) => gradeOrder(a) - gradeOrder(b)), ['Kindergarten', '2nd Grade', '4th Grade', '5th Grade', null]);
});

test('a game must be within one grade', () => {
  const e5 = { name: 'Eagles', grade: '5th Grade' }, l5 = { name: 'Lions', grade: '5th Grade' }, b2 = { name: 'Bears', grade: '2nd Grade' };
  assert.equal(gradeMismatch(e5, l5), null);
  assert.match(gradeMismatch(e5, b2)!, /within one grade: Eagles is 5th Grade, Bears is 2nd Grade/);
  assert.match(gradeMismatch(e5, l5, '4th Grade')!, /doesn't match the teams \(5th Grade\)/);
  assert.equal(gradeMismatch(e5, l5, '5th Grade'), null);
  assert.equal(gradeMismatch({ name: 'Old', grade: null }, l5), null); // legacy teams without a grade
});

import { sideColors } from '../src/schedule.js';
test('season colors: home = light, away = dark by default; swap flips', () => {
  const season = { dark: '#800000', light: '#ffc72c' };
  assert.deepEqual(sideColors(season, false, 'home'), { side: 'light', color: '#ffc72c', accent: '#800000' });
  assert.deepEqual(sideColors(season, false, 'away'), { side: 'dark', color: '#800000', accent: '#ffc72c' });
  assert.equal(sideColors(season, true, 'home').side, 'dark');
  assert.equal(sideColors(season, true, 'away').color, '#ffc72c');
});
