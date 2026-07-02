import { test } from "node:test";
import assert from "node:assert/strict";
import { findShortestPath } from "../src/pathfinder.mjs";

test("finds shortest path on small simple grid", () => {
  const grid = [
    [1, 3, 1],
    [1, 5, 1],
    [4, 2, 1]
  ];
  const start = { r: 0, c: 0 };
  const end = { r: 2, c: 2 };
  
  // Path: (0,0) -> (0,1) -> (0,2) -> (1,2) -> (2,2)
  // Costs: 3 + 1 + 1 + 1 = 6. (Winner)
  assert.equal(findShortestPath(grid, start, end), 6);
});

test("handles obstacles and routes around them", () => {
  const grid = [
    [1, 99, 1],
    [1, 99, 1],
    [1,  1, 1]
  ];
  const start = { r: 0, c: 0 };
  const end = { r: 0, c: 2 };
  
  // Must go down, right, up
  // Steps: (0,0) -> (1,0) -> (2,0) -> (2,1) -> (2,2) -> (1,2) -> (0,2)
  // Costs: 1 + 1 + 1 + 1 + 1 + 1 = 6
  assert.equal(findShortestPath(grid, start, end), 6);
});

test("returns null if destination is unreachable", () => {
  const grid = [
    [1, Infinity, 1],
    [Infinity, Infinity, 1],
    [1, 1, 1]
  ];
  const start = { r: 0, c: 0 };
  const end = { r: 2, c: 2 };
  
  assert.equal(findShortestPath(grid, start, end), null);
});

test("performance: runs under 30ms on large 200x200 grid", () => {
  const size = 200;
  const grid = Array.from({ length: size }, () => Array(size).fill(1));
  
  // Put obstacles to make it non-trivial
  for (let i = 0; i < size - 1; i++) {
    grid[i][Math.floor(size / 2)] = 1000;
  }
  
  const start = { r: 0, c: 0 };
  const end = { r: size - 1, c: size - 1 };

  const t0 = performance.now();
  const cost = findShortestPath(grid, start, end);
  const duration = performance.now() - t0;

  // Expected distance: (0,0) -> (size-1, 0) -> (size-1, size-1)
  // Which is size-1 steps down, and size-1 steps right.
  // Total cost: (size - 1) + (size - 1) = 398
  assert.equal(cost, 398);
  assert.ok(duration < 30, `Performance budget exceeded: took ${duration.toFixed(2)}ms (limit is 30ms)`);
});
