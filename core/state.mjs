// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI). State lives
// OUTSIDE the repo, in a directory keyed by a hash of the workspace root, so it
// survives git worktrees and is never committed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

// Stable, tool-owned fallback (persists across reboots, unlike tmp) used when no
// explicit data dir and no OWN plugin dir is available.
const FALLBACK_ROOT = path.join(os.homedir() || os.tmpdir(), ".agent-collaboration");
const STATE_VERSION = 1;
export const MAX_JOBS = 50;

// A terminal status is final — once reached, a later (possibly racing) update must
// not regress or overwrite it (e.g. a background launcher's post-spawn "running",
// or a `cancel` arriving after the worker already completed).
export const TERMINAL_STATUSES = new Set([
  "completed",
  "no-changes",
  "conflicted",
  "breach",
  "blocked",
  "failed",
  "cancelled"
]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * Serialize state read-modify-write across processes via an exclusive lockfile, so
 * two concurrent background workers can't lose each other's updates. Stale locks are
 * stolen, but a fresh lock is never bypassed: failing is safer than interleaving
 * read-modify-write and dropping jobs.
 */
function withLock(cwd, fn) {
  const dir = resolveStateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".lock");
  const timeoutMs = Number(process.env.AGENT_COLLAB_LOCK_TIMEOUT_MS) || 60000;
  const staleMs = Number(process.env.AGENT_COLLAB_STALE_LOCK_MS) || 10000;
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        /* lock vanished — retry */
      }
      if (Date.now() > deadline) throw new Error(`state lock busy after ${timeoutMs}ms: ${lock}`);
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
        fs.unlinkSync(lock);
      } catch {
        /* ignore */
      }
    }
  }
}

function stateBaseDir() {
  const explicit = process.env.AGENT_COLLAB_DATA;
  if (explicit) return explicit;
  // Reuse CLAUDE_PLUGIN_DATA ONLY when it is OUR plugin's dir. In a multi-plugin
  // session it can point at a SIBLING plugin's dir (observed: codex's), and
  // nesting our state there silently cross-namespaces it — a job created in one
  // context becomes invisible to status/result/apply in another. Otherwise fall
  // back to a stable, agent-collaboration-owned directory.
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData && /agent-collaboration/i.test(pluginData)) return path.join(pluginData, "state");
  return FALLBACK_ROOT;
}

export function resolveStateDir(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  const slug =
    (path.basename(root) || "workspace")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(stateBaseDir(), `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "state.json");
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveStateDir(cwd), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: { stopReviewGate: false, artifactRetentionDays: 30 },
    jobs: []
  };
}

export function loadStateWithStatus(cwd) {
  const file = resolveStateFile(cwd);
  if (!fs.existsSync(file)) return { state: defaultState(), reliable: false, reason: "missing" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
      return { state: defaultState(), reliable: false, reason: "invalid-shape" };
    }
    const base = defaultState();
    return { state: {
      ...base,
      ...parsed,
      config: { ...base.config, ...(parsed.config ?? {}) },
      jobs: parsed.jobs
    }, reliable: true, reason: null };
  } catch {
    return { state: defaultState(), reliable: false, reason: "corrupt" };
  }
}

export function loadState(cwd) {
  return loadStateWithStatus(cwd).state;
}

/** Write the whole state atomically (write temp + rename = single-writer safe). */
export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const file = resolveStateFile(cwd);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
  );
}

export function getJob(cwd, id) {
  return loadState(cwd).jobs.find((job) => job.id === id);
}

function pruneTerminalHistory(jobs) {
  const terminal = jobs.filter((job) => isTerminalStatus(job.status));
  if (terminal.length <= MAX_JOBS) return jobs;
  // An old, long-running job may complete after many newer jobs. Rank terminal
  // history by its latest update, not insertion position, or that just-finished
  // result would be evicted in the same write that made it terminal.
  const newest = [...terminal].sort((a, b) =>
    String(a.updatedAt ?? a.createdAt ?? "").localeCompare(String(b.updatedAt ?? b.createdAt ?? ""))
  );
  const keep = new Set(newest.slice(newest.length - MAX_JOBS));
  return jobs.filter((job) => !isTerminalStatus(job.status) || keep.has(job));
}

export function appendJob(cwd, job) {
  return withLock(cwd, () => {
    const state = loadState(cwd);
    const stamped = { createdAt: nowIso(), updatedAt: nowIso(), ...job };
    if (isTerminalStatus(stamped.status) && !stamped.terminalAt) {
      stamped.terminalAt = stamped.updatedAt;
    }
    state.jobs.push(stamped);
    // MAX_JOBS caps terminal history only. Active records are liveness and cleanup
    // authority; evicting one can orphan a live worker and its large worktree.
    state.jobs = pruneTerminalHistory(state.jobs);
    saveState(cwd, state);
    return stamped;
  });
}

export function updateJob(cwd, id, patch) {
  return withLock(cwd, () => {
    const state = loadState(cwd);
    const job = state.jobs.find((j) => j.id === id);
    if (!job) return undefined;
    const next = { ...patch };
    // Terminal is final: don't let a racing/late update regress or overwrite a
    // job that already reached a terminal status.
    if (isTerminalStatus(job.status) && "status" in next && next.status !== job.status) {
      delete next.status;
    }
    const stamp = nowIso();
    if (!isTerminalStatus(job.status) && isTerminalStatus(next.status) && !next.terminalAt) {
      next.terminalAt = stamp;
    }
    Object.assign(job, next, { updatedAt: stamp });
    state.jobs = pruneTerminalHistory(state.jobs);
    saveState(cwd, state);
    return job;
  });
}
