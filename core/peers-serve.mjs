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
  listMachines,
  registerMachine,
  getPeer,
  sendMessage,
  readInbox,
  ackInbox,
  resolveComputer
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

/** Pair secret for join/list/health. Null = not configured (loopback may omit). */
export function resolvePairToken({ pair, env = process.env } = {}) {
  const raw = pair ?? env.AGENT_COLLAB_PEERS_PAIR;
  if (raw == null || String(raw) === "") return null;
  return String(raw);
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

export function createPeersServer({ pairToken = null, computer = null } = {}) {
  const serveComputer = resolveComputer({ computer });
  const pairHash = pairToken ? hashPeerToken(pairToken) : null;
  const pairOk = (req) => {
    if (!pairHash) return true;
    const presented = bearer(req);
    if (!presented) return false;
    return tokensEqual(hashPeerToken(presented), pairHash);
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/peers/health") {
        if (!pairOk(req)) {
          sendJson(res, 401, { error: "pair token required" });
          return;
        }
        const nowMs = Date.now();
        const probes = {};
        if (serveComputer) {
          probes[serveComputer] = { ok: true, at: new Date(nowMs).toISOString() };
        }
        sendJson(res, 200, {
          ok: true,
          peers: listPeers().length,
          host: os.hostname(),
          computer: serveComputer,
          machines: listMachines({ nowMs, probes })
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/peers/list") {
        if (!pairOk(req)) {
          sendJson(res, 401, { error: "pair token required" });
          return;
        }
        sendJson(res, 200, { peers: listPeers() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/peers/register") {
        if (!pairOk(req)) {
          sendJson(res, 401, { error: "pair token required" });
          return;
        }
        const body = JSON.parse((await readBody(req)) || "{}");
        const issued = newPeerToken();
        const remote = req.socket?.remoteAddress || "";
        const fromLoopback =
          remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
        const peer = registerPeer({
          name: body.name,
          harness: body.harness,
          sessionId: body.sessionId,
          replyAddress: body.replyAddress,
          reach: body.reach ?? (fromLoopback ? "local" : "cross-machine"),
          pid: body.pid,
          tokenHash: hashPeerToken(issued),
          computer: body.computer ?? serveComputer
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
          heartbeatPeer({
            name: body.name,
            pid: body.pid,
            turnState: body.turnState,
            computer: body.computer
          })
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
        // cross-machine. File-path send still fail-closes. Join is the pair
        // token on register/list/health when one is configured.
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

export async function peersHttp(baseUrl, { method = "GET", path, token, body, timeoutMs = 5000 } = {}) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(Number(timeoutMs) || 5000)
  });
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

/** Probe registered machine URLs. Unreachable / asleep / traveling → ok:false. */
export async function collectMachineProbes(records, { pair, timeoutMs = 2000 } = {}) {
  const probes = {};
  await Promise.all(
    (records || []).map(async (rec) => {
      if (!rec?.computer || !rec.url) return;
      try {
        const health = await peersHttp(rec.url, {
          path: "/peers/health",
          token: pair,
          timeoutMs
        });
        let sessions = [];
        try {
          const listed = await peersHttp(rec.url, {
            path: "/peers/list",
            token: pair,
            timeoutMs
          });
          sessions = listed.peers || [];
        } catch {
          sessions = [];
        }
        probes[rec.computer] = {
          ok: true,
          at: new Date().toISOString(),
          sessions,
          computer: health.computer ?? rec.computer
        };
      } catch {
        probes[rec.computer] = { ok: false, at: new Date().toISOString(), error: "unreachable" };
      }
    })
  );
  return probes;
}

export function listenPeersServer({ host = "127.0.0.1", port = 0, pair, computer } = {}) {
  assertPeersBindHost(host);
  const pairToken = resolvePairToken({ pair });
  if (!isLoopbackHost(host) && !pairToken) {
    throw new Error("peers serve remote bind requires --pair or AGENT_COLLAB_PEERS_PAIR");
  }
  const serveComputer = resolveComputer({ computer });
  const server = createPeersServer({ pairToken, computer: serveComputer });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port) || 0, host, () => {
      const addr = server.address();
      const url = `http://${host}:${addr.port}`;
      if (serveComputer) {
        registerMachine({
          computer: serveComputer,
          url: isLoopbackHost(host) ? undefined : url
        });
      }
      resolve({
        server,
        url,
        host,
        port: addr.port,
        pairRequired: Boolean(pairToken),
        computer: serveComputer
      });
    });
  });
}
