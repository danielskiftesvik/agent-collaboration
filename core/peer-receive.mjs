// Per-harness assign consume. Not the job plane. Cursor stays in peer-inject-cursor.
import fs from "node:fs";

import { resolveCursorBin } from "../adapters/cursor.mjs";
import { ackInbox, getPeer, heartbeatPeer, readInbox, resolvePeersDir } from "./peers.mjs";
import { tryDeliver as cursorTryDeliver, buildWakePrompt } from "./peer-inject-cursor.mjs";
import { replyToAssign } from "./peer-reply.mjs";
import { run } from "./process.mjs";

function queued(reason, extra = {}) {
  return {
    delivered: false,
    queued: true,
    reason,
    asOfMs: Date.now(),
    ...extra
  };
}

export function normalizeHarness(harness) {
  return String(harness || "").toLowerCase();
}

export function claudeNativeInboxPresent({ env = process.env, exists = fs.existsSync } = {}) {
  const sock = env.CLAUDE_CODE_MESSAGING_SOCKET;
  return Boolean(sock && exists(sock));
}

function resolveBin(envName, fallback) {
  return process.env[envName] || fallback;
}

/**
 * Real idle-resume argv for a new turn. Cursor keeps --mode ask --trust.
 * Codex/Grok/OpenCode use that harness's own resume flags — never Cursor's.
 */
export function buildIdleResume({ harness, sessionId, prompt, peersDir } = {}) {
  const h = normalizeHarness(harness);
  const body = prompt == null ? "" : String(prompt);
  if (h === "cursor") {
    if (!sessionId) return { harness: h, bin: resolveCursorBin(), args: null, reason: "no-session-id" };
    return {
      harness: h,
      bin: resolveCursorBin(),
      args: ["-p", body, "--resume", String(sessionId), "--mode", "ask", "--trust", "--output-format", "text"]
    };
  }
  if (h === "codex") {
    const args = ["exec"];
    if (peersDir) args.push("--add-dir", String(peersDir));
    args.push("resume");
    if (sessionId) args.push(String(sessionId));
    else args.push("--last");
    args.push(body);
    return {
      harness: h,
      bin: resolveBin("AGENT_COLLAB_CODEX_BIN", "codex"),
      args,
      env: peersDir ? { AGENT_COLLAB_PEERS_DIR: String(peersDir) } : undefined
    };
  }
  if (h === "grok") {
    const args = [];
    if (sessionId) args.push("--resume", String(sessionId));
    else args.push("--continue");
    args.push("--single", body);
    return {
      harness: h,
      bin: resolveBin("AGENT_COLLAB_GROK_BIN", "grok"),
      args
    };
  }
  if (h === "opencode") {
    const args = ["run", "--auto"];
    if (sessionId) args.push("--session", String(sessionId));
    else args.push("--continue");
    args.push(body);
    return {
      harness: h,
      bin: resolveBin("AGENT_COLLAB_OPENCODE_BIN", "opencode"),
      args
    };
  }
  if (h === "claude") {
    return { harness: h, bin: null, args: null, native: true };
  }
  return { harness: h || "unknown", bin: null, args: null, stub: true };
}

function defaultRunWake({ bin, args, env, timeoutMs }) {
  return run(bin, args, {
    env,
    idleMs: timeoutMs,
    timeout: timeoutMs
  });
}

