import { isTerminalStatus } from "./state.mjs";

export const ASSIGN_OUTCOME_RE = /^assign\s+(\S+)\s+(done|refuse|rerouted)\b/m;
const HARNESS_RE = /^harness:\s*(claude|codex|grok|cursor|opencode)\s*$/im;
const JOB_RE = /^job:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im;
const KIND_RE = /^kind:\s*(ping|implement)\s*$/im;

export function parseAssignOutcome(stdout, assignId) {
  const text = String(stdout || "");
  const matches = [...text.matchAll(new RegExp(ASSIGN_OUTCOME_RE.source, "gm"))];
  const hit = [...matches].reverse().find((m) => m[1] === String(assignId));
  if (!hit) return null;
  const after = text.slice(hit.index + hit[0].length);
  const harness = after.match(HARNESS_RE)?.[1]?.toLowerCase() ?? null;
  const jobId = after.match(JOB_RE)?.[1] ?? null;
  const kind = after.match(KIND_RE)?.[1]?.toLowerCase() ?? null;
  const reason =
    after
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^harness:/i.test(l) && !/^job:/i.test(l) && !/^kind:/i.test(l)) || null;
  return { assignId: hit[1], status: hit[2], reason, harness, jobId, kind, body: after.trim() };
}

export function finalizeAssignOutcome(parsed, { job = null } = {}) {
  if (!parsed) {
    return { status: "refuse", reason: "unparsed-outcome", harness: null, jobId: null, kind: null, text: null };
  }
  if (parsed.status === "done") {
    if (parsed.jobId) {
      if (!job || job.id !== parsed.jobId || !isTerminalStatus(job.status)) {
        return {
          status: "refuse",
          reason: "job-not-terminal",
          harness: parsed.harness,
          jobId: parsed.jobId,
          kind: parsed.kind,
          text: `assign ${parsed.assignId} refuse: job-not-terminal`
        };
      }
    } else if (parsed.kind !== "ping") {
      return {
        status: "refuse",
        reason: "done-needs-ping-or-job",
        harness: parsed.harness,
        jobId: null,
        kind: parsed.kind,
        text: `assign ${parsed.assignId} refuse: done-needs-ping-or-job`
      };
    }
  }
  const lines = [`assign ${parsed.assignId} ${parsed.status}`];
  if (parsed.kind) lines.push(`kind: ${parsed.kind}`);
  if (parsed.harness) lines.push(`harness: ${parsed.harness}`);
  if (parsed.jobId) lines.push(`job: ${parsed.jobId}`);
  if (parsed.reason) lines.push(parsed.reason);
  return {
    status: parsed.status,
    reason: parsed.reason,
    harness: parsed.harness,
    jobId: parsed.jobId,
    kind: parsed.kind,
    text: lines.join("\n")
  };
}
