import fs from "node:fs";
import path from "node:path";

import { isPidAlive } from "./heartbeat.mjs";
import { isTerminalStatus, loadState, loadStateWithStatus, resolveStateDir, updateJob } from "./state.mjs";
import {
  isManagedWorktree,
  pruneWorktrees,
  removeWorktree,
  worktreesDir
} from "./workspace.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UNKNOWN_WORKTREE_GRACE_MS = DAY_MS;
const DEFAULT_TERMINAL_LIVE_GRACE_MS = 60 * 60 * 1000;

function directoryEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

function entryAgeMs(target, nowMs) {
  try {
    return Math.max(0, nowMs - fs.statSync(target).mtimeMs);
  } catch {
    return 0;
  }
}

function recordAgeMs(record, nowMs) {
  const stamp = Date.parse(record?.heartbeatAt ?? record?.updatedAt ?? record?.createdAt ?? "");
  return Number.isFinite(stamp) ? Math.max(0, nowMs - stamp) : Infinity;
}

function scanTree(target, inPatches = false) {
  let bytes = 0;
  let latestMtimeMs = 0;
  let hasPatch = false;
  const visit = (current, patchScope) => {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return;
    }
    latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) {
      bytes += stat.size;
      if (patchScope && stat.size > 0) hasPatch = true;
      return;
    }
    let children = [];
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      visit(path.join(current, child.name), patchScope || child.name === "patches");
    }
  };
  visit(target, inPatches);
  return { bytes, latestMtimeMs, hasPatch };
}

