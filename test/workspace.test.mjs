import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeRepo, addWorktree, isolateStateRoot, real } from "./helpers.mjs";
import { resolveWorkspaceRoot } from "../core/workspace.mjs";
import { resolveStateDir } from "../core/state.mjs";

test("resolveWorkspaceRoot returns the repo root from a subdirectory", () => {
  const repo = makeRepo();
  const sub = path.join(repo, "a", "b");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(resolveWorkspaceRoot(sub), repo);
});

test("resolveWorkspaceRoot from a linked worktree returns the MAIN repo root", () => {
  const repo = makeRepo();
  const wt = addWorktree(repo, "wt");
  // The whole point: a worker running in a worktree must resolve to the
  // driver's main workspace, not its own worktree path.
  assert.equal(resolveWorkspaceRoot(wt), repo);
});

test("resolveWorkspaceRoot falls back to cwd outside any git repo", () => {
  const tmp = real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-nogit-")));
  assert.equal(resolveWorkspaceRoot(tmp), tmp);
});

test("resolveStateDir is shared across worktrees and lives outside the repo", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const wt = addWorktree(repo, "wt2");
  const fromMain = resolveStateDir(repo);
  const fromWorktree = resolveStateDir(wt);
  assert.equal(fromMain, fromWorktree, "state dir must match across worktrees");
  assert.ok(!fromMain.startsWith(repo), "state dir must live outside the repo");
});
