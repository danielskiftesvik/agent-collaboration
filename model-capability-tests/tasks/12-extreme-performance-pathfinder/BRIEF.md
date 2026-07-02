Implement `findShortestPath(grid, start, end)` in `src/pathfinder.mjs` to satisfy its specifications and pass all tests in `test/pathfinder.test.mjs`. Currently, it throws "not implemented".

### Requirements:
1. **Shortest Path Weight:** The `grid` is a 2D array of non-negative numbers representing the traversal cost of each cell. Cells with a cost of `Infinity` represent impassable walls.
2. **Movement:** You can move in 4 cardinal directions: Up, Down, Left, Right.
3. **Coordinates:** `start` and `end` are coordinate objects `{ r, c }`.
4. **Calculations:** Return the minimum total path weight to go from `start` to `end`. The path weight is the sum of costs of all visited cells *including* `end` but *excluding* `start`.
5. **No Path:** If no path of finite cost exists to the destination, return `null`.
6. **Strict CPU Time Budget:** The test suite contains large grids (up to $300 \times 300$). A naive Dijkstra implementation that searches an array linearly for the minimum distance node on each step $O(V^2)$ will be too slow and fail the performance assertions (which enforce a strict **$30\text{ms}$ limit** for large grids). You must implement an efficient Dijkstra's algorithm utilizing a **Min-Heap (Binary Heap / Priority Queue)** to achieve $O(E \log V)$ time complexity.

Do not edit the test file.

Then run: node --test test/pathfinder.test.mjs
Expected: all tests pass.

When finished, return ONLY a JSON object:
{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}
