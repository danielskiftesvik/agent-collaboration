import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQueryString } from "../src/query-string.mjs";

test("empty string returns empty object", () => {
  assert.deepEqual(parseQueryString(""), {});
});
test("parses a single pair", () => {
  assert.deepEqual(parseQueryString("a=1"), { a: "1" });
});
test("parses multiple pairs", () => {
  assert.deepEqual(parseQueryString("a=1&b=2"), { a: "1", b: "2" });
});
test("URI-decodes keys and values", () => {
  assert.deepEqual(parseQueryString("na%20me=jo%20hn"), { "na me": "jo hn" });
});
test("a key with no value maps to 'true'", () => {
  assert.deepEqual(parseQueryString("flag&a=1"), { flag: "true", a: "1" });
});
