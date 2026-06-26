import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeRepo, git } from "./helpers.mjs";
import { headRef, captureWorkingDiff, applyPatch } from "../core/git.mjs";

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
