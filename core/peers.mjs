// Peer plane: named register / list / send / inbox. Machine-local mailbox.
// Job-plane dispatcher stays a separate module; this file must not import it.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveDataRoot } from "./state.mjs";

const PEERS_VERSION = 1;
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const PEER_LIVE_TTL_MS = 10 * 60 * 1000;

export function resolvePeersDir() {
  const explicit = process.env.AGENT_COLLAB_PEERS_DIR;
  if (explicit) return path.resolve(explicit);
  return path.join(resolveDataRoot(), "peers");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function withPeersLock(fn) {
  const dir = ensurePeersDir();
  const lock = path.join(dir, ".lock");
  const timeoutMs = Number(process.env.AGENT_COLLAB_LOCK_TIMEOUT_MS) || 60000;
  const staleMs = Number(process.env.AGENT_COLLAB_STALE_LOCK_MS) || 10000;
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        /* lock vanished */
      }
      if (Date.now() > deadline) throw new Error(`peers lock busy after ${timeoutMs}ms: ${lock}`);
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
        fs.unlinkSync(lock);
      } catch {
        /* ignore */
      }
    }
  }
}

function chmodPrivateDir(dir) {
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort on filesystems that ignore mode */
  }
}

function chmodPrivateFile(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

export function ensurePeersDir() {
  const dir = resolvePeersDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodPrivateDir(dir);
  const inbox = path.join(dir, "inbox");
  fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
  chmodPrivateDir(inbox);
  return dir;
}

function assertName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`invalid peer name: ${JSON.stringify(name)} (use ${NAME_RE})`);
  }
}

function registryPath() {
  return path.join(resolvePeersDir(), "registry.json");
}

function inboxPath(name) {
  assertName(name);
  return path.join(resolvePeersDir(), "inbox", `${name}.jsonl`);
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodPrivateFile(tmp);
  fs.renameSync(tmp, file);
  chmodPrivateFile(file);
}

function loadRegistry() {
  const file = registryPath();
  if (!fs.existsSync(file)) return { version: PEERS_VERSION, peers: {} };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || typeof parsed.peers !== "object" || parsed.peers === null) {
    return { version: PEERS_VERSION, peers: {} };
  }
  return { version: PEERS_VERSION, peers: parsed.peers };
}

function saveRegistry(reg) {
  writeJsonAtomic(registryPath(), { version: PEERS_VERSION, peers: reg.peers });
}

function nowIso() {
  return new Date().toISOString();
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function isLive(peer, nowMs = Date.now()) {
  const alive = pidAlive(peer?.pid);
  if (alive === false) return false;
  const ts = Date.parse(peer?.lastSeenAt ?? "");
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= PEER_LIVE_TTL_MS;
}

function peerStatus(peer, nowMs = Date.now()) {
  return isLive(peer, nowMs) ? "live" : "stale";
}

function normalizeTurnState(turnState) {
  if (turnState == null || turnState === "") return null;
  const v = String(turnState).toLowerCase();
  if (v !== "idle" && v !== "busy") {
    throw new Error(`invalid turnState: ${JSON.stringify(turnState)} (use idle|busy)`);
  }
  return v;
}

function publicPeer(peer, nowMs = Date.now()) {
  return {
    name: peer.name,
    harness: peer.harness ?? null,
    sessionId: peer.sessionId ?? null,
    pid: peer.pid ?? null,
    replyAddress: peer.replyAddress ?? peer.name,
    reach: peer.reach ?? "local",
    turnState: peer.turnState ?? null,
    status: peerStatus(peer, nowMs),
    registeredAt: peer.registeredAt,
    lastSeenAt: peer.lastSeenAt
  };
}

function nextSuffixedName(peers, base) {
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (NAME_RE.test(candidate) && !peers[candidate]) return candidate;
  }
  throw new Error(`could not allocate a unique name for ${base}`);
}

