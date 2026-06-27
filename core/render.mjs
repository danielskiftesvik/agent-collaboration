// Human-readable rendering for CLI output (the --json paths bypass this).

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
  return [
    `job      ${job.id}`,
    `route    ${job.driver} → ${job.worker} (${job.role})`,
    `status   ${job.status}${job.valid === false ? " (invalid output)" : ""}`,
    `updated  ${job.updatedAt}`,
    job.artifactDir ? `artifacts ${job.artifactDir}` : null
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
