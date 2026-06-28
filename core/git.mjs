// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI).
import { run, runOk } from "./process.mjs";

export function headRef(cwd) {
  return runOk("git", ["rev-parse", "HEAD"], { cwd }).trim();
}

/**
 * Snapshot the working-tree state of `cwd` as a set of `git status --porcelain`
 * lines (tracked changes + untracked files). Used to detect whether a worker
 * escaped its worktree and wrote into the driver's real checkout. Returns null
 * when `cwd` isn't a git repo (nothing to compare). Worktree add/remove does NOT
 * change these lines, so a difference across a run means a real-tree write.
 */
export function workingTreeStatus(cwd) {
  const r = run("git", ["status", "--porcelain"], { cwd });
  if (r.status !== 0) return null;
  return new Set(r.stdout.split(/\r?\n/).filter((l) => l.trim()));
}

/** Paths that newly appeared in `after` vs `before` (porcelain line -> path). */
export function newStatusPaths(before, after) {
  if (!before || !after) return [];
  const added = [];
  for (const line of after) {
    if (!before.has(line)) added.push(line.replace(/^.{1,3}/, "").trim());
  }
  return added;
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

/** Does this text look like a unified diff (vs. arbitrary prose to review)? */
export function looksLikeDiff(text) {
  if (typeof text !== "string") return false;
  return (
    /^diff --git /m.test(text) ||
    /^@@ -\d/m.test(text) ||
    (/^--- /m.test(text) && /^\+\+\+ /m.test(text))
  );
}

/**
 * Materialize a review's diff INTO the worker's worktree (apply + stage) so the
 * reviewer reads the actual post-change files and `git diff HEAD`, instead of a
 * stale HEAD baseline that can contradict a pasted diff. Best-effort: returns
 * {staged:false} when the input isn't a diff or doesn't apply, so the caller falls
 * back to the pasted-text path. (Reviewer worktrees are discarded, so staging is safe.)
 */
export function stageDiffIntoWorktree(worktree, diff) {
  if (!looksLikeDiff(diff)) return { staged: false, reason: "input is not a unified diff" };
  // git apply rejects a patch with no trailing newline; pasted/trimmed diffs often
  // lack one, so normalize.
  const patch = diff.endsWith("\n") ? diff : diff + "\n";
  const r = run("git", ["apply", "--3way", "--whitespace=nowarn"], { cwd: worktree, input: patch });
  if (r.status !== 0) return { staged: false, reason: r.stderr || "patch did not apply to HEAD" };
  run("git", ["add", "-A"], { cwd: worktree });
  const s = run("git", ["diff", "--cached", "--stat"], { cwd: worktree });
  return { staged: true, stat: s.status === 0 ? s.stdout.trim() : "" };
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
