// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run, runOk } from "./process.mjs";

export function headRef(cwd) {
  return runOk("git", ["rev-parse", "HEAD"], { cwd }).trim();
}

function porcelainPath(line) {
  // strip the 2-char status + space; for renames take the post-`-> ` path
  const p = line.replace(/^.{1,3}/, "").trim();
  const arrow = p.lastIndexOf(" -> ");
  return arrow === -1 ? p : p.slice(arrow + 4).trim();
}

/**
 * Snapshot the working-tree state of `cwd` for breach detection: each dirty/untracked
 * path's `git status --porcelain` line PAIRED WITH a content hash. Hashing (not just
 * the status line) is what catches a worker escaping and MODIFYING an already-dirty
 * file — the status line is unchanged, but the content hash isn't. Returns null when
 * `cwd` isn't a git repo. (Ignored files are still invisible to porcelain — strict
 * sandbox confinement is the layer for those.)
 */
export function workingTreeStatus(cwd) {
  const r = run("git", ["status", "--porcelain"], { cwd });
  if (r.status !== 0) return null;
  const entries = new Set();
  for (const line of r.stdout.split(/\r?\n/).filter((l) => l.trim())) {
    let hash = "";
    try {
      hash = createHash("sha1").update(fs.readFileSync(path.join(cwd, porcelainPath(line)))).digest("hex");
    } catch {
      hash = ""; // deleted / unreadable / rename — status-line change alone still counts
    }
    entries.add(`${line}\t${hash}`);
  }
  return entries;
}

/** Paths whose status OR content newly appeared/changed in `after` vs `before`. */
export function newStatusPaths(before, after) {
  if (!before || !after) return [];
  const added = new Set();
  for (const entry of after) {
    if (!before.has(entry)) added.add(porcelainPath(entry.split("\t")[0]));
  }
  return [...added];
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
  if (r.status !== 0) {
    // A partial/3-way apply can leave conflict markers + an unmerged index. Reset
    // the worktree to a clean HEAD baseline so the reviewer doesn't read a fake,
    // half-applied state (the caller falls back to the pasted-diff path).
    run("git", ["reset", "-q", "--hard"], { cwd: worktree });
    run("git", ["clean", "-fdq"], { cwd: worktree });
    return { staged: false, reason: r.stderr || "patch did not apply to HEAD" };
  }
  run("git", ["add", "-A"], { cwd: worktree });
  const s = run("git", ["diff", "--cached", "--stat"], { cwd: worktree });
  return { staged: true, stat: s.status === 0 ? s.stdout.trim() : "" };
}

/** Paths a unified diff touches (a/ and b/ sides, minus /dev/null), for targeted unstaging. */
export function diffPaths(diff) {
  const paths = new Set();
  const s = String(diff ?? "");
  for (const m of s.matchAll(/^\+\+\+ b\/(.+)$/gm)) paths.add(m[1].trim());
  for (const m of s.matchAll(/^--- a\/(.+)$/gm)) paths.add(m[1].trim());
  for (const m of s.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    paths.add(m[1].trim());
    paths.add(m[2].trim());
  }
  paths.delete("/dev/null");
  return [...paths];
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
 *
 * Safety:
 *  - DRY-RUN FIRST (`--check`): a patch that won't apply cleanly is rejected
 *    WITHOUT touching the tree (no half-applied conflict markers on an
 *    `applied:false` result).
 *  - `--3way` implies `--index`, so the apply stages the change; we then unstage
 *    ONLY the patch's own paths, landing it in the WORKING TREE while preserving
 *    any pre-existing staged work (so it never commingles with the user's index).
 */
export function applyPatch(cwd, diff) {
  if (!diff || !diff.trim()) {
    return { applied: true, conflicted: false, staged: false, stderr: "", empty: true };
  }
  if (!checkPatchApplies(cwd, diff)) {
    return {
      applied: false,
      conflicted: true,
      staged: false,
      stderr: "patch does not apply cleanly (3-way); tree left untouched"
    };
  }
  const r = run("git", ["apply", "--3way", "--whitespace=nowarn"], { cwd, input: diff });
  if (r.status !== 0) {
    return { applied: false, conflicted: /conflict/i.test(r.stderr), staged: false, stderr: r.stderr };
  }
  // Unstage exactly the patch's paths (preserve any pre-existing staged work).
  const paths = diffPaths(diff);
  if (paths.length) run("git", ["reset", "-q", "--", ...paths], { cwd });
  return { applied: true, conflicted: false, staged: false, stderr: r.stderr };
}
