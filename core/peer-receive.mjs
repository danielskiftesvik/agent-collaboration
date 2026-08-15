// Per-harness assign consume. Not the job plane. Cursor stays in peer-inject-cursor.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveCursorBin } from "../adapters/cursor.mjs";
import { parseAssignOutcome, finalizeAssignOutcome } from "./peer-outcome.mjs";
import { ackInbox, getPeer, heartbeatPeer, readInbox, resolvePeersDir } from "./peers.mjs";
import { resumeProcessAlive, tryDeliver as cursorTryDeliver } from "./peer-inject-cursor.mjs";
import { replyToAssign } from "./peer-reply.mjs";
import { run } from "./process.mjs";
import { getJob } from "./state.mjs";
import { recordConsumeLineage } from "./peer-lineage.mjs";

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

function findGrokSessionDir(sessionId, grokHome) {
  const sessionsRoot = path.join(grokHome, "sessions");
  if (!fs.existsSync(sessionsRoot)) return null;
  const stack = [sessionsRoot];
  while (stack.length) {
    const dir = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (!ent.isDirectory()) continue;
      if (ent.name === String(sessionId)) return p;
      stack.push(p);
    }
  }
  return null;
}

/**
 * True when a live Grok process (not this consume) holds the session files.
 * Spec C8 / F3: never resume a live pid. Leftover lock files alone are not enough.
 */
