// Machine-side presence: heartbeat tick + optional consume loop.
// Interval is injectable so tests do not sleep 30s.
import { heartbeatPeer, registerPeer, resolveComputer } from "./peers.mjs";
import { handleAssignedWork } from "./peer-receive.mjs";

export const DEFAULT_HEARTBEAT_MS = 30_000;

export function resolveHeartbeatIntervalMs({ intervalMs, env = process.env } = {}) {
  if (intervalMs != null && intervalMs !== "") {
    const n = Number(intervalMs);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromEnv = Number(env.AGENT_COLLAB_PEERS_HEARTBEAT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_HEARTBEAT_MS;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function tickPresence({
  name,
  harness,
  computer,
  turnState,
  sessionId,
  pid,
  persistPid = true
} = {}) {
  if (!harness || typeof harness !== "string") throw new Error("presence: --harness is required");
  const computerLabel = resolveComputer({ computer });
  if (!computerLabel) throw new Error("presence: --computer is required");
  const turn = turnState == null || turnState === "" ? "idle" : turnState;
  const peerName = name || harness;
  const usePid = persistPid ? (pid ?? process.pid) : pid;
  try {
    return heartbeatPeer({
      name: peerName,
      harness,
      computer: computerLabel,
      turnState: turn,
      pid: usePid
    });
  } catch (e) {
    if (!/unknown peer/.test(String(e.message))) throw e;
    registerPeer({
      name: peerName,
      harness,
      computer: computerLabel,
      sessionId,
      pid: usePid,
      replyAddress: peerName,
      reach: "local"
    });
    return heartbeatPeer({
      name: peerName,
      harness,
      computer: computerLabel,
      turnState: turn,
      pid: usePid
    });
  }
}

export async function runPresenceLoop({
  intervalMs,
  sleep = sleepMs,
  shouldContinue,
  onTick,
  consume = true,
  runWake,
  resumeProbe,
  signal,
  persistPid = true,
  ...presence
} = {}) {
  const ms = resolveHeartbeatIntervalMs({ intervalMs });
  const live = { stop: false };
  const onStop = () => {
    live.stop = true;
  };
  if (signal) {
    signal.addEventListener?.("abort", onStop);
  }
  const keepGoing = () => {
    if (live.stop) return false;
    if (signal?.aborted) return false;
    if (shouldContinue) return shouldContinue();
    return true;
  };

  let last = null;
  do {
    last = tickPresence({ ...presence, persistPid });
    if (onTick) await onTick(last);
    if (consume) {
      handleAssignedWork({ name: last.name, runWake, resumeProbe });
      last = tickPresence({ ...presence, persistPid, turnState: presence.turnState });
    }
    if (!keepGoing()) break;
    await sleep(ms);
  } while (keepGoing());
  return last;
}
