export function shippingTier(order) {
  const { weight, express } = order;
  if (weight <= 0) throw new Error("invalid weight");
  if (express) return "express";
  if (weight <= 1) return "small";
  if (weight <= 5) return "medium";
  if (weight <= 20) return "large";
  return "bulk";
}
