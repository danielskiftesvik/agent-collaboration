// Removes every element from `list` that matches `predicate`, mutating `list` in
// place, and returns the count of elements removed.
export function removeInPlace(list, predicate) {
  let removed = 0;
  for (let i = 0; i < list.length; i++) {
    if (predicate(list[i])) {
      list.splice(i, 1);
      removed++;
    }
  }
  return removed;
}
