import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isolateStateRoot, makeRepo, stubBin } from "./helpers.mjs";
import { run } from "../core/process.mjs";
import {
  registerPeer,
  heartbeatPeer,
  listMachines,
  registerMachine,
  pickMachine,
  sendMessage,
  readInbox,
  isPeerConsent,
  resolvePeersDir,
  MACHINE_AVAILABLE_TTL_MS
} from "../core/peers.mjs";
import { assignTask, waitForReply } from "../core/peer-assign.mjs";
import { listenPeersServer } from "../core/peers-serve.mjs";
import { rememberRemoteInbox, listRemoteInboxes } from "../core/peers.mjs";
import { tryDeliver } from "../core/peer-deliver.mjs";
import {
  buildIdleResume,
  claudeNativeInboxPresent,
  handleAssignedWork
} from "../core/peer-receive.mjs";
import { replyToAssign } from "../core/peer-reply.mjs";
import {
  DEFAULT_HEARTBEAT_MS,
  resolveHeartbeatIntervalMs,
  tickPresence,
  runPresenceLoop
} from "../core/peer-presence.mjs";
import { parseAssignOutcome, finalizeAssignOutcome } from "../core/peer-outcome.mjs";

const CLI = fileURLToPath(new URL("../scripts/agent-companion.mjs", import.meta.url));
const ASSIGN_SRC = fileURLToPath(new URL("../core/peer-assign.mjs", import.meta.url));
const RECEIVE_SRC = fileURLToPath(new URL("../core/peer-receive.mjs", import.meta.url));
const PRESENCE_SRC = fileURLToPath(new URL("../core/peer-presence.mjs", import.meta.url));
const REPLY_SRC = fileURLToPath(new URL("../core/peer-reply.mjs", import.meta.url));
const DELIVER_SRC = fileURLToPath(new URL("../core/peer-deliver.mjs", import.meta.url));
const OUTCOME_SRC = fileURLToPath(new URL("../core/peer-outcome.mjs", import.meta.url));
const DISPATCH_SRC = fileURLToPath(new URL("../core/dispatch.mjs", import.meta.url));

function cli(args, { cwd, env } = {}) {
  return run(process.execPath, [CLI, ...args], { cwd: cwd ?? makeRepo(), env: { ...process.env, ...env } });
}

function agePeer(name, msAgo) {
  const file = path.join(resolvePeersDir(), "registry.json");
  const reg = JSON.parse(fs.readFileSync(file, "utf8"));
  const iso = new Date(Date.now() - msAgo).toISOString();
  if (reg.peers[name]) reg.peers[name].lastSeenAt = iso;
  const computer = reg.peers[name]?.computer;
  if (computer && reg.machines?.[computer]) reg.machines[computer].lastSeenAt = iso;
  fs.writeFileSync(file, JSON.stringify(reg, null, 2));
}

function cursorFlags(joined) {
  return /--mode(?:\s+|=)ask/.test(joined) || /(?:^|\s)--trust(?:\s|$)/.test(joined) || /--workspace/.test(joined);
}

test("assign, receive, presence, outcome, and reply stay off the job-plane dispatcher", () => {
  for (const src of [ASSIGN_SRC, RECEIVE_SRC, PRESENCE_SRC, REPLY_SRC, DELIVER_SRC, OUTCOME_SRC]) {
    const text = fs.readFileSync(src, "utf8");
    assert.doesNotMatch(text, /dispatch\.mjs/);
    assert.doesNotMatch(text, /runWorkerSync|launchBackground|decideRoute/);
  }
  const dispatch = fs.readFileSync(DISPATCH_SRC, "utf8");
  assert.doesNotMatch(dispatch, /peer-assign|peer-receive|peer-presence|peer-reply|handleAssignedWork/);
});

test("parseAssignOutcome binds id and rejects PEER_ACK-only stdout", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(parseAssignOutcome(`PEER_ACK ${id}\n`, id), null);
  assert.equal(parseAssignOutcome("ok\n", id), null);
  const p = parseAssignOutcome(
    `notes\nassign ${id} rerouted\nharness: cursor\nused cursor; grok down\n`,
    id
  );
  assert.equal(p.status, "rerouted");
  assert.equal(p.harness, "cursor");
  const done = parseAssignOutcome(
    `assign ${id} done\nharness: grok\njob: 11111111-2222-3333-4444-555555555555\nlooked at the test\n`,
    id
  );
  assert.equal(done.status, "done");
  assert.equal(done.jobId, "11111111-2222-3333-4444-555555555555");
  assert.equal(parseAssignOutcome(`assign other-id done\n`, id), null);
});

