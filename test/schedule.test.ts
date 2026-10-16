import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlaps, courtsConflict, parseConflicts } from '../src/schedule.js';

const T = (h: number, m = 0) => Date.UTC(2026, 9, 24, h, m);
const full = { slug: 'full', conflicts_with: ['west', 'east'] }, west = { slug: 'west', conflicts_with: [] }, east = { slug: 'east', conflicts_with: [] };

test('overlap uses start + duration, half-open (back-to-back is fine)', () => {
  assert.equal(overlaps(T(10), 60, T(10, 30), 60), true);
  assert.equal(overlaps(T(10), 60, T(11), 60), false); // 10-11 then 11-12
  assert.equal(overlaps(T(11), 60, T(10), 60), false);
  assert.equal(overlaps(T(10), 90, T(11), 60), true); // longer game runs into the next slot
  assert.equal(overlaps(T(9), 240, T(10), 30), true); // containment
});

test('Full conflicts with West and East (both directions); West and East do not conflict', () => {
  assert.equal(courtsConflict(full, west), true);
  assert.equal(courtsConflict(east, full), true);
  assert.equal(courtsConflict(west, east), false);
  assert.equal(courtsConflict(full, full), false); // same court is not a floor conflict
});

test('conflicts_with parsing accepts spaces, semicolons or commas', () => {
  assert.deepEqual(parseConflicts('west east'), ['east', 'west']);
  assert.deepEqual(parseConflicts('West; east;;'), ['east', 'west']);
  assert.deepEqual(parseConflicts(['west', 'bad slug!']), ['west']);
  assert.deepEqual(parseConflicts(''), []);
});
