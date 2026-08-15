// Main-orchestrator assign: pick an eligible machine, then enqueue a peer message.
// Does not use the job-plane dispatcher. send stays enqueue-only.
import {
  listMachineRecords,
  listMachines,
  pickMachine,
  sendMessage,
  rememberRemoteInbox,
  listRemoteInboxes
} from "./peers.mjs";
import { collectMachineProbes, peersHttp } from "./peers-serve.mjs";

export async function assignTask({
  from,
  text,
  pair,
  harness,
  computer,
  toComputer,
  machines,
  probes,
  sessionId
} = {}) {
  if (!from) throw new Error("assign: from is required");
  const body = text == null ? "" : String(text);
  if (!body) throw new Error("assign: a text payload is required");

  const rows =
    machines ??
    listMachines({
      probes: probes ?? (await collectMachineProbes(listMachineRecords(), { pair }))
    });
  const machine = pickMachine(rows, { computer: toComputer });
  if (!machine) {
    const err = new Error("no eligible machine: need available and not busy");
    err.code = "PEER_NO_CAPACITY";
    err.machines = rows;
    throw err;
  }

  const to = machine.session.name;
  let message;
  let senderToken = null;
  let senderName = from;
  if (machine.url) {
    const sender = await peersHttp(machine.url, {
      method: "POST",
      path: "/peers/register",
      token: pair,
      body: {
        name: from,
        harness: harness ?? null,
        computer: computer ?? null,
        sessionId: sessionId ?? from
      }
    });
    senderToken = sender.token ?? null;
    senderName = sender.name ?? from;
    message = await peersHttp(machine.url, {
      method: "POST",
      path: "/peers/send",
      token: sender.token,
      body: { to, from: senderName, text: body }
    });
    rememberRemoteInbox({ name: senderName, url: machine.url, token: senderToken });
  } else {
    message = sendMessage({ to, from, text: body });
  }

  return { machine, message, to, remote: Boolean(machine.url), senderName, senderToken };
}

export async function waitForReply({
  name,
  url,
  token,
  from,
  afterCreatedAt,
  timeoutMs = 60_000,
  pollMs = 1500
} = {}) {
  if (!name) throw new Error("waitForReply: name is required");
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(200, Number(pollMs) || 1500);
  let creds = url && token ? [{ name, url, token }] : listRemoteInboxes(name);
  if (!creds.length) throw new Error(`waitForReply: no remote inbox credentials for ${name}`);

  const cutoff = afterCreatedAt ? Date.parse(afterCreatedAt) : 0;
  while (Date.now() <= deadline) {
    for (const c of creds) {
      try {
        const box = await peersHttp(c.url, {
          path: `/peers/inbox?name=${encodeURIComponent(c.name)}`,
          token: c.token,
          timeoutMs: Math.min(4000, interval)
        });
        const hit = (box.messages || []).find((m) => {
          if (from && m.from !== from) return false;
          if (!cutoff) return true;
          const ts = Date.parse(m.createdAt ?? "");
          return Number.isFinite(ts) ? ts >= cutoff - 1000 : true;
        });
        if (hit) return { ...hit, inboxName: c.name, remoteUrl: c.url };
      } catch {
        /* keep polling */
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const err = new Error(`waitForReply: timed out waiting for a reply to ${name}`);
  err.code = "PEER_REPLY_TIMEOUT";
  throw err;
}