test("finalizeAssignOutcome refuses done when implement job is not terminal", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const parsed = parseAssignOutcome(
    `assign ${id} done\njob: 11111111-2222-3333-4444-555555555555\n`,
    id
  );
  const refused = finalizeAssignOutcome(parsed, { job: { id: parsed.jobId, status: "running" } });
  assert.equal(refused.status, "refuse");
  assert.match(refused.reason, /job-not-terminal|unparsed/);
  const ping = finalizeAssignOutcome(
    parseAssignOutcome(`assign ${id} done\nkind: ping\nharness: grok\nok\n`, id),
    { job: null }
  );
  assert.equal(ping.status, "done");
  const forged = finalizeAssignOutcome(
    parseAssignOutcome(`assign ${id} done\nharness: grok\nimplemented it\n`, id),
    { job: null }
  );
  assert.equal(forged.status, "refuse");
  const cancelled = finalizeAssignOutcome(
    parseAssignOutcome(`assign ${id} done\njob: 11111111-2222-3333-4444-555555555555\n`, id),
    { job: { id: "11111111-2222-3333-4444-555555555555", status: "cancelled" } }
  );
  assert.equal(cancelled.status, "done");
});

test("assignTask skip-busy: a busy machine is not picked when another is idle", async () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4" });
  registerPeer({ name: "busy-orch", harness: "cursor", computer: "Mac Mini M4", sessionId: "s-busy" });
  registerPeer({ name: "idle-orch", harness: "grok", computer: "MacBook Pro M4 Max", sessionId: "s-idle" });
  heartbeatPeer({ name: "busy-orch", turnState: "busy" });
  heartbeatPeer({ name: "idle-orch", turnState: "idle" });
  const result = await assignTask({
    from: "main",
    text: "skip-busy-task",
    machines: listMachines(),
    probes: {}
  });
  assert.equal(result.to, "idle-orch");
  assert.equal(result.machine.computer, "MacBook Pro M4 Max");
  assert.equal(readInbox({ name: "busy-orch" }).length, 0);
  assert.equal(readInbox({ name: "idle-orch" })[0].text, "skip-busy-task");
});

test("assignTask skip-asleep: a stale machine is not picked", async () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4" });
  registerPeer({ name: "asleep-orch", harness: "cursor", computer: "2017 MacBook Pro", sessionId: "s-asleep" });
  registerPeer({ name: "awake-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "s-awake" });
  heartbeatPeer({ name: "asleep-orch", turnState: "idle" });
  heartbeatPeer({ name: "awake-orch", turnState: "idle" });
  agePeer("asleep-orch", MACHINE_AVAILABLE_TTL_MS + 5_000);
  const result = await assignTask({
    from: "main",
    text: "skip-asleep-task",
    machines: listMachines({ nowMs: Date.now() }),
    probes: {}
  });
  assert.equal(result.to, "awake-orch");
  assert.equal(result.machine.computer, "Mac Mini M4");
  assert.equal(readInbox({ name: "asleep-orch" }).length, 0);
  assert.equal(readInbox({ name: "awake-orch" })[0].text, "skip-asleep-task");
});

test("assignTask prefer-idle: idle beats an available unknown session", async () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4" });
  registerPeer({ name: "unknown-orch", harness: "cursor", computer: "Mac Mini M4", sessionId: "s-unk" });
  registerPeer({ name: "idle-orch", harness: "grok", computer: "MacBook Pro M4 Max", sessionId: "s-idle" });
  heartbeatPeer({ name: "idle-orch", turnState: "idle" });
  const result = await assignTask({
    from: "main",
    text: "prefer-idle-task",
    machines: listMachines(),
    probes: {}
  });
  assert.equal(result.to, "idle-orch");
  assert.equal(pickMachine(listMachines()).session.name, "idle-orch");
});

