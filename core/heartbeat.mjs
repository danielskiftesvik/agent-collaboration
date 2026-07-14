// Stall detection: a worker is only "stalled" when its heartbeat is stale AND
// its process is gone. A stale heartbeat alone can just mean a long, legitimate
// step (e.g. a slow build), so we never kill a job whose pid is still alive.
import fs from "node:fs";
import { updateJob } from "./state.mjs";

const RUNNING_STATES = new Set(["queued", "running"]);
const DEFAULT_STALE_MS = 2 * 60 * 1000;

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else.
    return err.code === "EPERM";
  }
}

/** Worker-side: record liveness on a job. */
export function touchHeartbeat(cwd, jobId) {
  return updateJob(cwd, jobId, { heartbeatAt: new Date().toISOString() });
}

export function isStalled(job, opts = {}) {
  if (!job || !RUNNING_STATES.has(job.status)) return false;
  if (isPidAlive(job.pid)) return false;

  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const now = opts.now ?? Date.now();
  const stamp = job.heartbeatAt ?? job.updatedAt ?? job.createdAt;
  if (!stamp) return true; // running, no pid, no timestamps -> dead
  return now - Date.parse(stamp) > staleMs;
}

function parsedTime(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function readProgress(progressFile) {
  if (!progressFile) return null;
  try {
    const progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    return parsedTime(progress?.at) == null ? null : progress;
  } catch {
    return null;
  }
}

function secondsRemaining(startMs, budgetMs, now) {
  if (startMs == null || !(Number(budgetMs) > 0)) return null;
  return Math.max(0, Math.ceil((startMs + Number(budgetMs) - now) / 1000));
}

/**
 * Read-only liveness projection for status/result/cancel decisions. Unlike
 * refreshJobStatus, this never writes the job record or reaps a process. It reads
 * the idle-guard's live progress marker so a quiet outer CLI still reports the
 * worker's actual activity.
 */
export function projectJobHealth(job, opts = {}) {
  if (!job) return null;
  const now = opts.now ?? Date.now();
  const active = RUNNING_STATES.has(job.status);
  const progress = readProgress(job.progressFile ?? job.logs?.progress);
  const recordedProgressAt = job.lastProgressAt ?? job.heartbeatAt ?? job.startedAt ?? job.createdAt;
  const recordedProgressMs = parsedTime(recordedProgressAt);
  const fileProgressMs = parsedTime(progress?.at);
  const useFileProgress = fileProgressMs != null && (recordedProgressMs == null || fileProgressMs > recordedProgressMs);
  const lastProgressAt = useFileProgress ? progress.at : recordedProgressAt ?? null;
  const lastProgressKind = useFileProgress ? progress.kind ?? "activity" : job.lastProgressKind ?? null;
  const lastProgressMs = parsedTime(lastProgressAt);
  const startedAt = job.startedAt ?? job.createdAt ?? job.heartbeatAt;
  const startedMs = parsedTime(startedAt);
  const live = active && Boolean(job.pid) && isPidAlive(job.pid);
  const idleMs = Number(job.idleMs) || 0;
  const hardMs = Number(job.timeoutMs) || 0;
  const withinIdleBudget = !active || idleMs <= 0 || lastProgressMs == null || now - lastProgressMs <= idleMs;
  const withinHardBudget = !active || hardMs <= 0 || startedMs == null || now - startedMs <= hardMs;
  const stalled = job.status === "running" && !live;
  const healthy = active && (job.status === "queued" || live) && withinIdleBudget && withinHardBudget;
  let state = "terminal";
  if (job.status === "queued") state = withinHardBudget ? "queued" : "hard-timeout-exceeded";
  else if (job.status === "running" && !live) state = "process-exited";
  else if (job.status === "running" && !withinHardBudget) state = "hard-timeout-exceeded";
  else if (job.status === "running" && !withinIdleBudget) state = "idle-timeout-exceeded";
  else if (job.status === "running") state = "running";

  return {
    state,
    live,
    healthy,
    withinIdleBudget,
    withinHardBudget,
    stalled,
    progressObserved: Boolean(progress?.at),
    lastProgressAt,
    lastProgressKind,
    secondsSinceProgress: lastProgressMs == null ? null : Math.max(0, Math.floor((now - lastProgressMs) / 1000)),
    idleSecondsRemaining: secondsRemaining(lastProgressMs, idleMs, now),
    hardSecondsRemaining: secondsRemaining(startedMs, hardMs, now)
  };
}
