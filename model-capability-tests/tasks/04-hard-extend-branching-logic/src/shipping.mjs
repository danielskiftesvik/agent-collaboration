// Computes a shipping cost tier for an order.
// Existing tiers (do not change their behavior):
//   - weight <= 0: throws Error("invalid weight")
//   - express === true: "express" (flat rate regardless of weight)
//   - weight <= 1: "small"
//   - weight <= 5: "medium"
//   - weight > 5: "large"
export function shippingTier(order) {
  const { weight, express } = order;
  if (weight <= 0) throw new Error("invalid weight");
  if (express) return "express";
  if (weight <= 1) return "small";
  if (weight <= 5) return "medium";
  return "large";
}
