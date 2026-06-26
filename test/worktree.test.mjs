import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeRepo, isolateStateRoot } from "./helpers.mjs";
import { resolveWorkspaceRoot, createWorktree, removeWorktree } from "../core/workspace.mjs";
import { headRef } from "../core/git.mjs";

test("createWorktree makes a linked worktree outside the repo, then removeWorktree cleans it up", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const base = headRef(repo);

  const wt = createWorktree(repo, "task-abc", base);
  assert.ok(fs.existsSync(path.join(wt, "README.md")), "worktree has repo content");
  assert.ok(!wt.startsWith(repo), "worktree lives outside the main repo");
  // It is a linked worktree of the same repo.
  assert.equal(resolveWorkspaceRoot(wt), repo);

  removeWorktree(repo, wt);
  assert.equal(fs.existsSync(wt), false, "worktree removed");
});
