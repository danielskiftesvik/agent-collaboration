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

export function renderJobList(jobs) {
  if (!jobs.length) return "no jobs";
  return jobs
    .map((j) => `${j.id.slice(0, 8)}  ${j.worker}/${j.role}  ${j.status}  ${j.updatedAt}`)
    .join("\n");
}
