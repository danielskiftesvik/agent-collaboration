import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "../src/clamp.mjs";

test("clamps below min", () => assert.equal(clamp(-5, 0, 10), 0));
test("clamps above max", () => assert.equal(clamp(15, 0, 10), 10));
test("passes through in range", () => assert.equal(clamp(5, 0, 10), 5));
test("boundary values pass through", () => {
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});