test("pickMachine --to-computer only hits that machine", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4" });
  registerPeer({ name: "mini-orch", harness: "cursor", computer: "Mac Mini M4", sessionId: "s-mini" });
  registerPeer({ name: "old-orch", harness: "cursor", computer: "2017 MacBook Pro", sessionId: "s-old" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const rows = listMachines();
  assert.equal(pickMachine(rows, { computer: "2017 MacBook Pro" }).session.name, "old-orch");
  assert.equal(pickMachine(rows, { computer: "Mac Mini M4" }).session.name, "mini-orch");
});

test("sendMessage round-trips hintHarness", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok" });
  const sent = sendMessage({ to: "old-orch", from: "main", text: "look at CI", hintHarness: "grok" });
  assert.equal(sent.hintHarness, "grok");
  assert.equal(readInbox({ name: "old-orch" })[0].hintHarness, "grok");
});

test("pickMachine skips session main even when main is the primary heartbeat", () => {
  isolateStateRoot();
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "orch" });
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4", sessionId: "main" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  heartbeatPeer({ name: "main", turnState: "idle" });
  const picked = pickMachine(listMachines(), { from: "main", computer: "Mac Mini M4" });
  assert.equal(picked.session.name, "mini-orch");
});

test("pickMachine --to main is explicit override", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4", sessionId: "main" });
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "orch" });
  heartbeatPeer({ name: "main", turnState: "idle" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  assert.equal(pickMachine(listMachines(), { to: "main" }).session.name, "main");
});

test("pickMachine skips session main even when from is omitted", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4", sessionId: "main" });
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "orch" });
  heartbeatPeer({ name: "main", turnState: "idle" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  assert.equal(pickMachine(listMachines()).session.name, "mini-orch");
});

