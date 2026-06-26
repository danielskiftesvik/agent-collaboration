// Stall detection: a worker is only "stalled" when its heartbeat is stale AND
// its process is gone. A stale heartbeat alone can just mean a long, legitimate
// step (e.g. a slow build), so we never kill a job whose pid is still alive.
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
