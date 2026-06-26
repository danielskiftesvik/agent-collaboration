// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI). State lives
// OUTSIDE the repo, in a directory keyed by a hash of the workspace root, so it
// survives git worktrees and is never committed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const FALLBACK_ROOT = path.join(os.tmpdir(), "agent-collaboration");
const STATE_VERSION = 1;
export const MAX_JOBS = 50;

function stateBaseDir() {
  const explicit = process.env.AGENT_COLLAB_DATA;
  if (explicit) return explicit;
  // When running as a Claude Code plugin, reuse its per-plugin data dir.
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return path.join(pluginData, "state");
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
  const state = loadState(cwd);
  const stamped = { createdAt: nowIso(), updatedAt: nowIso(), ...job };
  state.jobs.push(stamped);
  if (state.jobs.length > MAX_JOBS) {
    state.jobs = state.jobs.slice(state.jobs.length - MAX_JOBS);
  }
  saveState(cwd, state);
  return stamped;
}

export function updateJob(cwd, id, patch) {
  const state = loadState(cwd);
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return undefined;
  Object.assign(job, patch, { updatedAt: nowIso() });
  saveState(cwd, state);
  return job;
}