test("rememberRemoteInbox stores credentials used by waitForReply", async () => {
  isolateStateRoot();
  registerPeer({ name: "old-orch", harness: "cursor", computer: "2017 MacBook Pro", sessionId: "s" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const { server, url } = await listenPeersServer({ pair: "pair-secret" });
  try {
    const { peersHttp } = await import("../core/peers-serve.mjs");
    const sender = await peersHttp(url, {
      method: "POST",
      path: "/peers/register",
      token: "pair-secret",
      body: { name: "main", harness: "grok", sessionId: "main" }
    });
    assert.equal(sender.name, "main");
    rememberRemoteInbox({ name: sender.name, url, token: sender.token });
    assert.equal(listRemoteInboxes("main")[0].url, url);
    sendMessage({
      to: "main",
      from: "old-orch",
      text: "assign aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee done\nkind: ping",
      allowCrossMachine: true
    });
    const reply = await waitForReply({
      name: "main",
      url,
      token: sender.token,
      from: "old-orch",
      assignId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      timeoutMs: 2000,
      pollMs: 200
    });
    assert.equal(reply.from, "old-orch");
    assert.match(reply.text, /^assign aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee done/);
    assert.match(reply.text, /kind: ping/);
    assert.equal(reply.isConsent, false);
  } finally {
    server.close();
  }
});

test("waitForReply ignores text that is not assign <id> done|refuse|rerouted", async () => {
  isolateStateRoot();
  registerPeer({ name: "old-orch", harness: "cursor", computer: "2017 MacBook Pro", sessionId: "s" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const { server, url } = await listenPeersServer({ pair: "pair-secret" });
  try {
    const { peersHttp } = await import("../core/peers-serve.mjs");
    const sender = await peersHttp(url, {
      method: "POST",
      path: "/peers/register",
      token: "pair-secret",
      body: { name: "main", harness: "grok", sessionId: "main" }
    });
    sendMessage({ to: "main", from: "old-orch", text: "PEER_ACK nope", allowCrossMachine: true });
    await assert.rejects(
      () =>
        waitForReply({
          name: "main",
          url,
          token: sender.token,
          from: "old-orch",
          assignId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          timeoutMs: 400,
          pollMs: 100
        }),
      (err) => err.code === "PEER_REPLY_TIMEOUT"
    );
    sendMessage({
      to: "main",
      from: "old-orch",
      text: "assign aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee refuse: no-grok\n",
      allowCrossMachine: true
    });
    const reply = await waitForReply({
      name: "main",
      url,
      token: sender.token,
      from: "old-orch",
      assignId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      timeoutMs: 2000,
      pollMs: 100
    });
    assert.match(reply.text, /^assign aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee refuse/);
  } finally {
    server.close();
  }
});

test("replyToAssign enqueues to a cross-machine sender on this mailbox", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", reach: "cross-machine" });
  registerPeer({ name: "old-orch", harness: "cursor" });
  assert.throws(
    () => sendMessage({ to: "main", from: "old-orch", text: "plain-send-must-fail-close" }),
    (err) => err.code === "PEER_CROSS_MACHINE"
  );
  const reply = replyToAssign({ from: "old-orch", to: "main", text: "assign remote-1 done" });
  assert.equal(reply.to, "main");
  assert.equal(reply.from, "old-orch");
  assert.equal(reply.origin, "peer-session");
  assert.equal(reply.isConsent, false);
  assert.equal(readInbox({ name: "main" })[0].text, "assign remote-1 done");
});

test("handleAssignedWork replies to a cross-machine main and stays idle if reply fails", async () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", reach: "cross-machine" });
  registerPeer({
    name: "old-orch",
    harness: "grok",
    computer: "2017 MacBook Pro",
    sessionId: "sess-old"
  });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  sendMessage({
    to: "old-orch",
    from: "main",
    text: "cross-mac-assign",
    allowCrossMachine: true
  });
  const out = handleAssignedWork({
    name: "old-orch",
    runWake: () => ({ status: 0, stdout: "ok" })
  });
  assert.equal(out.consumed, true);
  assert.equal(out.peer.turnState, "idle");
  assert.equal(out.reply.from, "old-orch");
  assert.equal(out.reply.to, "main");
  assert.equal(out.reply.isConsent, false);
  assert.match(out.reply.text, /refuse: unparsed-outcome/);
  assert.equal(readInbox({ name: "main" })[0].from, "old-orch");
  assert.equal(readInbox({ name: "old-orch" }).length, 0);
});

test("replyToAssign writes the same peer-session shape to main, not consent", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "mini-orch", harness: "cursor" });
  const reply = replyToAssign({ from: "mini-orch", to: "main", text: "assign m1 done" });
  assert.equal(reply.from, "mini-orch");
  assert.equal(reply.to, "main");
  assert.equal(reply.text, "assign m1 done");
  assert.equal(reply.origin, "peer-session");
  assert.equal(reply.isConsent, false);
  assert.equal(isPeerConsent(reply), false);
  const inbox = readInbox({ name: "main" });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, "mini-orch");
  assert.equal(inbox[0].text, "assign m1 done");
  assert.equal(inbox[0].origin, "peer-session");
  assert.equal(inbox[0].isConsent, false);
});

test("codex/grok/opencode idle resume argv is not Cursor argv", () => {
  const peersDir = "/var/peers-mailbox";
  for (const harness of ["codex", "grok", "opencode"]) {
    const spec = buildIdleResume({
      harness,
      sessionId: "sess-1",
      prompt: "PEER_ACK msg-1",
      peersDir
    });
    assert.ok(Array.isArray(spec.args), harness);
    const joined = spec.args.join(" ");
    assert.equal(cursorFlags(joined), false, `${harness} argv leaked Cursor flags: ${joined}`);
    assert.doesNotMatch(joined, /--mode/);
    assert.doesNotMatch(joined, /--trust/);
    assert.doesNotMatch(joined, /--workspace/);
    assert.notEqual(path.basename(spec.bin), "cursor-agent");
    assert.notEqual(path.basename(spec.bin), "agent");
  }
  const cursor = buildIdleResume({ harness: "cursor", sessionId: "sess-1", prompt: "PEER_ACK msg-1" });
  const cursorJoined = cursor.args.join(" ");
  assert.match(cursorJoined, /--mode/);
  assert.match(cursorJoined, /ask/);
  assert.match(cursorJoined, /--trust/);
  assert.doesNotMatch(cursorJoined, /--workspace/);
});

