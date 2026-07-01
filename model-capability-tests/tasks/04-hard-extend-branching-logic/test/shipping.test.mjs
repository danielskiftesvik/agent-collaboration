import { test } from "node:test";
import assert from "node:assert/strict";
import { shippingTier } from "../src/shipping.mjs";

test("throws for non-positive weight", () => {
  assert.throws(() => shippingTier({ weight: 0 }), /invalid weight/);
  assert.throws(() => shippingTier({ weight: -1 }), /invalid weight/);
});
test("express always wins regardless of weight", () => {
  assert.equal(shippingTier({ weight: 0.5, express: true }), "express");
  assert.equal(shippingTier({ weight: 50, express: true }), "express");
});
test("small tier for weight <= 1", () => {
  assert.equal(shippingTier({ weight: 1 }), "small");
  assert.equal(shippingTier({ weight: 0.5 }), "small");
});
test("medium tier for 1 < weight <= 5", () => {
  assert.equal(shippingTier({ weight: 5 }), "medium");
  assert.equal(shippingTier({ weight: 2 }), "medium");
});
test("large tier for 5 < weight <= 20", () => {
  assert.equal(shippingTier({ weight: 6 }), "large");
  assert.equal(shippingTier({ weight: 20 }), "large");
});
test("NEW: bulk tier for weight > 20, non-express", () => {
  assert.equal(shippingTier({ weight: 20.1 }), "bulk");
  assert.equal(shippingTier({ weight: 100 }), "bulk");
});