function asRetentionDays(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function configuredArtifactRetentionDays(cwd, options = {}) {
  const state = options.state ?? loadState(cwd);
  const fromEnv = asRetentionDays(process.env.AGENT_COLLAB_ARTIFACT_RETENTION_DAYS, undefined);
  return asRetentionDays(
    options.artifactRetentionDays,
    fromEnv ?? asRetentionDays(state.config?.artifactRetentionDays, 30)
  );
}

/**
 * Remove one job's worktree only when it is terminal, no process is alive, and
 * the path is a direct child of this repository's plugin-owned temp root.
 */
export function cleanupJobWorktree(cwd, job, options = {}) {
  const target = job?.workspace;
  const result = { id: job?.id ?? path.basename(target ?? ""), path: target ?? null, removed: false };
  if (!target) return { ...result, reason: "no-worktree" };
  if (!isManagedWorktree(cwd, target)) return { ...result, reason: "outside-managed-root" };
  if (!isTerminalStatus(job?.status)) return { ...result, reason: "nonterminal" };
  if (job?.pid && isPidAlive(job.pid)) {
    const terminalStamp = Date.parse(job.completedAt ?? job.terminalAt ?? job.updatedAt ?? job.createdAt ?? "");
    const terminalAgeMs = Number.isFinite(terminalStamp)
      ? Math.max(0, (options.nowMs ?? Date.now()) - terminalStamp)
      : 0;
    const liveGraceMs = options.terminalLiveGraceMs ?? DEFAULT_TERMINAL_LIVE_GRACE_MS;
    if (terminalAgeMs < liveGraceMs) {
      return { ...result, reason: "live-process", terminalAgeMs };
    }
    result.livePidPastGrace = true;
  }
  if (!fs.existsSync(target)) {
    pruneWorktrees(cwd);
    return { ...result, reason: "already-missing" };
  }
  const { bytes } = scanTree(target);
  if (options.dryRun) return { ...result, removed: true, bytes, dryRun: true };
  try {
    removeWorktree(cwd, target);
    return { ...result, removed: true, bytes };
  } catch (error) {
    return { ...result, reason: "remove-failed", error: error?.message || String(error) };
  }
}

/** Synchronously wait a short, bounded period for a cancelled process to exit. */
export function waitForPidExit(pid, timeoutMs = 4000, pollMs = 50) {
  if (!pid) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (isPidAlive(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
  return !isPidAlive(pid);
}

function collectWorktrees(cwd, state, options) {
  const nowMs = options.nowMs ?? Date.now();
  const unknownGraceMs = options.unknownWorktreeGraceMs ?? DEFAULT_UNKNOWN_WORKTREE_GRACE_MS;
  const root = worktreesDir(cwd);
  const jobs = new Map(state.jobs.map((job) => [job.id, job]));
  const removed = [];
  const skipped = [];
  const reconciled = [];
  const entries = directoryEntries(root);
  const presentIds = new Set(entries.map((entry) => entry.name));

  for (const entry of entries) {
    const target = path.join(root, entry.name);
    const known = jobs.get(entry.name);
    if (!known) {
      if (options.stateReliable === false) {
        skipped.push({ id: entry.name, path: target, reason: "state-unavailable" });
        continue;
      }
      const ageMs = entryAgeMs(target, nowMs);
      if (ageMs < unknownGraceMs) {
        skipped.push({ id: entry.name, path: target, reason: "unknown-within-grace", ageMs });
        continue;
      }
      const { bytes } = scanTree(target);
      if (!options.dryRun) {
        try {
          removeWorktree(cwd, target);
        } catch (error) {
          skipped.push({ id: entry.name, path: target, reason: "remove-failed", error: error?.message || String(error) });
          continue;
        }
      }
      removed.push({ id: entry.name, path: target, bytes, reason: "unknown-past-grace", dryRun: !!options.dryRun });
      continue;
    }

    let job = { ...known, workspace: target };
    if (!isTerminalStatus(job.status)) {
      if (job.pid && isPidAlive(job.pid)) {
        skipped.push({ id: job.id, path: target, reason: "live-process" });
        continue;
      }
      const noPidAgeMs = entryAgeMs(target, nowMs);
      const deadGraceMs = options.deadJobGraceMs ?? 2 * 60 * 1000;
      if (!job.pid && noPidAgeMs < deadGraceMs) {
        skipped.push({ id: job.id, path: target, reason: "nonterminal-within-grace", ageMs: noPidAgeMs });
        continue;
      }
      if (!options.dryRun) {
        job = updateJob(cwd, job.id, {
          status: "failed",
          failureKind: "stalled",
          errors: ["the background worker process exited without writing a result"]
        }) ?? job;
        job = { ...job, workspace: target };
      } else {
        job = { ...job, status: "failed" };
      }
    }

    const cleanup = cleanupJobWorktree(cwd, job, options);
    (cleanup.removed ? removed : skipped).push(cleanup);
    if (!options.dryRun && cleanup.removed) {
      updateJob(cwd, job.id, { worktreeCleanup: cleanup });
    }
  }
  if (options.stateReliable !== false) {
    const deadGraceMs = options.deadJobGraceMs ?? 2 * 60 * 1000;
    for (const job of state.jobs) {
      if (isTerminalStatus(job.status) || presentIds.has(job.id)) continue;
      if (job.pid && isPidAlive(job.pid)) {
        skipped.push({ id: job.id, path: job.workspace ?? null, reason: "live-process-worktree-missing" });
        continue;
      }
      const ageMs = recordAgeMs(job, nowMs);
      if (!job.pid && ageMs < deadGraceMs) {
        skipped.push({ id: job.id, path: job.workspace ?? null, reason: "nonterminal-within-grace", ageMs });
        continue;
      }
      const item = {
        id: job.id,
        path: job.workspace ?? null,
        reason: "dead-job-worktree-missing",
        dryRun: !!options.dryRun
      };
      if (!options.dryRun) {
        updateJob(cwd, job.id, {
          status: "failed",
          failureKind: "stalled",
          errors: ["the background worker process exited without writing a result"],
          worktreeCleanup: { ...item, removed: false, reason: "already-missing" }
        });
      }
      reconciled.push(item);
    }
  }
  pruneWorktrees(cwd);
  return {
    removed,
    skipped,
    reconciled,
    bytesFreed: removed.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
  };
}

function collectArtifacts(cwd, state, options) {
  const retentionDays = configuredArtifactRetentionDays(cwd, { ...options, state });
  const removed = [];
  const skipped = [];
  if (!(retentionDays > 0)) return { retentionDays, removed, skipped, bytesFreed: 0, disabled: true };

  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const tasksRoot = path.join(resolveStateDir(cwd), "tasks");
  const jobs = new Map(state.jobs.map((job) => [job.id, job]));
  const entries = directoryEntries(tasksRoot);
  if (options.stateReliable === false) {
    return {
      retentionDays,
      removed,
      skipped: entries.map((entry) => ({
        id: entry.name,
        path: path.join(tasksRoot, entry.name),
        reason: "state-unavailable"
      })),
      bytesFreed: 0,
      scanned: 0
    };
  }
  let scanned = 0;
  const maxScans = Number.isFinite(options.maxArtifactScans)
    ? Math.max(0, options.maxArtifactScans)
    : Infinity;
  for (const entry of entries) {
    const target = path.join(tasksRoot, entry.name);
    const job = jobs.get(entry.name);
    if (job && !isTerminalStatus(job.status)) {
      skipped.push({ id: entry.name, path: target, reason: "active-job" });
      continue;
    }
    let rootMtimeMs = 0;
    try { rootMtimeMs = fs.statSync(target).mtimeMs; } catch { /* scan reports/removes races below */ }
    if (rootMtimeMs >= cutoffMs) {
      skipped.push({ id: entry.name, path: target, reason: "within-retention" });
      continue;
    }
    if (scanned >= maxScans) {
      skipped.push({ id: entry.name, path: target, reason: "scan-budget" });
      continue;
    }
    scanned += 1;
    const patchScan = scanTree(path.join(target, "patches"), true);
    if (patchScan.hasPatch && !options.includeUnapplied && job?.applied !== true) {
      skipped.push({ id: entry.name, path: target, reason: "unapplied-patch" });
      continue;
    }
    const scan = scanTree(target);
    if (scan.latestMtimeMs >= cutoffMs) {
      skipped.push({ id: entry.name, path: target, reason: "within-retention" });
      continue;
    }
    const item = {
      id: entry.name,
      path: target,
      bytes: scan.bytes,
      reason: job?.applied === true ? "expired-applied-patch" : "expired-artifact",
      dryRun: !!options.dryRun
    };
    if (!options.dryRun) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (error) {
        skipped.push({ ...item, reason: "remove-failed", error: error?.message || String(error) });
        continue;
      }
    }
    removed.push(item);
  }
  return {
    retentionDays,
    removed,
    skipped,
    bytesFreed: removed.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    scanned
  };
}

/** Liveness-aware worktree janitor plus conservative, disk-enumerated artifact retention. */
export function collectGarbage(cwd, options = {}) {
  const loaded = loadStateWithStatus(cwd);
  const effectiveOptions = { ...options, stateReliable: loaded.reliable };
  return {
    dryRun: !!options.dryRun,
    stateReliable: loaded.reliable,
    stateReason: loaded.reason,
    worktrees: collectWorktrees(cwd, loaded.state, effectiveOptions),
    artifacts: collectArtifacts(cwd, loaded.state, effectiveOptions)
  };
}