test("codex resume uses exec resume and can add the peers mailbox dir", () => {
  const spec = buildIdleResume({
    harness: "codex",
    sessionId: "sess-codex",
    prompt: "PEER_ACK x",
    peersDir: "/writable/peers"
  });
  const joined = spec.args.join(" ");
  assert.match(joined, /\bexec\b/);
  assert.match(joined, /\bresume\b/);
  assert.match(joined, /sess-codex/);
  assert.equal(spec.env?.AGENT_COLLAB_PEERS_DIR, "/writable/peers");
});

test("grok resume uses --resume/--single, opencode uses --session", () => {
  const grok = buildIdleResume({ harness: "grok", sessionId: "sess-g", prompt: "PEER_ACK x" });
  assert.match(grok.args.join(" "), /--resume/);
  assert.match(grok.args.join(" "), /--single|sess-g/);
  const oc = buildIdleResume({ harness: "opencode", sessionId: "sess-o", prompt: "PEER_ACK x" });
  assert.match(oc.args.join(" "), /--session/);
  assert.match(oc.args.join(" "), /sess-o/);
});

test("claude without a native inbox is native_required and does not spawn", () => {
  isolateStateRoot();
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  assert.equal(claudeNativeInboxPresent({ env: {} }), false);
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "claude", harness: "claude", sessionId: "s-claude" });
  heartbeatPeer({ name: "claude", turnState: "idle" });
  const msg = sendMessage({ to: "claude", from: "main", text: "do not fake inject" });
  let spawns = 0;
  const r = tryDeliver({
    peer: { name: "claude", harness: "claude", sessionId: "s-claude", turnState: "idle" },
    message: msg,
    runWake: () => {
      spawns += 1;
      return { status: 0, stdout: "nope" };
    }
  });
  assert.equal(spawns, 0);
  assert.equal(r.reason, "native_required");
  assert.equal(r.spawned, false);
});

test("unknown harness stays inject-stub and does not spawn", () => {
  isolateStateRoot();
  let spawns = 0;
  const r = tryDeliver({
    peer: { name: "q", harness: "qwen", sessionId: "s", turnState: "idle" },
    message: { id: "1", from: "main", text: "x", replyAddress: "main" },
    runWake: () => {
      spawns += 1;
      return { status: 0, stdout: "" };
    }
  });
  assert.equal(spawns, 0);
  assert.match(r.reason, /inject-stub:qwen/);
});

test("tickPresence publishes computer, harness, and turn-state; machines expose harness", () => {
  isolateStateRoot();
  registerMachine({ computer: "2017 MacBook Pro", url: "http://100.70.172.74:8744" });
  registerMachine({ computer: "MacBook Pro M4 Max", url: "http://100.109.243.67:8744" });
  const peer = tickPresence({
    computer: "Mac Mini M4",
    harness: "cursor",
    turnState: "idle",
    name: "mini-orch",
    sessionId: "s1",
    persistPid: false
  });
  assert.equal(peer.computer, "Mac Mini M4");
  assert.equal(peer.harness, "cursor");
  assert.equal(peer.turnState, "idle");
  const rows = listMachines({
    probes: {
      "2017 MacBook Pro": { ok: false, error: "unreachable" },
      "MacBook Pro M4 Max": { ok: false, error: "unreachable" }
    }
  });
  assert.deepEqual(
    rows.map((r) => r.computer).sort(),
    ["2017 MacBook Pro", "Mac Mini M4", "MacBook Pro M4 Max"]
  );
  for (const row of rows) {
    assert.equal("available" in row, true, row.computer);
    assert.equal("activity" in row, true, row.computer);
    assert.equal("harness" in row, true, row.computer);
  }
  const mini = rows.find((r) => r.computer === "Mac Mini M4");
  assert.equal(mini.available, true);
  assert.equal(mini.activity, "idle");
  assert.equal(mini.harness, "cursor");
});

test("heartbeatPeer --harness updates harness without requiring a new name", () => {
  isolateStateRoot();
  registerPeer({ name: "worker", harness: "cursor" });
  const beat = heartbeatPeer({ name: "worker", turnState: "idle", harness: "grok" });
  assert.equal(beat.name, "worker");
  assert.equal(beat.harness, "grok");
  assert.equal(beat.turnState, "idle");
});

