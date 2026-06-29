import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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

test("createWorktree uses a visible path even when state lives under a dotdir", () => {
  const saved = process.env.AGENT_COLLAB_DATA;
  const stateRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ac-home-")), ".agent-collaboration");
  fs.mkdirSync(stateRoot);
  process.env.AGENT_COLLAB_DATA = stateRoot;

  const repo = makeRepo();
  const wt = createWorktree(repo, "task-visible", headRef(repo));
  const hiddenSegment = wt.split(path.sep).find((part) => part.startsWith("."));

  removeWorktree(repo, wt);
  if (saved === undefined) delete process.env.AGENT_COLLAB_DATA;
  else process.env.AGENT_COLLAB_DATA = saved;

  assert.equal(hiddenSegment, undefined, `worktree path must not contain hidden segments: ${wt}`);
});
