export function removeInPlace(list, predicate) {
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (predicate(list[i])) {
      list.splice(i, 1);
      removed++;
    }
  }
  return removed;
}
