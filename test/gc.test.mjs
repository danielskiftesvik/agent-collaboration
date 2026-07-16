import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { collectGarbage, cleanupJobWorktree } from "../core/gc.mjs";
import { headRef } from "../core/git.mjs";
import { appendJob, getJob, loadState, resolveStateDir, resolveStateFile, saveState } from "../core/state.mjs";
import { createWorktree, removeWorktree, worktreesDir } from "../core/workspace.mjs";
import { isolateStateRoot, makeRepo } from "./helpers.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_PID = 2_147_483_600;

function ageTree(target, mtimeMs) {
  if (!fs.existsSync(target)) return;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) ageTree(child, mtimeMs);
    else fs.utimesSync(child, mtimeMs / 1000, mtimeMs / 1000);
  }
  fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
}

function makeTask(cwd, id, { mtimeMs, patch = "", report = "report" } = {}) {
  const task = path.join(resolveStateDir(cwd), "tasks", id);
  fs.mkdirSync(path.join(task, "reports"), { recursive: true });
  fs.writeFileSync(path.join(task, "reports", "review.md"), report);
  if (patch) {
    fs.mkdirSync(path.join(task, "patches"), { recursive: true });
    fs.writeFileSync(path.join(task, "patches", "worker.diff"), patch);
  }
  if (mtimeMs != null) ageTree(task, mtimeMs);
  return task;
}

test("collector removes terminal and dead job worktrees but preserves a live job", (t) => {
  isolateStateRoot();
  const repo = makeRepo();
  const base = headRef(repo);
  const terminal = createWorktree(repo, "terminal-job", base);
  const dead = createWorktree(repo, "dead-job", base);
  const live = createWorktree(repo, "live-job", base);
  t.after(() => {
    if (fs.existsSync(live)) removeWorktree(repo, live);
  });

  appendJob(repo, { id: "terminal-job", status: "completed", workspace: terminal });
  appendJob(repo, { id: "dead-job", status: "running", pid: DEAD_PID, workspace: dead });
  appendJob(repo, { id: "live-job", status: "running", pid: process.pid, workspace: live });

  const result = collectGarbage(repo, { artifactRetentionDays: 0 });

  assert.equal(fs.existsSync(terminal), false);
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(live), true, "a live process always wins over age or stale metadata");
  assert.deepEqual(new Set(result.worktrees.removed.map((item) => item.id)), new Set(["terminal-job", "dead-job"]));
  assert.equal(getJob(repo, "dead-job").status, "failed");
  assert.equal(getJob(repo, "dead-job").failureKind, "stalled");
});

test("collector preserves fresh unknown worktrees and removes only old unknown worktrees", () => {
  isolateStateRoot();
  const repo = makeRepo();
  saveState(repo, loadState(repo));
  const nowMs = Date.now();
  const root = worktreesDir(repo);
  const fresh = path.join(root, "fresh-unknown");
  const old = path.join(root, "old-unknown");
  fs.mkdirSync(fresh, { recursive: true });
  fs.mkdirSync(old, { recursive: true });
  ageTree(old, nowMs - 2 * DAY_MS);

  const result = collectGarbage(repo, {
    nowMs,
    unknownWorktreeGraceMs: DAY_MS,
    artifactRetentionDays: 0
  });

  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(old), false);
  assert.ok(result.worktrees.skipped.some((item) => item.id === "fresh-unknown"));
  fs.rmSync(fresh, { recursive: true, force: true });
});

test("collector fails closed when state is corrupt instead of treating live worktrees as unknown debris", (t) => {
  isolateStateRoot();
  const repo = makeRepo();
  const workspace = createWorktree(repo, "live-before-corruption", headRef(repo));
  t.after(() => {
    if (fs.existsSync(workspace)) removeWorktree(repo, workspace);
  });
  appendJob(repo, {
    id: "live-before-corruption",
    status: "running",
    pid: process.pid,
    workspace
  });
  const old = Date.now() - 2 * DAY_MS;
  ageTree(workspace, old);
  fs.writeFileSync(resolveStateFile(repo), "{ corrupt");

  const result = collectGarbage(repo, { nowMs: Date.now(), unknownWorktreeGraceMs: DAY_MS });

  assert.equal(result.stateReliable, false);
  assert.equal(fs.existsSync(workspace), true);
  assert.ok(result.worktrees.skipped.some((item) => item.reason === "state-unavailable"));
});

test("cleanupJobWorktree refuses paths outside the managed worktree root", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const result = cleanupJobWorktree(repo, { id: "unsafe", status: "completed", workspace: repo });
  assert.equal(result.removed, false);
  assert.equal(result.reason, "outside-managed-root");
  assert.equal(fs.existsSync(repo), true);
});

test("terminal worktrees converge after a bounded live-pid grace so PID reuse cannot pin them forever", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const workspace = createWorktree(repo, "terminal-reused-pid", headRef(repo));
  const nowMs = Date.now();
  appendJob(repo, {
    id: "terminal-reused-pid",
    status: "cancelled",
    pid: process.pid,
    workspace,
    updatedAt: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString()
  });

  const result = collectGarbage(repo, {
    nowMs,
    terminalLiveGraceMs: 60 * 60 * 1000,
    artifactRetentionDays: 0
  });

  assert.equal(fs.existsSync(workspace), false);
  assert.ok(result.worktrees.removed.some((item) => item.id === "terminal-reused-pid"));
});

