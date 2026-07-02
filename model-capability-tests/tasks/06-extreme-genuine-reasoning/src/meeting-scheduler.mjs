// Given a list of meeting requests for a SINGLE room, each { start, end, priority },
// return the maximum total priority achievable by selecting a subset of
// non-overlapping meetings. Two meetings [a,b] and [c,d] overlap only if they
// share more than a single point in time — a meeting ending exactly when another
// starts (e.g. end=5, start=5) does NOT count as overlapping and both may be kept.
//
// This is NOT the same problem as "maximize the number of meetings" and it is NOT
// solved by always picking the highest-priority meeting first — a correct solution
// may need to reason about combinations of meetings, not just individual ones.
export function maxPriorityValue(meetings) {
  throw new Error("not implemented");
}
