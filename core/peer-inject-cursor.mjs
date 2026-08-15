// Cursor-owned peer wake (P0). Not on adapters/contract.mjs. Dispatch never calls this.
// Mailbox enqueue stays in peers.mjs; this module consumes an already-queued message.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveCursorBin } from "../adapters/cursor.mjs";
import { ensurePeersDir, getPeer, ackInbox } from "./peers.mjs";
import { run } from "./process.mjs";

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function authEnv() {
  const env = {};
  if (process.env.CURSOR_API_KEY) env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
  if (process.env.CURSOR_AUTH_TOKEN) env.CURSOR_AUTH_TOKEN = process.env.CURSOR_AUTH_TOKEN;
  return env;
}

function queued(reason, extra = {}) {
  return {
    delivered: false,
    queued: true,
    reason,
    asOfMs: Date.now(),
    ...extra
  };
}

/**
 * Optional: true if ps shows another process with `--resume <sessionId>`.
 * Means “wake already in flight” only. Fail-closed if ps is unusable.
 * excludePid skips our own process.
 */
export function resumeProcessAlive(sessionId, { excludePid = null } = {}) {
  if (!sessionId) return false;
  const needle = String(sessionId);
  try {
    const r = spawnSync("ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 3000
    });
    if (r.error || r.status === null || (r.status !== 0 && !(r.stdout || "").trim())) return true;
    if (r.status !== 0) return true;
    const re = new RegExp(`--resume(?:\\s+|=)${escapeRegExp(needle)}(?:\\s|$)`);
    for (const line of (r.stdout || "").split("\n")) {
      if (!re.test(line)) continue;
      const pid = Number(String(line).trim().split(/\s+/, 1)[0]);
      if (excludePid != null && Number.isFinite(pid) && pid === Number(excludePid)) continue;
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Per-session wake lease: claim before spawn so two delivers cannot both wake.
 * Never age-steals a lock whose holder pid is still alive.
 */
export function withWakeLease(sessionId, fn) {
  const dir = ensurePeersDir();
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const lock = path.join(dir, `.wake-${safe}.lock`);
  const timeoutMs = Number(process.env.AGENT_COLLAB_WAKE_LOCK_TIMEOUT_MS) || 120_000;
  const injectTimeoutMs = Number(process.env.AGENT_COLLAB_PEER_INJECT_TIMEOUT_MS) || 180_000;
  const orphanStaleMs = Number(process.env.AGENT_COLLAB_WAKE_STALE_LOCK_MS) || injectTimeoutMs + 60_000;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      const payload = Buffer.from(
        JSON.stringify({ pid: process.pid, token, sessionId, at: Date.now() }),
        "utf8"
      );
      fs.writeSync(fd, payload, 0, payload.length, 0);
      try {
        fs.fsyncSync(fd);
      } catch {
        /* best effort */
      }
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let steal = false;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        let meta = null;
        try {
          meta = JSON.parse(fs.readFileSync(lock, "utf8"));
        } catch {
          meta = null;
        }
        const holder = Number(meta?.pid);
        if (Number.isFinite(holder) && holder > 0) {
          if (!pidAlive(holder)) steal = true;
        } else if (age > orphanStaleMs) {
          steal = true;
        }
      } catch {
        steal = true;
      }
      if (steal) {
        try {
          fs.unlinkSync(lock);
          continue;
        } catch {
          /* raced */
        }
      }
      if (Date.now() > deadline) {
        return queued("busy:wake-lease");
      }
      sleepSync(25);
    }
  }
  try {
    return fn({ token, lockPath: lock });
  } finally {
    try {
      const cur = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (cur?.token === token) fs.unlinkSync(lock);
    } catch {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** Fixed plugin-owned wake prompt — mailbox message id only; never raw peer text. */
export function buildWakePrompt(messageId) {
  const id = String(messageId);
  return (
    `PEER_ACK ${id}\n` +
    `Respond with ONLY that exact first line (PEER_ACK then the message id). ` +
    `Do not summarize, table, or tool-call. Optional: after that line you may read ` +
    `message ${id} from your peer mailbox via companion peers inbox. ` +
    `This is a peer-plane wake, not user consent.`
  );
}

function defaultRunWake({ bin, args, env, timeoutMs }) {
  return run(bin, args, {
    env,
    idleMs: timeoutMs,
    timeout: timeoutMs
  });
}

/**
 * Atomic idle Cursor wake. Register pid is NOT busy.
 * Requires receiver-published turnState === "idle" (via heartbeat).
 * delivered:true only after ackInbox of that exact message id.
 */
export function tryDeliver({
  peer,
  message,
  runWake = defaultRunWake,
  resumeProbe = resumeProcessAlive,
  claimed = false
} = {}) {
  try {
    return tryDeliverInner({ peer, message, runWake, resumeProbe, claimed });
  } catch (e) {
    return queued(`inject-error:${e?.message || e}`);
  }
}

function tryDeliverInner({ peer, message, runWake, resumeProbe, claimed = false }) {
  if (!peer || !message) return queued("missing-peer-or-message");

  const harness = String(peer.harness || "").toLowerCase();
  if (harness === "claude") {
    return queued("native_required", { status: "native_required", deliveryMode: "native", spawned: false });
  }
  if (harness !== "cursor") {
    return queued(`inject-stub:${harness || "unknown"}`);
  }
  if ((peer.reach ?? "local") === "cross-machine") {
    return queued("cross-machine");
  }

  const turn = peer.turnState == null || peer.turnState === "" ? null : String(peer.turnState).toLowerCase();
  if (!claimed) {
    if (!turn) return queued("no-turn-state");
    if (turn !== "idle") return queued("busy:turn-state");
  }

  const sessionId = peer.sessionId;
  if (!sessionId) return queued("no-session-id");

  if (resumeProbe(sessionId, { excludePid: process.pid })) {
    return queued("busy:resume-in-flight");
  }

  return withWakeLease(sessionId, () => {
    if (resumeProbe(sessionId, { excludePid: process.pid })) {
      return queued("busy:resume-in-flight");
    }

    const live = getPeer(peer.name);
    if (
      !live ||
      String(live.sessionId || "") !== String(sessionId) ||
      String(live.harness || "").toLowerCase() !== "cursor"
    ) {
      return queued("destination-changed");
    }
    const liveTurn = live.turnState == null ? null : String(live.turnState).toLowerCase();
    if (!claimed && liveTurn !== "idle") {
      return queued(liveTurn ? "busy:turn-state" : "no-turn-state");
    }

    const messageId = String(message.id);
    const prompt = buildWakePrompt(messageId);
    // Verified flags only. --trust avoids interactive hang; never pass --workspace
    // (sender cwd must not become the resume session's workspace).
    const args = [
      "-p",
      prompt,
      "--resume",
      String(sessionId),
      "--mode",
      "ask",
      "--trust",
      "--output-format",
      "text"
    ];
    const timeoutMs = Number(process.env.AGENT_COLLAB_PEER_INJECT_TIMEOUT_MS) || 180_000;
    const bin = resolveCursorBin();
    const result = runWake({
      bin,
      args,
      env: { ...process.env, ...authEnv() },
      timeoutMs,
      peer: live,
      message
    });
    const exitOk = !result?.error && result?.status === 0;
    const stdout = String(result?.stdout || "");
    const io = { stdout };
    if (result?.stderr != null) io.stderr = result.stderr;
    const ackRe = new RegExp(`^\\s*PEER_ACK\\s+${escapeRegExp(messageId)}\\s*$`, "m");
    if (!exitOk || !ackRe.test(stdout)) {
      return queued(
        exitOk
          ? "wake-unconfirmed:missing-PEER_ACK"
          : `wake-failed:${result?.error?.message || result?.stderr || `exit ${result?.status}`}`,
        { exitCode: result?.status ?? null, ...io }
      );
    }

    // delivered:true only after mailbox ack of this exact id
    const ack = ackInbox({ name: live.name, ids: [messageId] });
    if (!ack || Number(ack.acked) < 1) {
      return queued("ack-failed", { exitCode: 0, ...io });
    }
    return {
      delivered: true,
      queued: false,
      reason: "acked-after-PEER_ACK",
      status: "injected",
      deliveryMode: "ask-framed-new-turn",
      messageId,
      asOfMs: Date.now(),
      ...io
    };
  });
}