test("collector reconciles dead nonterminal records even when their worktree is already missing", () => {
  isolateStateRoot();
  const repo = makeRepo();
  appendJob(repo, {
    id: "missing-dead-worktree",
    status: "running",
    pid: DEAD_PID,
    workspace: path.join(worktreesDir(repo), "missing-dead-worktree")
  });

  const result = collectGarbage(repo, { artifactRetentionDays: 0 });

  assert.equal(getJob(repo, "missing-dead-worktree").status, "failed");
  assert.equal(getJob(repo, "missing-dead-worktree").failureKind, "stalled");
  assert.ok(result.worktrees.reconciled.some((item) => item.id === "missing-dead-worktree"));
});

test("artifact retention enumerates tasks on disk and protects active, recent, and unapplied work", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const nowMs = Date.now();
  const oldMs = nowMs - 45 * DAY_MS;
  const recentMs = nowMs - 2 * DAY_MS;
  const oldReview = makeTask(repo, "old-review", { mtimeMs: oldMs });
  const orphanReview = makeTask(repo, "orphan-review", { mtimeMs: oldMs });
  const oldPatch = makeTask(repo, "old-unapplied-patch", { mtimeMs: oldMs, patch: "diff --git a/a b/a\n" });
  const appliedPatch = makeTask(repo, "old-applied-patch", { mtimeMs: oldMs, patch: "diff --git a/a b/a\n" });
  const recent = makeTask(repo, "recent-review", { mtimeMs: recentMs });
  const active = makeTask(repo, "active-review", { mtimeMs: oldMs });

  appendJob(repo, { id: "old-review", status: "completed", artifactDir: oldReview });
  appendJob(repo, { id: "old-unapplied-patch", status: "completed", applied: false, artifactDir: oldPatch });
  appendJob(repo, { id: "old-applied-patch", status: "completed", applied: true, artifactDir: appliedPatch });
  appendJob(repo, { id: "recent-review", status: "completed", artifactDir: recent });
  appendJob(repo, { id: "active-review", status: "running", pid: process.pid, artifactDir: active });

  const result = collectGarbage(repo, { nowMs, artifactRetentionDays: 30 });

  assert.equal(fs.existsSync(oldReview), false);
  assert.equal(fs.existsSync(orphanReview), false, "retention must scan task directories missing from capped state");
  assert.equal(fs.existsSync(appliedPatch), false);
  assert.equal(fs.existsSync(oldPatch), true, "unapplied patches are durable by default");
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(active), true);
  assert.deepEqual(
    new Set(result.artifacts.removed.map((item) => item.id)),
    new Set(["old-review", "orphan-review", "old-applied-patch"])
  );
});

test("dry-run is non-mutating and includeUnapplied is an explicit destructive opt-in", () => {
  isolateStateRoot();
  const repo = makeRepo();
  saveState(repo, loadState(repo));
  const nowMs = Date.now();
  const task = makeTask(repo, "old-patch", {
    mtimeMs: nowMs - 45 * DAY_MS,
    patch: "diff --git a/a b/a\n"
  });

  const preview = collectGarbage(repo, {
    nowMs,
    artifactRetentionDays: 30,
    includeUnapplied: true,
    dryRun: true
  });
  assert.equal(fs.existsSync(task), true);
  assert.ok(preview.artifacts.removed.some((item) => item.id === "old-patch"));

  collectGarbage(repo, { nowMs, artifactRetentionDays: 30, includeUnapplied: true });
  assert.equal(fs.existsSync(task), false);
});

test("automatic artifact collection can bound recursive scans without losing candidates", () => {
  isolateStateRoot();
  const repo = makeRepo();
  saveState(repo, loadState(repo));
  const nowMs = Date.now();
  for (const id of ["old-a", "old-b", "old-c"]) {
    makeTask(repo, id, { mtimeMs: nowMs - 45 * DAY_MS });
  }

  const result = collectGarbage(repo, {
    nowMs,
    artifactRetentionDays: 30,
    maxArtifactScans: 1
  });

  assert.equal(result.artifacts.scanned, 1);
  assert.equal(result.artifacts.removed.length, 1);
  assert.equal(result.artifacts.skipped.filter((item) => item.reason === "scan-budget").length, 2);
});

test("the artifact scan budget also bounds old unapplied-patch inspection", () => {
  isolateStateRoot();
  const repo = makeRepo();
  saveState(repo, loadState(repo));
  const nowMs = Date.now();
  for (const id of ["patch-a", "patch-b", "patch-c"]) {
    makeTask(repo, id, {
      mtimeMs: nowMs - 45 * DAY_MS,
      patch: "diff --git a/a b/a\n"
    });
  }

  const result = collectGarbage(repo, {
    nowMs,
    artifactRetentionDays: 30,
    maxArtifactScans: 1
  });

  assert.equal(result.artifacts.scanned, 1);
  assert.equal(result.artifacts.skipped.filter((item) => item.reason === "unapplied-patch").length, 1);
  assert.equal(result.artifacts.skipped.filter((item) => item.reason === "scan-budget").length, 2);
});
