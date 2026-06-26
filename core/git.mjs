// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI).
import { run, runOk } from "./process.mjs";

export function headRef(cwd) {
  return runOk("git", ["rev-parse", "HEAD"], { cwd }).trim();
}

/**
 * Capture all working-tree changes (including new files) as a unified diff,
 * without leaving the index modified. Staging is used only transiently so that
 * untracked files appear in the patch with their blob index lines (which
 * `git apply --3way` needs for its merge fallback).
 */
export function captureWorkingDiff(cwd) {
  runOk("git", ["add", "-A"], { cwd });
  const diff = runOk("git", ["diff", "--cached"], { cwd });
  run("git", ["reset", "-q"], { cwd }); // restore index; working tree untouched
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
