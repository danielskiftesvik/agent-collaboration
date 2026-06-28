import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeRepo, git } from "./helpers.mjs";
import { headRef, captureWorkingDiff, applyPatch, diffPaths, stageDiffIntoWorktree, workingTreeStatus, newStatusPaths } from "../core/git.mjs";

test("breach snapshot detects a CONTENT change to an ALREADY-dirty file (codex #4)", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "seed\ndirty\n"); // pre-existing dirt
  const before = workingTreeStatus(repo);
  // an escaped worker modifies the SAME already-dirty file (status line unchanged)
  fs.writeFileSync(path.join(repo, "README.md"), "seed\ndirty\nESCAPED\n");
  const after = workingTreeStatus(repo);
  assert.deepEqual(newStatusPaths(before, after), ["README.md"], "content hash change is caught");
});

test("breach snapshot reports nothing when the real tree is unchanged across a run", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "seed\ndirty\n");
  const before = workingTreeStatus(repo);
  const after = workingTreeStatus(repo);
  assert.deepEqual(newStatusPaths(before, after), []);
});

test("headRef returns the current commit sha", () => {
  const repo = makeRepo();
  const sha = headRef(repo);
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test("captureWorkingDiff + applyPatch reproduces an edit on a clean checkout", () => {
  const repo = makeRepo();
  // Make an edit + a new file in the working tree.
  fs.writeFileSync(path.join(repo, "README.md"), "seed\nmore\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "brand new\n");
  const diff = captureWorkingDiff(repo);
  assert.match(diff, /new\.txt/);
  assert.match(diff, /more/);

  // Throw the working-tree changes away, then re-apply the captured patch.
  git(["checkout", "--", "."], repo);
  git(["clean", "-fdq"], repo);
  const result = applyPatch(repo, diff);

  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "seed\nmore\n");
  assert.equal(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), "brand new\n");
});

test("captureWorkingDiff(baseRef) captures changes even after the worker COMMITS them", () => {
  const repo = makeRepo();
  const base = headRef(repo);

  // A worker that edits AND commits inside its worktree (agy does this).
  fs.writeFileSync(path.join(repo, "README.md"), "seed\nfixed\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "worker committed the fix"], repo);

  // Working tree is now clean and HEAD has moved.
  assert.equal(captureWorkingDiff(repo).trim(), "", "no baseRef misses committed work");

  const diff = captureWorkingDiff(repo, base);
  assert.match(diff, /README\.md/);
  assert.match(diff, /fixed/);
});

test("diffPaths extracts touched paths (incl. new files), minus /dev/null", () => {
  const diff = [
    "diff --git a/utils/clamp.js b/utils/clamp.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/utils/clamp.js",
    "@@ -0,0 +1 @@",
    "+x"
  ].join("\n");
  assert.deepEqual(diffPaths(diff), ["utils/clamp.js"]);
});

test("applyPatch unstages ONLY the patch's paths, preserving pre-existing staged work", () => {
  const repo = makeRepo();
  // a worker patch that adds new.txt
  fs.writeFileSync(path.join(repo, "new.txt"), "from worker\n");
  const diff = captureWorkingDiff(repo);
  git(["checkout", "--", "."], repo);
  git(["clean", "-fdq"], repo);

  // the user has unrelated STAGED work
  fs.writeFileSync(path.join(repo, "mine.txt"), "my staged work\n");
  git(["add", "mine.txt"], repo);

  const result = applyPatch(repo, diff);
  assert.equal(result.applied, true);
  assert.equal(result.staged, false);
  // the worker's file is in the working tree but NOT staged
  assert.equal(fs.existsSync(path.join(repo, "new.txt")), true);
  const staged = git(["diff", "--cached", "--name-only"], repo).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(staged, ["mine.txt"], "only the user's pre-existing staged work remains staged");
});

test("applyPatch REJECTS a non-applying patch without dirtying the tree", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "data.txt"), "original\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "data"], repo);
  // a patch whose pre-image doesn't match (won't apply, no 3-way base available)
  const badDiff = [
    "diff --git a/data.txt b/data.txt",
    "--- a/data.txt",
    "+++ b/data.txt",
    "@@ -1 +1 @@",
    "-totally different preimage",
    "+changed",
    ""
  ].join("\n");

  const result = applyPatch(repo, badDiff);
  assert.equal(result.applied, false);
  assert.equal(result.conflicted, true);
  assert.equal(fs.readFileSync(path.join(repo, "data.txt"), "utf8"), "original\n", "tree untouched");
  assert.equal(git(["status", "--porcelain"], repo), "", "no conflict markers / dirty index left behind");
});

test("stageDiffIntoWorktree cleans the worktree when the diff fails to apply", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "data.txt"), "original\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "data"], repo);
  const badDiff = [
    "diff --git a/data.txt b/data.txt",
    "--- a/data.txt",
    "+++ b/data.txt",
    "@@ -1 +1 @@",
    "-nonmatching",
    "+changed",
    ""
  ].join("\n");

  const r = stageDiffIntoWorktree(repo, badDiff);
  assert.equal(r.staged, false);
  assert.equal(git(["status", "--porcelain"], repo), "", "worktree reset clean after a failed stage");
  assert.equal(fs.readFileSync(path.join(repo, "data.txt"), "utf8"), "original\n");
});

test("applyPatch --3way merges around an unrelated change", () => {
  const repo = makeRepo();
  // Base file with several lines.
  fs.writeFileSync(path.join(repo, "data.txt"), "a\nb\nc\nd\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "data"], repo);

  // Patch changes the LAST line.
  fs.writeFileSync(path.join(repo, "data.txt"), "a\nb\nc\nD\n");
  const diff = captureWorkingDiff(repo);
  git(["checkout", "--", "."], repo);

  // Meanwhile main changed an UNRELATED (first) line.
  fs.writeFileSync(path.join(repo, "data.txt"), "A\nb\nc\nd\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "unrelated"], repo);

  const result = applyPatch(repo, diff);
  assert.equal(result.applied, true);
  assert.equal(result.conflicted, false);
  assert.equal(fs.readFileSync(path.join(repo, "data.txt"), "utf8"), "A\nb\nc\nD\n");
});
