import fs from "node:fs";
import path from "node:path";

import { run } from "./process.mjs";
import { PIN_FILE } from "./pins.mjs";
import { resolveWorkspaceRoot, worktreesDir } from "./workspace.mjs";

function findConfig(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, PIN_FILE);
    if (fs.existsSync(file)) return file;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Limits guard resources the whole repository shares, so the main checkout's
 * config wins: a review run from an older detached checkout (#11: board-runner's
 * review-base) must not be held to the cap that checkout happened to commit.
 * Falls back to the nearest config walking up from `cwd`.
 */
export function readPreflightConfig(cwd) {
  const mainFile = path.join(resolveWorkspaceRoot(cwd), PIN_FILE);
  const file = fs.existsSync(mainFile) ? mainFile : findConfig(cwd);
  if (!file) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")).preflight;
    return value && typeof value === "object" ? { ...value, _file: file } : {};
  } catch (error) {
    return { _error: `cannot parse ${file}: ${error.message}` };
  }
}

/**
 * Job worktrees this runtime created for `cwd`'s repository. Matched by the
 * `agent-collaboration-worktrees/<repo key>/<job>` shape rather than one
 * absolute root, because each driving harness may run with its own TMPDIR.
 * Host-repo worktrees (PBI checkouts, board-runner's review-base) never match.
 */
function companionWorktrees(cwd, paths) {
  const own = worktreesDir(cwd);
  const key = path.basename(own);
  const rootName = path.basename(path.dirname(own));
  return paths.filter((p) => path.basename(path.dirname(p)) === key && path.basename(path.dirname(path.dirname(p))) === rootName);
}

/** Enforce optional, repo-owned resource limits before creating another worktree. */
export function checkPreflight(cwd, config = readPreflightConfig(cwd)) {
  const failures = [];
  if (config._error) failures.push(config._error);
  const worktrees = run("git", ["worktree", "list", "--porcelain"], { cwd });
  // The first entry is the main checkout; the rest are linked worktrees.
  const linkedPaths = worktrees.status === 0
    ? worktrees.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).slice(1).map((line) => line.slice("worktree ".length).trim())
    : null;
  const linkedWorktrees = linkedPaths?.length ?? null;
  const owned = linkedPaths ? companionWorktrees(cwd, linkedPaths) : null;
  if (Number.isFinite(config.maxWorktrees) && owned == null) {
    failures.push(`cannot evaluate worktree cap: ${worktrees.stderr || "git worktree list failed"}`);
  } else if (Number.isFinite(config.maxWorktrees) && owned.length >= config.maxWorktrees) {
    failures.push(
      `companion worktree cap reached (${owned.length}/${config.maxWorktrees}` +
        `${config._file ? ` from ${config._file}` : ""}): ${owned.join(", ") || "(none)"}. ` +
        "Run `gc` to reclaim finished jobs' worktrees, or raise preflight.maxWorktrees."
    );
  }

  let freeDiskGb = null;
  const disk = run("df", ["-Pk", cwd], { cwd });
  if (disk.status === 0) {
    const fields = disk.stdout.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/);
    const availableKb = Number(fields?.[3]);
    if (Number.isFinite(availableKb)) freeDiskGb = availableKb / 1024 / 1024;
  }
  if (Number.isFinite(config.minFreeDiskGb) && freeDiskGb == null) {
    failures.push(`cannot evaluate free disk: ${disk.stderr || "df output was unavailable or invalid"}`);
  } else if (Number.isFinite(config.minFreeDiskGb) && freeDiskGb < config.minFreeDiskGb) {
    failures.push(`free disk is ${freeDiskGb.toFixed(1)} GB; ${config.minFreeDiskGb} GB required`);
  }
  return { ok: failures.length === 0, failures, linkedWorktrees, companionWorktrees: owned, freeDiskGb, config };
}
