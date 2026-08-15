import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { isolateStateRoot } from "./helpers.mjs";
import {
  registerPeer,
  heartbeatPeer,
  sendMessage,
  readInbox,
  resolvePeersDir
} from "../core/peers.mjs";
import { deliverInbox, tryDeliver } from "../core/peer-deliver.mjs";
import {
  buildWakePrompt,
  tryDeliver as cursorTryDeliver,
  withWakeLease
} from "../core/peer-inject-cursor.mjs";

const CONTRACT_SRC = fileURLToPath(new URL("../adapters/contract.mjs", import.meta.url));
const DISPATCH_SRC = fileURLToPath(new URL("../core/dispatch.mjs", import.meta.url));
const PEERS_SRC = fileURLToPath(new URL("../core/peers.mjs", import.meta.url));
const COMPANION_SRC = fileURLToPath(new URL("../scripts/agent-companion.mjs", import.meta.url));
const INJECT_SRC = fileURLToPath(new URL("../core/peer-inject-cursor.mjs", import.meta.url));

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cursorPeer(overrides = {}) {
  return {
    name: "cursor-peer",
    harness: "cursor",
    sessionId: "sess-1",
    turnState: "idle",
    reach: "local",
    pid: process.pid,
    ...overrides
  };
}

test("contract and dispatch stay free of inject members", () => {
  assert.doesNotMatch(fs.readFileSync(CONTRACT_SRC, "utf8"), /isInjectSafe|buildInjectCommand|tryDeliver/);
  assert.doesNotMatch(fs.readFileSync(DISPATCH_SRC, "utf8"), /peer-deliver|peer-inject|tryDeliver/);
  assert.doesNotMatch(fs.readFileSync(PEERS_SRC, "utf8"), /peer-inject|tryDeliver|runWake/);
});

test("send path does not spawn agent (enqueue only)", () => {
  isolateStateRoot();
  registerPeer({ name: "alice", harness: "grok" });
  registerPeer({ name: "bob", harness: "cursor", sessionId: "s1", pid: process.pid });
  heartbeatPeer({ name: "bob", turnState: "idle" });
  let spawns = 0;
  const runWake = () => {
    spawns += 1;
    return { status: 0, stdout: "PEER_ACK x\n" };
  };
  const msg = sendMessage({ to: "bob", from: "alice", text: "raw-peer-body-must-not-wake" });
  assert.ok(msg.id);
  assert.equal(spawns, 0);
  assert.equal(readInbox({ name: "bob" }).length, 1);
  // Companion send wiring must not call deliver/tryDeliver.
  const companion = fs.readFileSync(COMPANION_SRC, "utf8");
  const sendBlock = companion.slice(companion.indexOf('if (verb === "send")'), companion.indexOf('if (verb === "inbox")'));
  assert.doesNotMatch(sendBlock, /deliverInbox|tryDeliver|runWake/);
  void runWake;
});

test("wake prompt is fixed plugin string with message id, not peer raw text", () => {
  const prompt = buildWakePrompt("msg-42");
  assert.match(prompt, /PEER_ACK msg-42/);
  assert.match(prompt, /message id|message msg-42|msg-42/);
  assert.doesNotMatch(prompt, /schema-landed|\/compact|approve this/);
  const inj = fs.readFileSync(INJECT_SRC, "utf8");
  assert.doesNotMatch(inj, /message\.text/);
  // Wake argv builder must not push a workspace flag (comment text alone is fine).
  assert.doesNotMatch(inj, /args\.push\(["']--workspace/);
  assert.match(inj, /"--resume"/);
  assert.match(inj, /"--mode"/);
  assert.match(inj, /"ask"/);
  assert.match(inj, /"--trust"/);
  assert.match(inj, /"--output-format"/);
});

test("no turnState queues; busy turnState queues", () => {
  const msg = { id: "m1", from: "a", text: "x", replyAddress: "a" };
  const resumeProbe = () => false;
  assert.equal(
    cursorTryDeliver({
      peer: cursorPeer({ turnState: null }),
      message: msg,
      resumeProbe,
      runWake: () => ({ status: 0, stdout: "" })
    }).reason,
    "no-turn-state"
  );
  assert.equal(
    cursorTryDeliver({
      peer: cursorPeer({ turnState: "busy" }),
      message: msg,
      resumeProbe,
      runWake: () => ({ status: 0, stdout: "" })
    }).reason,
    "busy:turn-state"
  );
});

test("pid-alive still wakes when turnState is idle", () => {
  isolateStateRoot();
  registerPeer({ name: "alice", harness: "grok" });
  registerPeer({ name: "bob", harness: "cursor", sessionId: "sess-alive", pid: process.pid });
  heartbeatPeer({ name: "bob", pid: process.pid, turnState: "idle" });
  const msg = sendMessage({ to: "bob", from: "alice", text: "secret-body" });
  let spawns = 0;
  let sawRaw = false;
  const r = tryDeliver({
    peer: { ...cursorPeer({ name: "bob", sessionId: "sess-alive", pid: process.pid }), turnState: "idle" },
    message: msg,
    resumeProbe: () => false,
    runWake: ({ args }) => {
      spawns += 1;
      const joined = args.join(" ");
      if (joined.includes("secret-body")) sawRaw = true;
      assert.match(joined, /--resume/);
      assert.match(joined, /-p/);
      assert.match(joined, /--mode/);
      assert.match(joined, /ask/);
      assert.doesNotMatch(joined, /--workspace/);
      return { status: 0, stdout: `PEER_ACK ${msg.id}\n` };
    }
  });
  assert.equal(spawns, 1);
  assert.equal(sawRaw, false);
  assert.equal(r.delivered, true);
  assert.equal(r.queued, false);
  assert.equal(readInbox({ name: "bob" }).length, 0);
});

test("wrong PEER_ACK id stays queued and is not acked", () => {
  isolateStateRoot();
  registerPeer({ name: "alice", harness: "grok" });
  registerPeer({ name: "bob", harness: "cursor", sessionId: "sess-2" });
  heartbeatPeer({ name: "bob", turnState: "idle" });
  const msg = sendMessage({ to: "bob", from: "alice", text: "ping" });
  const r = tryDeliver({
    peer: cursorPeer({ name: "bob", sessionId: "sess-2" }),
    message: msg,
    resumeProbe: () => false,
    runWake: () => ({ status: 0, stdout: "PEER_ACK not-the-right-id\n" })
  });
  assert.equal(r.delivered, false);
  assert.equal(r.queued, true);
  assert.match(r.reason, /wake-unconfirmed/);
  assert.equal(readInbox({ name: "bob" })[0].id, msg.id);
});

test("wake lease excludes double-spawn", () => {
  isolateStateRoot();
  registerPeer({ name: "alice", harness: "grok" });
  registerPeer({ name: "bob", harness: "cursor", sessionId: "sess-lease" });
  heartbeatPeer({ name: "bob", turnState: "idle" });
  const msg = sendMessage({ to: "bob", from: "alice", text: "ping" });
  const prev = process.env.AGENT_COLLAB_WAKE_LOCK_TIMEOUT_MS;
  process.env.AGENT_COLLAB_WAKE_LOCK_TIMEOUT_MS = "80";
  let spawns = 0;
  try {
    const lock = path.join(resolvePeersDir(), ".wake-sess-lease.lock");
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, token: "other", sessionId: "sess-lease", at: Date.now() }),
      { mode: 0o600 }
    );
    const r = cursorTryDeliver({
      peer: cursorPeer({ name: "bob", sessionId: "sess-lease" }),
      message: msg,
      resumeProbe: () => false,
      runWake: () => {
        spawns += 1;
        return { status: 0, stdout: `PEER_ACK ${msg.id}\n` };
      }
    });
    assert.equal(spawns, 0);
    assert.equal(r.delivered, false);
    assert.equal(r.reason, "busy:wake-lease");
    assert.equal(readInbox({ name: "bob" }).length, 1);
  } finally {
    if (prev === undefined) delete process.env.AGENT_COLLAB_WAKE_LOCK_TIMEOUT_MS;
    else process.env.AGENT_COLLAB_WAKE_LOCK_TIMEOUT_MS = prev;
  }
});

