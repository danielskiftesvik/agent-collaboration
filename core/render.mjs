// Human-readable rendering for CLI output (the --json paths bypass this).

function secondsLeft(fromIso, ms) {
  if (!fromIso || !ms) return null;
  return Math.max(0, Math.ceil((new Date(fromIso).getTime() + ms - Date.now()) / 1000));
}

export function renderSetup(rows) {
  return rows
    .map((r) => {
      const mark = !r.available ? "✗ unavailable" : r.validWorker ? "✓ worker-ready" : "⚠ interactive-only";
      const detail = r.version ? ` (${r.version})` : r.reason ? ` — ${r.reason}` : "";
      return `${r.name.padEnd(8)} ${mark}${detail}`;
    })
    .join("\n");
}

export function renderJob(job) {
  if (!job) return "no such job";
  const running = job.status === "running" || job.status === "queued";
  const idleLeft = running ? secondsLeft(job.lastProgressAt || job.heartbeatAt, job.idleMs) : null;
  const hardLeft = running ? secondsLeft(job.startedAt || job.createdAt, job.timeoutMs) : null;
  return [
    `job      ${job.id}`,
    `route    ${job.driver} → ${job.worker} (${job.role})`,
    `status   ${job.status}${job.valid === false ? " (invalid output)" : ""}`,
    running && job.pid ? `pid      ${job.pid}` : null,
    running ? `progress ${job.lastProgressAt || job.heartbeatAt || "unknown"}${job.lastProgressKind ? ` (${job.lastProgressKind})` : ""}` : null,
    idleLeft != null ? `idle     kill in ${idleLeft}s` : null,
    hardLeft != null ? `timeout  kill in ${hardLeft}s` : null,
    `updated  ${job.updatedAt}`,
    job.artifactDir ? `artifacts ${job.artifactDir}` : null,
    job.logs?.run ? `logs     ${job.logs.run}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderRecommendation(rec) {
  if (rec.mode === "native") return `native — use ${rec.harness}'s own subagent\n  ${rec.reason}`;
  if (rec.mode === "none" || !rec.worker) return rec.reason;
  const lines = [
    `${rec.worker}  (${rec.profile.model}, ${rec.profile.vendor})`,
    `  why: ${rec.reason}`,
    `  strong at: ${rec.profile.strongerAt.slice(0, 3).join("; ")}`
  ];
  if (rec.alternatives?.length) lines.push(`  alternatives: ${rec.alternatives.join(", ")}`);
  return lines.join("\n");
}

export function renderProfiles(profiles) {
  return Object.values(profiles)
    .map(
      (p) =>
        `${p.harness.padEnd(7)} ${p.model} (${p.vendor})\n` +
        `  + ${p.strongerAt.join("; ")}\n` +
        `  - ${p.weakerAt.join("; ")}`
    )
    .join("\n\n");
}

export function renderJobList(jobs) {
  if (!jobs.length) return "no jobs";
  return jobs
    .map((j) => `${j.id.slice(0, 8)}  ${j.worker}/${j.role}  ${j.status}  ${j.updatedAt}`)
    .join("\n");
}
