// Computes loyalty points for a purchase: { amount, isMember, category, isFirstPurchase }.
//
// Rules — read carefully, they interact in specific, non-obvious ways:
// 1. Base points: 1 point per whole dollar spent (round DOWN, e.g. $49.90 -> 49 base points).
// 2. If isMember is true, the BASE points (only) are doubled.
// 3. If category === "electronics", add a flat 50-point bonus AFTER the membership
//    doubling — this bonus itself is never doubled.
// 4. If isFirstPurchase is true, add floor(amount * 0.10) points, computed from the
//    ORIGINAL purchase amount — this bonus is never affected by membership doubling
//    or the electronics bonus, and is always added last.
// 5. If amount <= 0, return 0 regardless of any other field.
// 6. The result is always a non-negative integer.
export function calculateLoyaltyPoints(purchase) {
  throw new Error("not implemented");
}