test("presence interval defaults to 30s and is injectable", async () => {
  assert.equal(DEFAULT_HEARTBEAT_MS, 30_000);
  assert.equal(resolveHeartbeatIntervalMs({}), 30_000);
  assert.equal(resolveHeartbeatIntervalMs({ intervalMs: 15 }), 15);
  isolateStateRoot();
  const sleeps = [];
  let ticks = 0;
  await runPresenceLoop({
    computer: "Mac Mini M4",
    harness: "cursor",
    turnState: "idle",
    name: "mini-orch",
    persistPid: false,
    intervalMs: 15,
    consume: false,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    shouldContinue: () => {
      ticks += 1;
      return ticks < 2;
    }
  });
  assert.equal(sleeps[0], 15);
  assert.ok(ticks >= 2);
});

test("handleAssignedWork publishes busy so a second assign skips, then replies and returns idle", async () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4" });
  registerPeer({
    name: "mini-orch",
    harness: "grok",
    computer: "Mac Mini M4",
    sessionId: "sess-work"
  });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  const assigned = await assignTask({
    from: "main",
    text: "plate-handoff",
    machines: listMachines(),
    probes: {}
  });
  assert.equal(assigned.to, "mini-orch");
  assert.equal(readInbox({ name: "mini-orch" }).length, 1);
  let midFlightPick = "unset";
  let sawArgv = "";
  const out = handleAssignedWork({
    name: "mini-orch",
    runWake: ({ args }) => {
      sawArgv = args.join(" ");
      midFlightPick = pickMachine(listMachines());
      return { status: 0, stdout: "ok" };
    }
  });
  assert.equal(out.consumed, true);
  assert.equal(midFlightPick, null);
  assert.equal(cursorFlags(sawArgv), false, sawArgv);
  assert.equal(out.peer.turnState, "idle");
  const inbox = readInbox({ name: "main" });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, "mini-orch");
  assert.equal(inbox[0].origin, "peer-session");
  assert.equal(inbox[0].isConsent, false);
  assert.match(inbox[0].text, /refuse: unparsed-outcome/);
  assert.equal(readInbox({ name: "mini-orch" }).length, 0);
});

test("handleAssignedWork refuse still replies with the same shape and returns idle", async () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4" });
  registerPeer({ name: "mini-orch", harness: "cursor", computer: "Mac Mini M4", sessionId: "s" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  await assignTask({
    from: "main",
    text: "nope",
    machines: listMachines(),
    probes: {}
  });
  const out = handleAssignedWork({ name: "mini-orch", refuse: "operator-refused" });
  assert.equal(out.consumed, true);
  assert.equal(out.peer.turnState, "idle");
  const inbox = readInbox({ name: "main" });
  assert.equal(inbox[0].from, "mini-orch");
  assert.match(inbox[0].text, /refuse/);
  assert.equal(inbox[0].isConsent, false);
});

test("orchestrator consume prompt is not PEER_ACK-only and includes assign body", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok", computer: "2017 MacBook Pro", sessionId: "sess-g" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const msg = sendMessage({
    to: "old-orch",
    from: "main",
    text: "look at the red test",
    hintHarness: "grok"
  });
  let prompt = "";
  const out = handleAssignedWork({
    name: "old-orch",
    runWake: ({ args }) => {
      prompt = args.join("\n");
      return { status: 0, stdout: `assign ${msg.id} done\nkind: ping\nharness: grok\nlooked\n` };
    }
  });
  assert.match(prompt, /look at the red test/);
  assert.match(prompt, /implement|ping/i);
  assert.doesNotMatch(prompt, /^PEER_ACK /m);
  assert.match(out.reply.text, new RegExp(`^assign ${msg.id} done`, "m"));
});

test("implement done requires terminal job via handleAssignedWork cwd", async () => {
  isolateStateRoot();
  const repo = makeRepo();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok", sessionId: "s", computer: "2017 MacBook Pro" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const msg = sendMessage({ to: "old-orch", from: "main", text: "implement the fix" });
  const { appendJob } = await import("../core/state.mjs");
  const job = appendJob(repo, { id: "11111111-2222-3333-4444-555555555555", status: "completed" });
  const out = handleAssignedWork({
    name: "old-orch",
    cwd: repo,
    runWake: () => ({
      status: 0,
      stdout: `assign ${msg.id} done\nkind: implement\njob: ${job.id}\nharness: grok\nfixed\n`
    })
  });
  assert.match(out.reply.text, new RegExp(`^assign ${msg.id} done`));
  assert.match(out.reply.text, /job: 11111111-2222-3333-4444-555555555555/);
});

