import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeRepo } from "./helpers.mjs";
import { checkPreflight, readPreflightConfig } from "../core/preflight.mjs";

test("preflight is opt-in and reads repo-owned limits", () => {
  const repo = makeRepo();
  assert.equal(checkPreflight(repo).ok, true);
  fs.writeFileSync(path.join(repo, ".agent-collab.json"), JSON.stringify({
    preflight: { maxWorktrees: 0, minFreeDiskGb: 999999 }
  }));
  const config = readPreflightConfig(repo);
  assert.equal(config.maxWorktrees, 0);
  const result = checkPreflight(repo, config);
  assert.equal(result.ok, false);
  assert.match(result.failures.join(" "), /worktree cap/);
  assert.match(result.failures.join(" "), /free disk/);
});

test("configured preflight fails closed when its config is malformed", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, ".agent-collab.json"), "{bad json");
  const result = checkPreflight(repo);
  assert.equal(result.ok, false);
  assert.match(result.failures.join(" "), /cannot parse/);
});