export function tryReceive({
  peer,
  message,
  runWake = defaultRunWake,
  resumeProbe,
  claimed = false
} = {}) {
  if (!peer || !message) return queued("missing-peer-or-message");
  const harness = normalizeHarness(peer.harness);

  if (harness === "cursor") {
    return cursorTryDeliver({ peer, message, runWake, resumeProbe, claimed });
  }

  if (harness === "claude") {
    const native = claudeNativeInboxPresent();
    try {
      if (peer.name && message.id) ackInbox({ name: peer.name, ids: [String(message.id)] });
    } catch {
      /* mailbox consume is best-effort when tests pass a bare peer */
    }
    return {
      delivered: false,
      queued: false,
      consumed: true,
      spawned: false,
      reason: native ? "native" : "native_required",
      status: native ? "native" : "native_required",
      deliveryMode: "native",
      asOfMs: Date.now()
    };
  }

  if (harness !== "codex" && harness !== "grok" && harness !== "opencode") {
    return queued(`inject-stub:${harness || "unknown"}`, { spawned: false });
  }

  if ((peer.reach ?? "local") === "cross-machine") {
    return queued("cross-machine");
  }

  if (!claimed) {
    const turn = peer.turnState == null || peer.turnState === "" ? null : String(peer.turnState).toLowerCase();
    if (!turn) return queued("no-turn-state");
    if (turn !== "idle") return queued("busy:turn-state");
  }

  const spec = buildIdleResume({
    harness,
    sessionId: peer.sessionId,
    prompt: buildWakePrompt(message.id),
    peersDir: resolvePeersDir()
  });
  if (!spec.args) return queued(spec.reason || "no-idle-resume");

  const timeoutMs = Number(process.env.AGENT_COLLAB_PEER_INJECT_TIMEOUT_MS) || 180_000;
  const result = runWake({
    bin: spec.bin,
    args: spec.args,
    env: { ...process.env, ...spec.env },
    timeoutMs,
    peer,
    message
  });
  const exitOk = !result?.error && result?.status === 0;
  try {
    if (peer.name && message.id) ackInbox({ name: peer.name, ids: [String(message.id)] });
  } catch {
    /* see above */
  }
  if (!exitOk) {
    return queued(
      `wake-failed:${result?.error?.message || result?.stderr || `exit ${result?.status}`}`,
      { exitCode: result?.status ?? null, consumed: true, spawned: true }
    );
  }
  return {
    delivered: true,
    queued: false,
    consumed: true,
    spawned: true,
    reason: "acked-after-resume",
    status: "injected",
    deliveryMode: "idle-resume",
    messageId: String(message.id),
    asOfMs: Date.now()
  };
}

function leftoverAck(name, messageId) {
  const still = readInbox({ name }).some((m) => String(m.id) === String(messageId));
  if (still) ackInbox({ name, ids: [String(messageId)] });
}

/**
 * Accept one assigned inbox message: publish busy, consume per harness, reply, idle.
 */
export function handleAssignedWork({ name, runWake, resumeProbe, refuse } = {}) {
  if (!name) throw new Error("consume: name is required");
  const peer = getPeer(name);
  if (!peer) throw new Error(`unknown peer: ${name}`);
  const messages = readInbox({ name });
  if (!messages.length) return { consumed: false, name, peer };

  const message = messages[0];
  heartbeatPeer({
    name,
    turnState: "busy",
    harness: peer.harness,
    computer: peer.computer
  });

  let result;
  if (refuse) {
    result = { delivered: false, refused: true, queued: false, reason: String(refuse) };
  } else {
    try {
      const live = getPeer(name) || peer;
      result = tryReceive({
        peer: live,
        message,
        runWake,
        claimed: true
      });
    } catch (e) {
      result = { delivered: false, refused: true, queued: false, reason: e?.message || String(e) };
    }
  }

  const finished = result.delivered === true;
  const replyText = finished
    ? `assign ${message.id} done`
    : `assign ${message.id} refuse: ${result.reason || "undelivered"}`;
  leftoverAck(name, message.id);
  let reply = null;
  let replyError = null;
  try {
    reply = replyToAssign({ from: name, to: message.from, text: replyText });
  } catch (e) {
    replyError = e?.message || String(e);
  }
  const idle = heartbeatPeer({
    name,
    turnState: "idle",
    harness: peer.harness,
    computer: peer.computer
  });
  return {
    consumed: true,
    name,
    message,
    result,
    reply,
    replyError,
    peer: idle,
    turnState: idle.turnState
  };
}