test("concurrent lease holder prevents a second wake spawn", async () => {
  isolateStateRoot();
  registerPeer({ name: "alice", harness: "grok" });
  registerPeer({ name: "bob", harness: "cursor", sessionId: "sess-race" });
  heartbeatPeer({ name: "bob", turnState: "idle" });
  const msg = sendMessage({ to: "bob", from: "alice", text: "ping" });
  const peersDir = resolvePeersDir();
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
      import { pathToFileURL } from 'node:url';
      const inj = await import(pathToFileURL(${JSON.stringify(INJECT_SRC)}).href);
      process.env.AGENT_COLLAB_PEERS_DIR = ${JSON.stringify(peersDir)};
      inj.withWakeLease('sess-race', () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        return { held: true };
      });
      `
    ],
    { stdio: "ignore" }
  );
  sleepSync(500);
  const prev = process.env.AGENT_COLLAB_WAKE_LOCK_TIMEOUT_MS;
  process.env.AGENT_COLLAB_WAKE_LOCK_TIMEOUT_MS = "500";
  let spawns = 0;
  try {
    const r = cursorTryDeliver({
      peer: cursorPeer({ name: "bob", sessionId: "sess-race" }),
      message: msg,
      resumeProbe: () => false,
      runWake: () => {
        spawns += 1;
        return { status: 0, stdout: `PEER_ACK ${msg.id}\n` };
      }
    });
    assert.equal(spawns, 0);
    assert.equal(r.reason, "busy:wake-lease");
  } finally {
    if (prev === undefined) delete process.env.AGENT_COLLAB_WAKE_LOCK_TIMEOUT_MS;
    else process.env.AGENT_COLLAB_WAKE_LOCK_TIMEOUT_MS = prev;
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
});

test("claude native_required; other harnesses stub", () => {
  assert.equal(
    tryDeliver({
      peer: { name: "c", harness: "claude", sessionId: "x", turnState: "idle" },
      message: { id: "1", from: "a", text: "t", replyAddress: "a" }
    }).reason,
    "native_required"
  );
  assert.match(
    tryDeliver({
      peer: { name: "x", harness: "codex", sessionId: "x", turnState: "idle" },
      message: { id: "1", from: "a", text: "t", replyAddress: "a" }
    }).reason,
    /inject-stub:codex/
  );
});

test("deliverInbox uses tryDeliver and does not require send to wake", () => {
  isolateStateRoot();
  registerPeer({ name: "alice", harness: "grok" });
  registerPeer({ name: "bob", harness: "cursor", sessionId: "sess-d" });
  heartbeatPeer({ name: "bob", turnState: "idle" });
  const msg = sendMessage({ to: "bob", from: "alice", text: "ping" });
  const out = deliverInbox({
    name: "bob",
    resumeProbe: () => false,
    runWake: () => ({ status: 0, stdout: `PEER_ACK ${msg.id}\n` })
  });
  assert.equal(out.results[0].delivered, true);
  assert.equal(readInbox({ name: "bob" }).length, 0);
});

test("withWakeLease is exported for serialization", () => {
  isolateStateRoot();
  const seen = withWakeLease("sess-export", () => "ok");
  assert.equal(seen, "ok");
});
