export function calculateLoyaltyPoints(purchase) {
  const { amount, isMember, category, isFirstPurchase } = purchase;
  if (amount <= 0) return 0;
  let points = Math.floor(amount);
  if (isMember) points *= 2;
  if (category === "electronics") points += 50;
  if (isFirstPurchase) points += Math.floor(amount * 0.1);
  return points;
}
