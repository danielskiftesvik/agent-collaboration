import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeRepo, isolateStateRoot, git, real } from "./helpers.mjs";
import { checkPreflight, readPreflightConfig } from "../core/preflight.mjs";
import { createWorktree, removeWorktree, worktreesDir } from "../core/workspace.mjs";

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

// #11: board-runner ran a review from its own nested, detached review-base
// checkout while two PBI worktrees existed — three linked worktrees, none the
// companion's, filled a cap of 3 before the companion created anything.
test("the worktree cap ignores linked worktrees the companion did not create", () => {
  isolateStateRoot();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, ".agent-collab.json"), JSON.stringify({ preflight: { maxWorktrees: 1 } }));
  git(["worktree", "add", "-q", ".worktrees/AB691"], repo);
  git(["worktree", "add", "-q", ".worktrees/AB686"], repo);
  git(["worktree", "add", "-q", "--detach", ".superpowers/board-runner/AB691/review-base", "HEAD"], repo);
  const reviewBase = path.join(repo, ".superpowers/board-runner/AB691/review-base");

  const result = checkPreflight(reviewBase);

  assert.equal(result.ok, true, result.failures.join("; "));
  assert.equal(result.linkedWorktrees, 3);
  assert.deepEqual(result.companionWorktrees, []);
});

test("the worktree cap counts companion job worktrees and its refusal names them", () => {
  isolateStateRoot();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, ".agent-collab.json"), JSON.stringify({ preflight: { maxWorktrees: 1 } }));
  git(["worktree", "add", "-q", ".worktrees/foreign"], repo);
  const job = createWorktree(repo, "job-a", "HEAD");
  try {
    const result = checkPreflight(repo);

    assert.equal(result.ok, false);
    assert.deepEqual(result.companionWorktrees, [job]);
    const failure = result.failures.join(" ");
    assert.match(failure, /worktree cap reached \(1\/1/);
    assert.ok(failure.includes(job), "the refusal names the counted worktree");
    assert.ok(!failure.includes(".worktrees/foreign"), "foreign worktrees are not blamed");
    assert.ok(failure.includes(path.join(repo, ".agent-collab.json")), "the refusal names the config that set the cap");
  } finally {
    removeWorktree(repo, job);
  }
});

test("companion job worktrees count whichever harness TMPDIR created them", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const otherTmp = real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-other-tmp-")));
  const job = path.join(otherTmp, "agent-collaboration-worktrees", path.basename(worktreesDir(repo)), "job-b");
  git(["worktree", "add", "-q", "--detach", job, "HEAD"], repo);

  const result = checkPreflight(repo, { maxWorktrees: 1 });

  assert.equal(result.ok, false);
  assert.deepEqual(result.companionWorktrees, [job]);
});

test("preflight limits come from the main checkout, not an older detached checkout", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, ".agent-collab.json"), JSON.stringify({ preflight: { maxWorktrees: 0 } }));
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "old cap"], repo);
  git(["worktree", "add", "-q", "--detach", ".superpowers/review-base", "HEAD"], repo);
  fs.writeFileSync(path.join(repo, ".agent-collab.json"), JSON.stringify({ preflight: { maxWorktrees: 8 } }));

  const config = readPreflightConfig(path.join(repo, ".superpowers/review-base"));

  assert.equal(config.maxWorktrees, 8);
  assert.equal(config._file, path.join(repo, ".agent-collab.json"));
});

test("preflight limits fall back to the nearest config above cwd when the main checkout has none", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, ".agent-collab.json"), JSON.stringify({ preflight: { maxWorktrees: 2 } }));
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "cap"], repo);
  git(["worktree", "add", "-q", "--detach", ".superpowers/review-base", "HEAD"], repo);
  git(["rm", "-q", ".agent-collab.json"], repo);
  const reviewBase = path.join(repo, ".superpowers/review-base");

  const config = readPreflightConfig(reviewBase);

  assert.equal(config.maxWorktrees, 2);
  assert.equal(config._file, path.join(reviewBase, ".agent-collab.json"));
});

// Codex review of #11: with separate Git metadata (submodules, --separate-git-dir)
// resolveWorkspaceRoot keys each checkout by its own toplevel, so a key-based
// ownership match missed jobs created from a sibling checkout — a cap bypass.
test("the worktree cap holds across checkouts with separate Git metadata", () => {
  isolateStateRoot();
  const parent = real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-sepgit-")));
  const repo = path.join(parent, "repo");
  git(["init", "-q", "-b", "main", "--separate-git-dir", path.join(parent, "meta.git"), repo], parent);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  fs.writeFileSync(path.join(repo, ".agent-collab.json"), JSON.stringify({ preflight: { maxWorktrees: 1 } }));
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "cap"], repo);
  git(["worktree", "add", "-q", "--detach", path.join(parent, "sibling"), "HEAD"], repo);
  const job = createWorktree(repo, "job-a", "HEAD");
  try {
    const result = checkPreflight(path.join(parent, "sibling"));

    // Git records no main checkout here, so the sibling's own config applies.
    assert.equal(result.config._file, path.join(parent, "sibling", ".agent-collab.json"));
    assert.equal(result.ok, false, "a job created from the main checkout counts from a sibling checkout");
    assert.deepEqual(result.companionWorktrees, [job]);
  } finally {
    removeWorktree(repo, job);
  }
});