test("PEER_ACK-only cursor consume does not enqueue assign done", async () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "cursor", computer: "2017 MacBook Pro", sessionId: "sess-c" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const msg = sendMessage({ to: "old-orch", from: "main", text: "run the plate" });
  const out = handleAssignedWork({
    name: "old-orch",
    resumeProbe: () => false,
    runWake: () => ({ status: 0, stdout: `PEER_ACK ${msg.id}\n` })
  });
  assert.equal(out.consumed, true);
  assert.match(out.reply.text, /^assign \S+ refuse: wake-only/m);
  assert.doesNotMatch(out.reply.text, /^assign \S+ done/m);
});

test("hint ignored replies rerouted with harness used", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok", sessionId: "s", computer: "2017 MacBook Pro" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const msg = sendMessage({
    to: "old-orch",
    from: "main",
    text: "look at CI",
    hintHarness: "grok"
  });
  const out = handleAssignedWork({
    name: "old-orch",
    runWake: () => ({
      status: 0,
      stdout: `assign ${msg.id} rerouted\nharness: cursor\nused cursor; grok down\n`
    })
  });
  assert.match(out.reply.text, new RegExp(`^assign ${msg.id} rerouted`));
  assert.match(out.reply.text, /harness: cursor/);
});

test("exit 0 without outcome is refuse unparsed-outcome", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok", sessionId: "s", computer: "2017 MacBook Pro" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  sendMessage({ to: "old-orch", from: "main", text: "hi" });
  const out = handleAssignedWork({
    name: "old-orch",
    runWake: () => ({ status: 0, stdout: "ok\n" })
  });
  assert.match(out.reply.text, /refuse: unparsed-outcome/);
});

test("dead presence pid makes the computer unavailable without a manual heartbeat", () => {
  isolateStateRoot();
  tickPresence({
    computer: "Mac Mini M4",
    harness: "cursor",
    turnState: "idle",
    name: "mini-orch",
    pid: 999999999,
    persistPid: true
  });
  const row = listMachines().find((m) => m.computer === "Mac Mini M4");
  assert.equal(row.available, false);
  assert.equal(pickMachine(listMachines()), null);
});

test("companion peers presence --once and consume drive the shipped CLI", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const env = { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_GROK_BIN: stubBin("process.exit(0);\n") };
  const self = cli(
    [
      "peers",
      "presence",
      "--computer",
      "Mac Mini M4",
      "--harness",
      "grok",
      "--turn-state",
      "idle",
      "--name",
      "mini-orch",
      "--session-id",
      "sess-cli",
      "--once",
      "--json"
    ],
    { cwd: repo, env }
  );
  assert.equal(self.status, 0, self.stderr);
  const beat = JSON.parse(self.stdout);
  assert.equal(beat.computer, "Mac Mini M4");
  assert.equal(beat.harness, "grok");
  assert.equal(beat.turnState, "idle");
  const main = cli(["peers", "register", "--name", "main", "--harness", "grok", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(main.status, 0, main.stderr);
  const assigned = cli(["peers", "assign", "--from", "main", "cli-handoff", "--json"], { cwd: repo, env });
  assert.equal(assigned.status, 0, assigned.stderr);
  const consume = cli(["peers", "consume", "--name", "mini-orch", "--json"], { cwd: repo, env });
  assert.equal(consume.status, 0, consume.stderr);
  const body = JSON.parse(consume.stdout);
  assert.equal(body.consumed, true);
  const inbox = cli(["peers", "inbox", "--name", "main", "--json"], { cwd: repo, env });
  assert.equal(inbox.status, 0, inbox.stderr);
  const box = JSON.parse(inbox.stdout);
  assert.equal(box.messages[0].from, "mini-orch");
  assert.equal(box.messages[0].isConsent, false);
  assert.match(box.messages[0].text, /refuse: unparsed-outcome/);
});
