// Merge N review artifacts (from a `--workers a,b` dual/multi review) into one
// report. Cross-family reviewers agree on only a minority of findings (that
// disagreement is the value — different families expose different blind spots),
// so the merge keeps EVERYTHING: findings both reviewers raised are deduped and
// tagged as agreements; single-reviewer findings stay, tagged with their source.
//
// Matching heuristic: same file + line_start within ±2 lines, from a different
// reviewer. On a match, the more severe copy's text wins; a severity mismatch is
// flagged (`severityDisagreement`) rather than silently resolved.

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

function titleTokens(title) {
  return new Set(
    String(title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2)
  );
}

function titlesDescribeSameIssue(a, b) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (!left.size || !right.size) return false;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / Math.min(left.size, right.size) >= 0.6;
}

function findingsMatch(a, b) {
  return (
    a.file === b.file &&
    Math.abs((a.line_start ?? 0) - (b.line_start ?? 0)) <= 2 &&
    titlesDescribeSameIssue(a.title, b.title)
  );
}

export function mergeReviews(legs) {
  const ok = legs.filter(
    (l) =>
      l?.result?.status === "completed" &&
      l.result.resultValid === true &&
      l.result.artifact &&
      Array.isArray(l.result.artifact.findings)
  );
  const failedLegs = legs
    .filter((l) => !ok.includes(l))
    .map((l) => ({
      worker: l?.worker ?? null,
      status: l?.result?.status ?? "missing",
      failureKind: l?.result?.failureKind ?? null
    }));

  const merged = [];
  for (const leg of ok) {
    for (const f of leg.result.artifact.findings ?? []) {
      const match = merged.find(
        (g) =>
          findingsMatch(g, f) &&
          !g.workers.includes(leg.worker)
      );
      if (match) {
        match.workers.push(leg.worker);
        match.agreement = true;
        if (match.severity !== f.severity) match.severityDisagreement = true;
        if ((SEV_RANK[f.severity] ?? 0) > (SEV_RANK[match.severity] ?? 0)) {
          Object.assign(match, {
            severity: f.severity,
            title: f.title,
            body: f.body,
            recommendation: f.recommendation ?? match.recommendation
          });
        }
      } else {
        const { ...rest } = f;
        merged.push({ ...rest, workers: [leg.worker], agreement: false });
      }
    }
  }
  merged.sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));

  // Worst-of verdict among completed legs. A requested leg that failed makes
  // the aggregate incomplete — never label a one-family result "approved" as
  // though the full cross-family gate completed.
  const provisionalVerdict = ok.some((l) => l.result.artifact.verdict === "needs-attention")
    ? "needs-attention"
    : ok.length
      ? "approve"
      : "unknown";
  const complete = ok.length === legs.length;
  const verdict = complete ? provisionalVerdict : "incomplete";

  const agreed = merged.filter((m) => m.agreement).length;
  return {
    verdict,
    provisionalVerdict,
    complete,
    summary:
      `${ok.length}/${legs.length} reviewers completed — ` +
      `${agreed} agreed finding(s), ${merged.length - agreed} single-reviewer finding(s)` +
      (failedLegs.length ? `; failed legs: ${failedLegs.map((f) => f.worker).join(", ")}` : ""),
    findings: merged,
    reviewers: ok.map((l) => l.worker),
    failedLegs
  };
}
