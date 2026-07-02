import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateLoyaltyPoints } from "../src/loyalty-points.mjs";

test("non-member, non-electronics, not first purchase: just base points", () => {
  assert.equal(
    calculateLoyaltyPoints({ amount: 100, isMember: false, category: "books", isFirstPurchase: false }),
    100
  );
});

test("member doubles the base points", () => {
  assert.equal(
    calculateLoyaltyPoints({ amount: 100, isMember: true, category: "books", isFirstPurchase: false }),
    200
  );
});

test("electronics bonus is added AFTER doubling, and is not itself doubled", () => {
  // A naive implementation might add the +50 bonus BEFORE doubling (giving 300)
  // instead of after (giving 250). This case exists specifically to catch that.
  assert.equal(
    calculateLoyaltyPoints({ amount: 100, isMember: true, category: "electronics", isFirstPurchase: false }),
    250
  );
});

test("first-purchase bonus uses the ORIGINAL amount, not the doubled/bonused running total", () => {
  // A naive implementation might compute the 10% bonus on the running total after
  // doubling + the electronics bonus (250 * 0.10 = 25, giving 275) instead of on
  // the original amount (100 * 0.10 = 10, giving 260). This case exists to catch that.
  assert.equal(
    calculateLoyaltyPoints({ amount: 100, isMember: true, category: "electronics", isFirstPurchase: true }),
    260
  );
});

test("first-purchase bonus without membership or electronics", () => {
  assert.equal(
    calculateLoyaltyPoints({ amount: 100, isMember: false, category: "electronics", isFirstPurchase: true }),
    160 // 100 base + 50 electronics + floor(100*0.10)=10
  );
});

test("zero amount returns 0 regardless of flags", () => {
  assert.equal(
    calculateLoyaltyPoints({ amount: 0, isMember: true, category: "electronics", isFirstPurchase: true }),
    0
  );
});

test("negative amount returns 0", () => {
  assert.equal(
    calculateLoyaltyPoints({ amount: -50, isMember: true, category: "electronics", isFirstPurchase: true }),
    0
  );
});

test("fractional amounts floor correctly at each stage", () => {
  assert.equal(
    calculateLoyaltyPoints({ amount: 49.5, isMember: false, category: "books", isFirstPurchase: true }),
    53 // base floor(49.5)=49, + floor(49.5*0.10)=floor(4.95)=4 -> 53
  );
});
