// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI).
import { run, runOk } from "./process.mjs";

export function headRef(cwd) {
  return runOk("git", ["rev-parse", "HEAD"], { cwd }).trim();
}

/**
 * Capture a worker's changes as a unified diff. When `baseRef` is given, the
 * diff is taken from that commit to the current staged state — so it captures
 * the worker's full delta whether it left changes uncommitted OR committed them
 * inside the worktree (autonomous harnesses like agy often `git commit`). New
 * files appear with their blob index lines (which `git apply --3way` needs).
 * The index is staged transiently; the working tree is untouched.
 */
export function captureWorkingDiff(cwd, baseRef) {
  runOk("git", ["add", "-A"], { cwd });
  const args = ["diff", "--cached", ...(baseRef ? [baseRef] : [])];
  const diff = runOk("git", args, { cwd });
  run("git", ["reset", "-q"], { cwd });
  return diff;
}

/** Dry-run: would this diff apply (3-way) to `cwd`? Empty diffs trivially apply. */
export function checkPatchApplies(cwd, diff) {
  if (!diff || !diff.trim()) return true;
  const r = run("git", ["apply", "--check", "--3way", "--whitespace=nowarn"], {
    cwd,
    input: diff
  });
  return r.status === 0;
}

/**
 * Apply a unified diff to `cwd` using a 3-way merge so it still lands when the
 * base has moved underneath it. Returns { applied, conflicted, stderr }.
 */
export function applyPatch(cwd, diff) {
  if (!diff || !diff.trim()) {
    return { applied: true, conflicted: false, stderr: "", empty: true };
  }
  const r = run("git", ["apply", "--3way", "--whitespace=nowarn"], {
    cwd,
    input: diff
  });
  return {
    applied: r.status === 0,
    conflicted: r.status !== 0 && /conflict/i.test(r.stderr),
    stderr: r.stderr
  };
}