function normalizePid(pid) {
  if (pid == null || pid === "") return null;
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid pid: ${JSON.stringify(pid)}`);
  return n;
}

function buildPeer({ name, harness, sessionId, replyAddress, reach, pid, tokenHash }) {
  if (reach != null && reach !== "local" && reach !== "cross-machine") {
    throw new Error(`invalid reach: ${JSON.stringify(reach)} (use local|cross-machine)`);
  }
  const now = nowIso();
  return {
    name,
    harness: harness ?? null,
    sessionId: sessionId ?? null,
    pid: normalizePid(pid),
    tokenHash: tokenHash ?? null,
    replyAddress: replyAddress ?? name,
    reach: reach ?? "local",
    registeredAt: now,
    lastSeenAt: now
  };
}

function removeInboxFile(name) {
  try {
    fs.unlinkSync(inboxPath(name));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

export function registerPeer({ name, harness, sessionId, replyAddress, reach, pid, tokenHash } = {}) {
  assertName(name);
  return withPeersLock(() => {
    const reg = loadRegistry();
    const existing = reg.peers[name];
    let finalName = name;
    let collided = false;
    if (existing) {
      const sameSession =
        sessionId != null && existing.sessionId != null && String(sessionId) === String(existing.sessionId);
      if (sameSession) {
        existing.lastSeenAt = nowIso();
        if (harness !== undefined) existing.harness = harness;
        if (replyAddress !== undefined) existing.replyAddress = replyAddress;
        if (reach !== undefined) existing.reach = reach;
        if (pid !== undefined) existing.pid = normalizePid(pid);
        if (tokenHash !== undefined) existing.tokenHash = tokenHash;
        saveRegistry(reg);
        return { ...publicPeer(existing), collided: false };
      }
      if (isLive(existing)) {
        finalName = nextSuffixedName(reg.peers, name);
        collided = true;
      } else {
        removeInboxFile(name);
      }
    }
    const peer = buildPeer({ name: finalName, harness, sessionId, replyAddress, reach, pid, tokenHash });
    reg.peers[finalName] = peer;
    saveRegistry(reg);
    return { ...publicPeer(peer), collided };
  });
}

/** Register this process as a live peer (Claude-class presence). Default name is the harness. */
export function registerSelf({ harness, name, sessionId, replyAddress, pid } = {}) {
  if (!harness || typeof harness !== "string") throw new Error("registerSelf: harness is required");
  const base = name || harness;
  return registerPeer({
    name: base,
    harness,
    sessionId,
    replyAddress: replyAddress ?? base,
    pid: pid ?? process.pid,
    reach: "local"
  });
}

export function heartbeatPeer({ name, pid, turnState } = {}) {
  assertName(name);
  return withPeersLock(() => {
    const reg = loadRegistry();
    const existing = reg.peers[name];
    if (!existing) throw new Error(`unknown peer: ${name}`);
    existing.lastSeenAt = nowIso();
    if (pid !== undefined) existing.pid = normalizePid(pid);
    if (turnState !== undefined) existing.turnState = normalizeTurnState(turnState);
    saveRegistry(reg);
    return publicPeer(existing);
  });
}

export function unregisterPeer({ name } = {}) {
  assertName(name);
  return withPeersLock(() => {
    const reg = loadRegistry();
    if (!reg.peers[name]) throw new Error(`unknown peer: ${name}`);
    delete reg.peers[name];
    saveRegistry(reg);
    removeInboxFile(name);
    return { unregistered: name };
  });
}

export function getPeer(name) {
  assertName(name);
  return loadRegistry().peers[name] ?? null;
}

export function listPeers() {
  const nowMs = Date.now();
  const reg = loadRegistry();
  return Object.values(reg.peers)
    .map((peer) => publicPeer(peer, nowMs))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readInboxRecords(name) {
  const file = inboxPath(name);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return records;
}

function writeInboxRecords(name, records) {
  const file = inboxPath(name);
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  chmodPrivateFile(tmp);
  fs.renameSync(tmp, file);
  chmodPrivateFile(file);
}

function publicMessage(record) {
  return {
    id: record.id,
    from: record.from,
    to: record.to,
    text: record.text,
    replyAddress: record.replyAddress,
    origin: "peer-session",
    isConsent: false,
    isMergeGate: false,
    createdAt: record.createdAt
  };
}

export function sendMessage({ to, from, text, allowCrossMachine = false } = {}) {
  assertName(to);
  assertName(from);
  const body = text == null ? "" : String(text);
  return withPeersLock(() => {
    const reg = loadRegistry();
    const sender = reg.peers[from];
    const dest = reg.peers[to];
    if (!sender) throw new Error(`unknown sender: ${from}`);
    if (!dest) throw new Error(`unknown peer: ${to}`);
    if ((dest.reach ?? "local") === "cross-machine" && !allowCrossMachine) {
      const err = new Error(`cross-machine send is not implemented: ${to}`);
      err.code = "PEER_CROSS_MACHINE";
      throw err;
    }
    const msg = {
      id: randomUUID(),
      from,
      to,
      text: body,
      replyAddress: sender.replyAddress ?? from,
      origin: "peer-session",
      isConsent: false,
      isMergeGate: false,
      createdAt: nowIso(),
      acked: false
    };
    const records = readInboxRecords(to);
    records.push(msg);
    writeInboxRecords(to, records);
    return publicMessage(msg);
  });
}

export function readInbox({ name } = {}) {
  assertName(name);
  // Read-only: do not take the exclusive write lock (sandboxed receivers such as
  // Codex cannot create ~/.agent-collaboration/.../peers/.lock).
  return readInboxRecords(name).filter((r) => !r.acked).map(publicMessage);
}

export function ackInbox({ name, ids } = {}) {
  assertName(name);
  return withPeersLock(() => {
    const records = readInboxRecords(name);
    const markAll = !ids;
    const wanted = ids ? new Set(ids.map(String)) : null;
    let acked = 0;
    for (const record of records) {
      if (record.acked) continue;
      if (markAll || wanted.has(String(record.id))) {
        record.acked = true;
        acked += 1;
      }
    }
    writeInboxRecords(name, records);
    return { name, acked };
  });
}

export function isPeerConsent(_message) {
  return false;
}
