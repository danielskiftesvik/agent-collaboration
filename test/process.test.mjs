import { test } from "node:test";
import assert from "node:assert/strict";

import { run } from "../core/process.mjs";

test("run captures stdout and a zero status", () => {
  const r = run("node", ["-e", "process.stdout.write('hi')"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "hi");
});

test("run returns a non-zero status without throwing", () => {
  const r = run("node", ["-e", "process.exit(3)"]);
  assert.equal(r.status, 3);
});
