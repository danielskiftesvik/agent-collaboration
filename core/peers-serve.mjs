// Local mailbox daemon. Owns peers files so sandboxed clients can send over
// loopback instead of writing $HOME. Opt-in Tailscale CGNAT bind for dual-Mac.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import os from "node:os";

import {
  registerPeer,
  unregisterPeer,
  heartbeatPeer,
  listPeers,
  getPeer,
  sendMessage,
  readInbox,
  ackInbox
} from "./peers.mjs";

export function hashPeerToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function newPeerToken() {
  return randomBytes(24).toString("base64url");
}

export function tokensEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Tailscale CGNAT 100.64.0.0/10 */
export function isTailscaleIPv4(host) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(host || ""));
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Loopback always OK. Tailscale CGNAT OK when AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on.
 * Never 0.0.0.0 / ::.
 */
export function assertPeersBindHost(host) {
  const h = String(host || "");
  if (!h) throw new Error("peers serve host required");
  if (h === "0.0.0.0" || h === "::" || h === "*") {
    throw new Error("peers serve refuses all-interfaces bind (0.0.0.0/::)");
  }
  if (isLoopbackHost(h)) return;
  const allow =
    /^(1|true|on|yes)$/i.test(String(process.env.AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND || ""));
  if (allow && isTailscaleIPv4(h)) return;
  throw new Error(
    `peers serve binds loopback only (got ${h}); set AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on for Tailscale 100.x`
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function bearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)/i.exec(h);
  return m ? m[1] : req.headers["x-peer-token"] || "";
}

function requirePeerToken(peer, token) {
  if (!peer?.tokenHash || !token) return false;
  return tokensEqual(peer.tokenHash, hashPeerToken(token));
}

export function createPeersServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/peers/health") {
        sendJson(res, 200, { ok: true, peers: listPeers().length, host: os.hostname() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/peers/list") {
        sendJson(res, 200, { peers: listPeers() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/peers/register") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const issued = newPeerToken();
        const peer = registerPeer({
          name: body.name,
          harness: body.harness,
          sessionId: body.sessionId,
          replyAddress: body.replyAddress,
          reach: body.reach ?? "local",
          pid: body.pid,
          tokenHash: hashPeerToken(issued)
        });
        sendJson(res, 200, { ...peer, token: issued });
        return;
      }
      if (req.method === "POST" && url.pathname === "/peers/heartbeat") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const listed = getPeer(body.name);
        if (!requirePeerToken(listed, bearer(req))) {
          sendJson(res, 401, { error: "peer token required" });
          return;
        }
        sendJson(
          res,
          200,
          heartbeatPeer({ name: body.name, pid: body.pid, turnState: body.turnState })
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/peers/send") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const sender = getPeer(body.from);
        if (!requirePeerToken(sender, bearer(req))) {
          sendJson(res, 401, { error: "send token must match --from" });
          return;
        }
        // HTTP is the dual-Mac transport: allow enqueue even if dest.reach is
        // cross-machine. File-path send still fail-closes. Register/list/health
        // stay unauthenticated — this is opt-in transport, not a pair table.
        sendJson(
          res,
          200,
          sendMessage({ to: body.to, from: body.from, text: body.text, allowCrossMachine: true })
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/peers/inbox") {
        const name = url.searchParams.get("name");
        const owner = name ? getPeer(name) : null;
        if (!requirePeerToken(owner, bearer(req))) {
          sendJson(res, 401, { error: "inbox token must match --name" });
          return;
        }
        const messages = readInbox({ name });
        if (url.searchParams.get("ack") === "1") ackInbox({ name, ids: messages.map((m) => m.id) });
        sendJson(res, 200, { name, messages, acked: url.searchParams.get("ack") === "1" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/peers/unregister") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const owner = getPeer(body.name);
        if (!requirePeerToken(owner, bearer(req))) {
          sendJson(res, 401, { error: "unregister token must match --name" });
          return;
        }
        sendJson(res, 200, unregisterPeer({ name: body.name }));
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  });
}

export async function peersHttp(baseUrl, { method = "GET", path, token, body } = {}) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    const err = new Error(json.error || `peers http ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export function listenPeersServer({ host = "127.0.0.1", port = 0 } = {}) {
  assertPeersBindHost(host);
  const server = createPeersServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port) || 0, host, () => {
      const addr = server.address();
      resolve({ server, url: `http://${host}:${addr.port}`, host, port: addr.port });
    });
  });
}