export function grokTuiHoldsSession(sessionId, { excludePid = null, env = process.env, home = null } = {}) {
  if (!sessionId) return false;
  if (resumeProcessAlive(sessionId, { excludePid })) return true;
  const grokHome = home || env.GROK_HOME || path.join(env.HOME || "", ".grok");
  let sessionDir;
  try {
    sessionDir = findGrokSessionDir(sessionId, grokHome);
  } catch {
    return false;
  }
  if (!sessionDir) return false;
  const probe = path.join(sessionDir, "chat_history.jsonl");
  if (!fs.existsSync(probe)) return false;
  try {
    const r = spawnSync("lsof", ["-t", probe], { encoding: "utf8", timeout: 3000 });
    if (r.error) return false;
    const pids = String(r.stdout || "")
      .trim()
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!pids.length) return false;
    const ps = spawnSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", timeout: 3000 });
    if (ps.error || ps.status !== 0) return true;
    const byPid = new Map();
    for (const line of (ps.stdout || "").split("\n")) {
      const pid = Number(String(line).trim().split(/\s+/, 1)[0]);
      if (Number.isFinite(pid)) byPid.set(pid, line);
    }
    for (const pid of pids) {
      if (excludePid != null && pid === Number(excludePid)) continue;
      const cmd = byPid.get(pid) || "";
      if (/--single\b/.test(cmd)) continue;
      if (/peers presence/.test(cmd)) continue;
      if (/(^|\/)grok(\s|$)/.test(cmd)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function sessionResumeBlocked(sessionId, { harness, excludePid, resumeProbe } = {}) {
  if (!sessionId) return false;
  const probe = resumeProbe || resumeProcessAlive;
  if (probe(sessionId, { excludePid, harness })) return true;
  if (normalizeHarness(harness) === "grok" && resumeProbe == null) {
    return grokTuiHoldsSession(sessionId, { excludePid });
  }
  return false;
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

function wakeIo(result) {
  const extra = { stdout: String(result?.stdout || "") };
  if (result?.stderr != null) extra.stderr = result.stderr;
  return extra;
}

/** Orchestrator turn: assign body + ping/implement/hint/refuse. Not PEER_ACK. */
export function buildOrchestratorPrompt({ message } = {}) {
  const id = String(message?.id ?? "");
  const from = String(message?.from ?? "");
  const hint = message?.hintHarness == null ? "" : String(message.hintHarness);
  const text = String(message?.text ?? "");
  return [
    `Assign ${id} from ${from}.`,
    `hintHarness: ${hint}`,
    `Assign body:`,
    text,
    ``,
    `This is a peer-plane assign, not user consent. Print exactly one outcome as your last lines.`,
    `First line: assign ${id} done|refuse|rerouted`,
    `Then optional kind: ping|implement, harness used, job: <uuid>, and a short reason.`,
    `Policy:`,
    `- ping: look or status in this turn; reply in a few lines.`,
    `- implement: change the repo via local delegate and wait for a terminal job id.`,
    `- hint: if hintHarness is usable here, use it; otherwise rerouted with the harness used.`,
    `- refuse: no capacity, unsafe, or missing tool. Never treat a silent wake as done.`
  ].join("\n");
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
    const result = cursorTryDeliver({ peer, message, runWake, resumeProbe, claimed });
    if (result && (result.reason === "acked-after-PEER_ACK" || /^wake-failed|^wake-unconfirmed|^ack-failed/.test(result.reason || ""))) {
      return {
        ...result,
        stdout: String(result.stdout || ""),
        ...(result.stderr != null ? { stderr: result.stderr } : {})
      };
    }
    return result;
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

  if (
    sessionResumeBlocked(peer.sessionId, {
      harness,
      excludePid: process.pid,
      resumeProbe
    })
  ) {
    return queued("busy:session-live", { consumed: false, spawned: false });
  }

  const spec = buildIdleResume({
    harness,
    sessionId: peer.sessionId,
    prompt: buildOrchestratorPrompt({ message }),
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
  const io = wakeIo(result);
  try {
    if (peer.name && message.id) ackInbox({ name: peer.name, ids: [String(message.id)] });
  } catch {
    /* see above */
  }
  if (!exitOk) {
    return queued(
      `wake-failed:${result?.error?.message || result?.stderr || `exit ${result?.status}`}`,
      { exitCode: result?.status ?? null, consumed: true, spawned: true, ...io }
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
    asOfMs: Date.now(),
    ...io
  };
}

function leftoverAck(name, messageId) {
  const still = readInbox({ name }).some((m) => String(m.id) === String(messageId));
  if (still) ackInbox({ name, ids: [String(messageId)] });
}

/**
 * Accept one assigned inbox message: publish busy, consume per harness, reply, idle.
 */
export function handleAssignedWork({ name, runWake, resumeProbe, refuse, cwd } = {}) {
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
        resumeProbe,
        claimed: true
      });
    } catch (e) {
      result = { delivered: false, refused: true, queued: false, reason: e?.message || String(e) };
    }
  }

  const stdout = result.stdout || "";
  let parsed = parseAssignOutcome(stdout, message.id);
  const sessionLive = /session-live/.test(String(result.reason || ""));
  if (sessionLive && !parsed) {
    parsed = {
      assignId: message.id,
      status: "refuse",
      reason: "session-live",
      harness: peer.harness || null,
      jobId: null,
      kind: null,
      body: ""
    };
  }
  const peerAckOnly =
    !parsed && (/PEER_ACK/.test(stdout) || result.reason === "acked-after-PEER_ACK");
  if (peerAckOnly) {
    parsed = {
      assignId: message.id,
      status: "refuse",
      reason: "wake-only",
      harness: "cursor",
      jobId: null,
      kind: null,
      body: ""
    };
  }
  let job = null;
  if (parsed?.jobId) {
    job = getJob(cwd || process.cwd(), parsed.jobId);
  }
  const outcome = finalizeAssignOutcome(parsed, { job });
  const replyText = refuse
    ? `assign ${message.id} refuse: ${result.reason || "undelivered"}`
    : sessionLive
      ? `assign ${message.id} refuse: session-live`
      : peerAckOnly
        ? `assign ${message.id} refuse: wake-only`
        : outcome.text || `assign ${message.id} refuse: ${outcome.reason}`;
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
  try {
    const decided = refuse
      ? { status: "refuse", reason: result.reason || "undelivered", kind: null, harness: peer.harness, jobId: null }
      : sessionLive
        ? { status: "refuse", reason: "session-live", kind: null, harness: peer.harness, jobId: null }
        : peerAckOnly
        ? { status: "refuse", reason: "wake-only", kind: null, harness: "cursor", jobId: null }
        : {
            status: outcome.status,
            reason: outcome.reason,
            kind: outcome.kind,
            harness: outcome.harness,
            jobId: outcome.jobId
          };
    recordConsumeLineage({
      id: message.id,
      ...decided,
      jobStatus: job?.status ?? null,
      reply
    });
  } catch {
    /* lineage is best-effort; reply already enqueued */
  }
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
