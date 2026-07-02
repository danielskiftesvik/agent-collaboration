import { test } from "node:test";
import assert from "node:assert/strict";
import { maxPriorityValue } from "../src/meeting-scheduler.mjs";

test("empty list returns 0", () => {
  assert.equal(maxPriorityValue([]), 0);
});

test("single meeting returns its priority", () => {
  assert.equal(maxPriorityValue([{ start: 0, end: 5, priority: 7 }]), 7);
});

test("non-overlapping meetings: sum all priorities", () => {
  const meetings = [
    { start: 0, end: 5, priority: 3 },
    { start: 5, end: 10, priority: 4 },
    { start: 10, end: 15, priority: 2 }
  ];
  assert.equal(maxPriorityValue(meetings), 9);
});

test("touching endpoints do NOT count as overlapping", () => {
  const meetings = [
    { start: 0, end: 5, priority: 10 },
    { start: 5, end: 10, priority: 10 }
  ];
  assert.equal(maxPriorityValue(meetings), 20);
});

test("fully overlapping meetings: only the single best one can be picked", () => {
  const meetings = [
    { start: 0, end: 10, priority: 5 },
    { start: 2, end: 8, priority: 9 },
    { start: 1, end: 6, priority: 3 }
  ];
  assert.equal(maxPriorityValue(meetings), 9);
});

test("picking the single highest-priority meeting is WRONG here (greedy-by-priority trap)", () => {
  const meetings = [
    { start: 0, end: 10, priority: 10 },
    { start: 0, end: 5, priority: 6 },
    { start: 5, end: 10, priority: 6 }
  ];
  // Two smaller non-overlapping meetings (6+6=12) beat the single big one (10).
  assert.equal(maxPriorityValue(meetings), 12);
});

test("maximizing the COUNT of meetings is WRONG here (greedy-by-earliest-end trap)", () => {
  const meetings = [
    { start: 0, end: 1, priority: 1 },
    { start: 1, end: 2, priority: 1 },
    { start: 2, end: 3, priority: 1 },
    { start: 0, end: 3, priority: 100 }
  ];
  // Three short low-value meetings (1+1+1=3) lose to the one big one (100).
  assert.equal(maxPriorityValue(meetings), 100);
});
