import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { isolateStateRoot } from "./helpers.mjs";
import { registerPeer, sendMessage, readInbox } from "../core/peers.mjs";
import { listenPeersServer, peersHttp, hashPeerToken } from "../core/peers-serve.mjs";

const DISPATCH_SRC = fileURLToPath(new URL("../core/dispatch.mjs", import.meta.url));

test("dispatch.mjs does not import the peer server", () => {
  const src = fs.readFileSync(DISPATCH_SRC, "utf8");
  assert.doesNotMatch(src, /peers-serve\.mjs/);
});

test("listenPeersServer refuses all-interfaces and Tailscale without opt-in", () => {
  isolateStateRoot();
  delete process.env.AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND;
  assert.throws(() => listenPeersServer({ host: "0.0.0.0", port: 0 }), /all-interfaces|loopback/);
  assert.throws(() => listenPeersServer({ host: "100.109.229.92", port: 0 }), /Tailscale|loopback/);
});

test("assertPeersBindHost allows Tailscale CGNAT when opt-in is on", async () => {
  isolateStateRoot();
  const { assertPeersBindHost } = await import("../core/peers-serve.mjs");
  process.env.AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND = "on";
  assert.doesNotThrow(() => assertPeersBindHost("100.109.229.92"));
  assert.throws(() => assertPeersBindHost("10.0.0.7"), /loopback|Tailscale/);
  delete process.env.AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND;
});

test("HTTP send requires the sender token; inbox requires the owner token", async () => {
  isolateStateRoot();
  const { server, url } = await listenPeersServer();
  try {
    const alice = await peersHttp(url, {
      method: "POST",
      path: "/peers/register",
      body: { name: "alice", harness: "grok" }
    });
    const bob = await peersHttp(url, {
      method: "POST",
      path: "/peers/register",
      body: { name: "bob", harness: "codex" }
    });
    assert.ok(alice.token);
    assert.ok(bob.token);
    assert.notEqual(alice.token, bob.token);

    await assert.rejects(
      () =>
        peersHttp(url, {
          method: "POST",
          path: "/peers/send",
          token: bob.token,
          body: { to: "bob", from: "alice", text: "impersonate" }
        }),
      /send token must match/
    );

    const sent = await peersHttp(url, {
      method: "POST",
      path: "/peers/send",
      token: alice.token,
      body: { to: "bob", from: "alice", text: "serve-ping-exact" }
    });
    assert.equal(sent.text, "serve-ping-exact");
    assert.equal(sent.from, "alice");

    await assert.rejects(
      () => peersHttp(url, { path: "/peers/inbox?name=bob", token: alice.token }),
      /inbox token must match/
    );

    const box = await peersHttp(url, { path: "/peers/inbox?name=bob", token: bob.token });
    assert.equal(box.messages[0].text, "serve-ping-exact");
    assert.equal(readInbox({ name: "bob" })[0].text, "serve-ping-exact");
    assert.equal(hashPeerToken(alice.token).length, 64);
  } finally {
    server.close();
  }
});

test("HTTP send enqueues to a cross-machine dest (daemon path only)", async () => {
  isolateStateRoot();
  const { server, url } = await listenPeersServer();
  try {
    const alice = await peersHttp(url, {
      method: "POST",
      path: "/peers/register",
      body: { name: "alice", harness: "grok", reach: "local" }
    });
    await peersHttp(url, {
      method: "POST",
      path: "/peers/register",
      body: { name: "other-mac", harness: "cursor", reach: "cross-machine" }
    });
    const sent = await peersHttp(url, {
      method: "POST",
      path: "/peers/send",
      token: alice.token,
      body: { to: "other-mac", from: "alice", text: "via-http" }
    });
    assert.equal(sent.text, "via-http");
    assert.equal(readInbox({ name: "other-mac" })[0].text, "via-http");
  } finally {
    server.close();
  }
});

test("file-path send still works when PEERS_URL is unset", () => {
  isolateStateRoot();
  delete process.env.AGENT_COLLAB_PEERS_URL;
  registerPeer({ name: "alice", harness: "grok" });
  registerPeer({ name: "bob", harness: "cursor" });
  const sent = sendMessage({ to: "bob", from: "alice", text: "files-still-work" });
  assert.equal(readInbox({ name: "bob" })[0].id, sent.id);
});
