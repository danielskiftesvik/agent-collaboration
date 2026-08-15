import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { isolateStateRoot, makeRepo } from "./helpers.mjs";
import { registerPeer, heartbeatPeer, listMachines } from "../core/peers.mjs";
import { assignTask } from "../core/peer-assign.mjs";
import { handleAssignedWork } from "../core/peer-receive.mjs";
import { getLineage } from "../core/peer-lineage.mjs";
import { listenPeersServer, peersHttp } from "../core/peers-serve.mjs";

const VIEW_SRC = fileURLToPath(new URL("../ui/collaboration-view.js", import.meta.url));
const PAGE_SRC = fileURLToPath(new URL("../ui/collaboration.html", import.meta.url));
const PAGE_JS = fileURLToPath(new URL("../ui/collaboration-page.js", import.meta.url));

function loadView() {
  const code = fs.readFileSync(VIEW_SRC, "utf8");
  assert.doesNotMatch(code, /\brequire\s*\(/);
  assert.doesNotMatch(code, /\bmodule\.exports\b/);
  assert.doesNotMatch(code, /\bexport\s+/);
  const window = {};
  const ctx = { window, globalThis: window };
  vm.runInNewContext(code, vm.createContext(ctx));
  assert.ok(ctx.window.PeerCollabView, "classic script must install window.PeerCollabView");
  return ctx.window.PeerCollabView;
}

test("collaboration view scripts are classic (no require/export) and exist", () => {
  assert.equal(fs.existsSync(VIEW_SRC), true);
  assert.equal(fs.existsSync(PAGE_SRC), true);
  assert.equal(fs.existsSync(PAGE_JS), true);
  const html = fs.readFileSync(PAGE_SRC, "utf8");
  assert.match(html, /<script src="collaboration-view\.js">/);
  assert.doesNotMatch(html, /type=["']module["']/);
  loadView();
});

test("lineageToView pending assign from real getLineage", async () => {
  isolateStateRoot();
  const { lineageToView } = loadView();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4" });
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "s" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  const assigned = await assignTask({
    from: "main",
    text: "pending look",
    hintHarness: "grok",
    machines: listMachines(),
    probes: {}
  });
  const view = lineageToView(getLineage(assigned.message.id));
  assert.equal(view.id, assigned.message.id);
  assert.equal(view.from, "main");
  assert.equal(view.to, "mini-orch");
  assert.equal(view.computer, "Mac Mini M4");
  assert.equal(view.text, "pending look");
  assert.equal(view.pending, true);
  assert.equal(view.decisionStatus, "pending");
  assert.doesNotMatch(String(view.decisionStatus), /done/);
});

test("lineageToView PEER_ACK consume is refuse wake-only not done", async () => {
  isolateStateRoot();
  const { lineageToView } = loadView();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({
    name: "old-orch",
    harness: "cursor",
    computer: "2017 MacBook Pro",
    sessionId: "c"
  });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const assigned = await assignTask({
    from: "main",
    text: "run the plate",
    machines: listMachines(),
    probes: {}
  });
  handleAssignedWork({
    name: "old-orch",
    resumeProbe: () => false,
    runWake: () => ({ status: 0, stdout: `PEER_ACK ${assigned.message.id}\n` })
  });
  const view = lineageToView(getLineage(assigned.message.id));
  assert.equal(view.decisionStatus, "refuse");
  assert.match(String(view.decisionReason), /wake-only/);
  assert.notEqual(view.decisionStatus, "done");
  assert.equal(view.pending, false);
});

test("lineageToView implement done includes terminal job pointer", async () => {
  isolateStateRoot();
  const { lineageToView } = loadView();
  const repo = makeRepo();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({
    name: "old-orch",
    harness: "grok",
    computer: "2017 MacBook Pro",
    sessionId: "g"
  });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const assigned = await assignTask({
    from: "main",
    text: "implement the fix",
    machines: listMachines(),
    probes: {}
  });
  const { appendJob } = await import("../core/state.mjs");
  const job = appendJob(repo, { id: "11111111-2222-3333-4444-555555555555", status: "completed" });
  handleAssignedWork({
    name: "old-orch",
    cwd: repo,
    runWake: () => ({
      status: 0,
      stdout: `assign ${assigned.message.id} done\nkind: implement\njob: ${job.id}\nharness: grok\nfixed\n`
    })
  });
  const view = lineageToView(getLineage(assigned.message.id, { cwd: repo }));
  assert.equal(view.decisionStatus, "done");
  assert.equal(view.kind, "implement");
  assert.equal(view.jobId, job.id);
  assert.equal(view.jobStatus, "completed");
  assert.match(String(view.replyText), new RegExp(`^assign ${assigned.message.id} done`));
});

test("lineageToView hint ignored is rerouted with harness used", async () => {
  isolateStateRoot();
  const { lineageToView } = loadView();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({
    name: "old-orch",
    harness: "grok",
    computer: "2017 MacBook Pro",
    sessionId: "g"
  });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const assigned = await assignTask({
    from: "main",
    text: "look at CI",
    hintHarness: "grok",
    machines: listMachines(),
    probes: {}
  });
  handleAssignedWork({
    name: "old-orch",
    runWake: () => ({
      status: 0,
      stdout: `assign ${assigned.message.id} rerouted\nharness: cursor\nused cursor; grok down\n`
    })
  });
  const view = lineageToView(getLineage(assigned.message.id));
  assert.equal(view.decisionStatus, "rerouted");
  assert.equal(view.harness, "cursor");
  assert.equal(view.hintHarness, "grok");
});

test("installCollaboration fills the surface from real records", async () => {
  isolateStateRoot();
  const { lineageToView, rosterToView, installCollaboration } = loadView();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4" });
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "s" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  const assigned = await assignTask({
    from: "main",
    text: "watch this assign",
    hintHarness: "grok",
    machines: listMachines(),
    probes: {}
  });
  handleAssignedWork({
    name: "mini-orch",
    runWake: () => ({
      status: 0,
      stdout: `assign ${assigned.message.id} done\nkind: ping\nharness: grok\nok\n`
    })
  });
  const root = { innerHTML: "" };
  installCollaboration(root, {
    machines: listMachines(),
    assigns: [getLineage(assigned.message.id)]
  });
  assert.match(root.innerHTML, /main/);
  assert.match(root.innerHTML, /Mac Mini M4/);
  assert.match(root.innerHTML, /grok/);
  assert.match(root.innerHTML, /done/);
  assert.match(root.innerHTML, /watch this assign/);
  assert.doesNotMatch(root.innerHTML, /inbox dump/i);
  const row = lineageToView(getLineage(assigned.message.id));
  const machines = rosterToView(listMachines());
  assert.ok(machines.some((m) => m.computer === "Mac Mini M4"));
  assert.equal(row.from, "main");
});

test("peers serve exposes /collab page and /peers/collab from the lineage store", async () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4" });
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "s" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  const assigned = await assignTask({
    from: "main",
    text: "serve-collab-fixture",
    machines: listMachines(),
    probes: {}
  });
  const { server, url } = await listenPeersServer();
  try {
    const page = await fetch(`${url}/collab`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /collaboration-view\.js/);
    assert.match(html, /Fleet collaboration|Collaboration/);
    const js = await fetch(`${url}/collab/collaboration-view.js`);
    assert.equal(js.status, 200);
    const body = await peersHttp(url, { path: "/peers/collab" });
    assert.ok(Array.isArray(body.assigns));
    assert.ok(Array.isArray(body.machines));
    const hit = body.assigns.find((a) => a.id === assigned.message.id);
    assert.ok(hit);
    assert.equal(hit.from, "main");
    assert.equal(hit.text, "serve-collab-fixture");
    assert.equal(hit.messages, undefined);
  } finally {
    server.close();
  }
});
