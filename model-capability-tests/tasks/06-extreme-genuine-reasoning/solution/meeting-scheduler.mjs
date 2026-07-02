export function maxPriorityValue(meetings) {
  if (meetings.length === 0) return 0;
  const sorted = [...meetings].sort((a, b) => a.end - b.end);
  const n = sorted.length;
  const dp = new Array(n).fill(0);

  function latestCompatible(i) {
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].end <= sorted[i].start) return j;
    }
    return -1;
  }

  dp[0] = sorted[0].priority;
  for (let i = 1; i < n; i++) {
    const j = latestCompatible(i);
    const includeValue = sorted[i].priority + (j >= 0 ? dp[j] : 0);
    dp[i] = Math.max(dp[i - 1], includeValue);
  }
  return dp[n - 1];
}
