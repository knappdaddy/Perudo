import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countFace, isValidBid, minQty, probAtLeast } from '../public/game/rules.js';

test('opening bids: anything but aces, unless palifico', () => {
  assert.equal(minQty(null, 3), 1);
  assert.equal(minQty(null, 1), null);
  assert.equal(minQty(null, 1, { palifico: true }), 1);
});

test('regular raises', () => {
  const prev = { qty: 4, face: 3 };
  assert.equal(minQty(prev, 5), 4); // same count, higher face
  assert.equal(minQty(prev, 3), 5);
  assert.equal(minQty(prev, 2), 5);
  assert.ok(isValidBid(prev, { qty: 4, face: 6 }, 20));
  assert.ok(!isValidBid(prev, { qty: 4, face: 3 }, 20));
  assert.ok(!isValidBid(prev, { qty: 21, face: 3 }, 20));
});

test('switching to and from aces', () => {
  assert.equal(minQty({ qty: 5, face: 4 }, 1), 3); // halve, round up
  assert.equal(minQty({ qty: 6, face: 4 }, 1), 3);
  assert.equal(minQty({ qty: 3, face: 1 }, 1), 4);
  assert.equal(minQty({ qty: 3, face: 1 }, 6), 7); // double plus one
});

test('palifico locks the face unless you have one die', () => {
  const prev = { qty: 2, face: 4 };
  assert.equal(minQty(prev, 4, { palifico: true }), 3);
  assert.equal(minQty(prev, 5, { palifico: true }), null);
  assert.equal(minQty(prev, 5, { palifico: true, canChangeFace: true }), 2);
  assert.equal(minQty(prev, 2, { palifico: true, canChangeFace: true }), 3);
});

test('counting with and without wild aces', () => {
  const dice = [1, 1, 3, 3, 4, 6];
  assert.equal(countFace(dice, 3, false), 4);
  assert.equal(countFace(dice, 3, true), 2);
  assert.equal(countFace(dice, 1, false), 2);
});

test('probabilities are sane', () => {
  assert.equal(probAtLeast(10, 0, 1 / 3), 1);
  assert.equal(probAtLeast(3, 4, 1 / 3), 0);
  assert.ok(Math.abs(probAtLeast(1, 1, 1 / 6) - 1 / 6) < 1e-9);
});
