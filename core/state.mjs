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
  return { version: STATE_VERSION, config: { stopReviewGate: false }, jobs: [] };
}

export function loadState(cwd) {
  const file = resolveStateFile(cwd);
  if (!fs.existsSync(file)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      config: { ...base.config, ...(parsed.config ?? {}) },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
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

export function appendJob(cwd, job) {
  return withLock(cwd, () => {
    const state = loadState(cwd);
    const stamped = { createdAt: nowIso(), updatedAt: nowIso(), ...job };
    state.jobs.push(stamped);
    if (state.jobs.length > MAX_JOBS) {
      state.jobs = state.jobs.slice(state.jobs.length - MAX_JOBS);
    }
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
    Object.assign(job, next, { updatedAt: nowIso() });
    saveState(cwd, state);
    return job;
  });
}
