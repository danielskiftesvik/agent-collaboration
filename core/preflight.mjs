import fs from "node:fs";
import path from "node:path";

import { run } from "./process.mjs";
import { PIN_FILE } from "./pins.mjs";

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

export function readPreflightConfig(cwd) {
  const file = findConfig(cwd);
  if (!file) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")).preflight;
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    return { _error: `cannot parse ${file}: ${error.message}` };
  }
}

/** Enforce optional, repo-owned resource limits before creating another worktree. */
export function checkPreflight(cwd, config = readPreflightConfig(cwd)) {
  const failures = [];
  if (config._error) failures.push(config._error);
  const worktrees = run("git", ["worktree", "list", "--porcelain"], { cwd });
  const linkedWorktrees = worktrees.status === 0
    ? Math.max(0, worktrees.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length - 1)
    : null;
  if (Number.isFinite(config.maxWorktrees) && linkedWorktrees == null) {
    failures.push(`cannot evaluate worktree cap: ${worktrees.stderr || "git worktree list failed"}`);
  } else if (Number.isFinite(config.maxWorktrees) && linkedWorktrees >= config.maxWorktrees) {
    failures.push(`linked worktree cap reached (${linkedWorktrees}/${config.maxWorktrees})`);
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
  return { ok: failures.length === 0, failures, linkedWorktrees, freeDiskGb, config };
}
