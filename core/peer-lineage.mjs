// One assign-id record: who sent what, where, decision, local job pointer.
import fs from "node:fs";
import path from "node:path";

import { parseAssignOutcome } from "./peer-outcome.mjs";
import { ensurePeersDir, listRemoteInboxes, readInbox, resolvePeersDir } from "./peers.mjs";
import { peersHttp } from "./peers-serve.mjs";
import { getJob, isTerminalStatus } from "./state.mjs";

function lineagePath() {
  return path.join(resolvePeersDir(), "lineage.json");
}

function chmodPrivateFile(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

function loadStore() {
  const file = lineagePath();
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  ensurePeersDir();
  const file = lineagePath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodPrivateFile(tmp);
  fs.renameSync(tmp, file);
  chmodPrivateFile(file);
}

function nowIso() {
  return new Date().toISOString();
}

function emptyRecord(id) {
  return {
    id: String(id),
    from: null,
    to: null,
    text: null,
    computer: null,
    hintHarness: null,
    assignedHarness: null,
    createdAt: null,
    decision: null,
    job: null,
    reply: null
  };
}

function mergeRecord(prev, patch) {
  const next = { ...(prev || emptyRecord(patch.id || prev?.id)), ...patch };
  delete next.messages;
  delete next.inbox;
  return next;
}

export function recordAssignLineage({
  id,
  from,
  to,
  text,
  computer,
  hintHarness,
  assignedHarness,
  createdAt
} = {}) {
  if (!id) throw new Error("lineage: id is required");
  const store = loadStore();
  store[id] = mergeRecord(store[id], {
    id: String(id),
    from: from ?? null,
    to: to ?? null,
    text: text == null ? null : String(text),
    computer: computer ?? null,
    hintHarness: hintHarness ?? null,
    assignedHarness: assignedHarness ?? null,
    createdAt: createdAt ?? nowIso()
  });
  saveStore(store);
  return getLineage(id);
}

export function recordConsumeLineage({
  id,
  status,
  reason,
  kind,
  harness,
  jobId,
  jobStatus,
  reply
} = {}) {
  if (!id) throw new Error("lineage: id is required");
  const store = loadStore();
  const decision = {
    status: status ?? null,
    reason: reason ?? null,
    kind: kind ?? null,
    harness: harness ?? null,
    jobId: jobId ?? null,
    at: nowIso()
  };
  const job = jobId ? { id: jobId, status: jobStatus ?? null } : null;
  store[id] = mergeRecord(store[id], {
    id: String(id),
    decision,
    job,
    reply: reply
      ? {
          id: reply.id ?? null,
          from: reply.from ?? null,
          to: reply.to ?? null,
          text: reply.text ?? null,
          createdAt: reply.createdAt ?? nowIso()
        }
      : store[id]?.reply ?? null
  });
  saveStore(store);
  return getLineage(id);
}

function inboxNames() {
  const dir = path.join(resolvePeersDir(), "inbox");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}

function applyOutcomeMessage(record, message) {
  const parsed = parseAssignOutcome(message?.text, record.id);
  if (!parsed) return record;
  return mergeRecord(record, {
    decision: {
      status: parsed.status,
      reason: parsed.reason,
      kind: parsed.kind,
      harness: parsed.harness,
      jobId: parsed.jobId,
      at: message.createdAt ?? nowIso()
    },
    job: parsed.jobId ? { id: parsed.jobId, status: record.job?.status ?? null } : record.job,
    reply: {
      id: message.id ?? null,
      from: message.from ?? null,
      to: message.to ?? null,
      text: message.text ?? null,
      createdAt: message.createdAt ?? null
    }
  });
}

function attachJob(record, cwd) {
  const jobId = record.job?.id || record.decision?.jobId;
  if (!jobId || !cwd) return record;
  const job = getJob(cwd, jobId);
  if (!job) return record;
  return mergeRecord(record, {
    job: {
      id: job.id,
      status: job.status ?? null,
      terminal: isTerminalStatus(job.status)
    }
  });
}

export function getLineage(assignId, { cwd } = {}) {
  if (!assignId) throw new Error("lineage: id is required");
  const id = String(assignId);
  let record = loadStore()[id] || emptyRecord(id);
  if (!record.decision) {
    for (const name of inboxNames()) {
      for (const message of readInbox({ name })) {
        record = applyOutcomeMessage(record, message);
        if (record.decision) break;
      }
      if (record.decision) break;
    }
  }
  return attachJob(record, cwd);
}

export async function resolveLineage(assignId, { cwd } = {}) {
  let record = getLineage(assignId, { cwd });
  if (record.decision) return record;
  const from = record.from;
  if (!from) return record;
  for (const cred of listRemoteInboxes(from)) {
    try {
      const box = await peersHttp(cred.url, {
        path: `/peers/inbox?name=${encodeURIComponent(cred.name)}`,
        token: cred.token,
        timeoutMs: 4000
      });
      for (const message of box.messages || []) {
        const next = applyOutcomeMessage(record, message);
        if (next.decision) {
          const store = loadStore();
          store[record.id] = next;
          saveStore(store);
          return attachJob(next, cwd);
        }
      }
    } catch {
      /* keep looking */
    }
  }
  return record;
}

export function formatLineage(record) {
  const lines = [`assign ${record.id}`];
  lines.push(`from ${record.from ?? "-"} -> ${record.to ?? "-"} on ${record.computer ?? "-"}`);
  if (record.hintHarness) lines.push(`hint: ${record.hintHarness}`);
  if (record.assignedHarness) lines.push(`assignedHarness: ${record.assignedHarness}`);
  if (record.text) lines.push(`text: ${record.text}`);
  if (record.decision) {
    lines.push(`decision: ${record.decision.status}${record.decision.reason ? ` ${record.decision.reason}` : ""}`);
    if (record.decision.kind) lines.push(`kind: ${record.decision.kind}`);
    if (record.decision.harness) lines.push(`harness: ${record.decision.harness}`);
  } else {
    lines.push("decision: (pending)");
  }
  if (record.job?.id) {
    lines.push(`job: ${record.job.id}${record.job.status ? ` (${record.job.status})` : ""}`);
  }
  if (record.reply?.text) lines.push(record.reply.text);
  return lines.join("\n");
}
