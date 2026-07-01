import { test } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "../src/lru-cache.mjs";

test("throws for non-positive capacity", () => {
  assert.throws(() => new LRUCache(0), /capacity must be positive/);
  assert.throws(() => new LRUCache(-1), /capacity must be positive/);
});

test("set and get a value", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
});

test("get returns undefined for a missing key", () => {
  const c = new LRUCache(2);
  assert.equal(c.get("missing"), undefined);
});

test("has does not affect recency", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.has("a"), true);
  c.set("c", 3); // should evict "a" (least recently used) since has() didn't count as use
  assert.equal(c.has("a"), false);
  assert.equal(c.has("b"), true);
  assert.equal(c.has("c"), true);
});

test("evicts least-recently-used when capacity exceeded", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3); // evicts "a"
  assert.equal(c.has("a"), false);
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("c"), 3);
});

test("get marks a key as most-recently-used", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a"); // "a" is now most-recently-used, "b" is least
  c.set("c", 3); // should evict "b", not "a"
  assert.equal(c.has("a"), true);
  assert.equal(c.has("b"), false);
  assert.equal(c.has("c"), true);
});

test("updating an existing key marks it as most-recently-used and doesn't grow size", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 100); // update, "a" now most-recently-used
  assert.equal(c.size, 2);
  c.set("c", 3); // should evict "b"
  assert.equal(c.has("a"), true);
  assert.equal(c.get("a"), 100);
  assert.equal(c.has("b"), false);
});

test("size reflects current entry count", () => {
  const c = new LRUCache(3);
  assert.equal(c.size, 0);
  c.set("a", 1);
  assert.equal(c.size, 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.size, 3);
  c.set("d", 4); // evicts one
  assert.equal(c.size, 3);
});
