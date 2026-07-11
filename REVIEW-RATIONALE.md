# Why this review-provenance hardening exists

This change set comes from concrete friction observed during a real Codex/Claude collaboration:

- A natural-language Claude review launched from a dirty checkout did not carry an explicit surface. Claude recovered by inspecting the live checkout, but the saved job could not prove whether the verdict covered `HEAD`, the uncommitted tree, or only the prose brief.
- `result --json` exposed the artifact but omitted warnings and job provenance, so automation could miss containment notes, the reviewed surface, or an invalid-result condition.
- A dual review could look approved when one requested reviewer failed. Its merger also ranked `critical` incorrectly and could collapse unrelated findings merely because their lines were close.
- The contract allowed actionable problems to appear only in `next_steps`, outside machine-checkable `findings`.
- Jobs did not record enough to reproduce the reviewer instrument: resolved model/effort, runtime/template version, duration, and available provider telemetry.
- Rechecking a fix required another broad review instead of a focused follow-up tied to the original job.
- Repo-specific worktree and disk limits lived outside the plugin, so resource failures happened after dispatch rather than at a configurable preflight boundary.

The implementation therefore fails closed on ambiguous dirty-tree reviews, snapshots `working-tree` reviews without mutating the user's Git index, makes result provenance unavoidable by default, reports partial dual reviews as incomplete, tightens finding validation and deduplication, records execution telemetry, adds focused follow-ups, and supports optional repo-owned preflight limits. The regression tests let the Fable 5 review challenge each guarantee directly rather than rely on this narrative.

One verification issue was also exposed: the package's old `npm test` command recursively discovered deliberately broken model-capability fixtures. The script now targets the plugin's `test/*.test.mjs` suite; capability fixtures remain runnable through their own harness.
