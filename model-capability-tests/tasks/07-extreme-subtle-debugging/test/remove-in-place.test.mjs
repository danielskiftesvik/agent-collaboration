import { test } from "node:test";
import assert from "node:assert/strict";
import { removeInPlace } from "../src/remove-in-place.mjs";

test("removes matching items and returns the count", () => {
  const list = [1, 2, 3, 4, 5];
  const removed = removeInPlace(list, (x) => x % 2 === 0);
  assert.deepEqual(list, [1, 3, 5]);
  assert.equal(removed, 2);
});

test("removes CONSECUTIVE matching items correctly", () => {
  const list = [1, 2, 2, 2, 3];
  const removed = removeInPlace(list, (x) => x === 2);
  assert.deepEqual(list, [1, 3]);
  assert.equal(removed, 3);
});

test("removes all items", () => {
  const list = [1, 1, 1];
  const removed = removeInPlace(list, (x) => x === 1);
  assert.deepEqual(list, []);
  assert.equal(removed, 3);
});

test("removes nothing when nothing matches", () => {
  const list = [1, 2, 3];
  const removed = removeInPlace(list, (x) => x > 10);
  assert.deepEqual(list, [1, 2, 3]);
  assert.equal(removed, 0);
});

test("empty list", () => {
  const list = [];
  const removed = removeInPlace(list, () => true);
  assert.deepEqual(list, []);
  assert.equal(removed, 0);
});
