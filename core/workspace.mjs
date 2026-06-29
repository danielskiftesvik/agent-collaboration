// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI): the original
// resolveWorkspaceRoot keyed state by the git toplevel. This version resolves the
// MAIN workspace root even when called inside a linked worktree, so a worker
// running in a worktree shares state/artifacts with its driver.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveStateDir } from "./state.mjs";

function canonical(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

/**
 * Resolve the main workspace root for `cwd`.
 *
 * Uses `--git-common-dir`, which points at the *shared* .git directory even from
 * a linked worktree, so every worktree of a repo maps to the same root. Falls
 * back to the git toplevel, then to `cwd` when not in a repo at all.
 */
export function resolveWorkspaceRoot(cwd) {
  try {
    const commonDir = git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd
    );
    if (commonDir && path.basename(commonDir) === ".git") {
      return canonical(path.dirname(commonDir));
    }
  } catch {
    // not a git repo, or git unavailable — fall through
  }
  try {
    const top = git(["rev-parse", "--show-toplevel"], cwd);
    if (top) return canonical(top);
  } catch {
    // fall through
  }
  return canonical(cwd);
}

/** Directory (outside the repo) where ephemeral worktrees for a workspace live. */
export function worktreesDir(cwd) {
  // agy ignores workspace URIs under hidden directories; keep state hidden, but
  // put ephemeral git worktrees in a visible temp root.
  return path.join(os.tmpdir(), "agent-collaboration-worktrees", path.basename(resolveStateDir(cwd)));
}

/**
 * Create a detached linked worktree at `baseRef`, located outside the repo under
 * the workspace state dir. Detached (not a new branch) so parallel workers never
 * collide on branch names. Returns the canonical worktree path.
 */
export function createWorktree(cwd, name, baseRef) {
  const root = resolveWorkspaceRoot(cwd);
  const dir = worktreesDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  git(["worktree", "add", "--detach", "-q", target, baseRef], root);
  return canonical(target);
}

/** Remove a worktree and prune its administrative entry. */
export function removeWorktree(cwd, worktreePath) {
  const root = resolveWorkspaceRoot(cwd);
  try {
    git(["worktree", "remove", "--force", worktreePath], root);
  } catch {
    // Already gone, or never registered — fall back to manual cleanup.
    fs.rmSync(worktreePath, { recursive: true, force: true });
    git(["worktree", "prune"], root);
  }
}
