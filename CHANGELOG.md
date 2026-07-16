# Changelog

## 0.6.5 - 2026-07-16

- Add liveness-aware garbage collection on launches, cancellation, and dead-process refresh so terminal/crashed collaboration worktrees cannot accumulate indefinitely while live active jobs remain protected; fail closed on missing/corrupt state and converge terminal PID-reuse debris after a grace period.
- Cap terminal state history without evicting active jobs, preventing active worktrees from becoming untracked, and reconcile dead nonterminal records whose worktree is already missing.
- Add configurable 30-day artifact retention that scans task directories on disk and preserves active jobs, recent reports, and unapplied patches by default; bound launch-time recursive scans and add unbounded `gc --dry-run` plus explicit `--include-unapplied` cleanup.

## 0.6.2 - 2026-07-11

- Review provenance hardening (codex): explicit `head|working-tree|diff` surfaces with fail-closed ambiguity on dirty checkouts, safe working-tree snapshots, default result envelopes with warnings/telemetry, incomplete partial dual reviews (never "approved" on one family), stricter finding contracts (`critical` rank, needs-attention requires a finding, title-similarity dedup), focused `review-followup`, and optional repo-owned worktree/disk preflight limits.

## 0.6.1 - 2026-07-11

- Fix: `review --workers a,b` (dual review) was unreachable — the `--worker`-required guard fired first. Found by the first live dual-review run; the guard now accepts `--workers`, the native-route shortcut applies only to a single named worker, and dual mode rejects `--background` explicitly.

## 0.6.0 - 2026-07-11

- Named pin profiles: `.agent-collab.json` gains a `profiles` section; select per dispatch with `--profile <name>` on delegate/review/adversarial-review (precedence: env > profile > standing pin > harness default; unknown profiles warn and fall back, never silently).
- Dual cross-family review: `--workers a,b` fans one brief to multiple reviewers (sequential, no per-leg fallback) and merges artifacts — agreements deduped with `workers[]`/`agreement` tags, severity disagreements flagged, worst-of verdict, failed legs reported.

## 0.5.8 - 2026-07-11

- Repo-level standing model pins: tracked `.agent-collab.json` (per worker+role) now feeds codex (model+effort), claude, and agy model resolution below the env levers and above adapter defaults — the pinned reviewer instrument survives interactive sessions rewriting harness base configs and applies identically from every driver harness. Malformed pin files warn and behave as unpinned.

## 0.5.7 - 2026-07-11

- codex adapter: per-dispatch `--model`/`--effort` via `AGENT_COLLAB_CODEX_MODEL`/`AGENT_COLLAB_CODEX_EFFORT`, with reviewer-scoped defaults `_MODEL_REVIEW`/`_EFFORT_REVIEW` (generic wins; unset preserves prior behavior — base `~/.codex/config.toml` governs). Enables the Terra-standard / Sol-boundary review seat policy without hand-editing the user's config. Resume-repair never re-pins (the thread keeps its model).

## 0.5.6 - 2026-07-10

- Recover lost collaboration envelopes with lock-free `status/result --latest`, filterable by worker and role.
- Make status/result reads non-mutating by default; liveness updates now require `--refresh` or `--wait` and only touch selected jobs.
- Require artifact-first recovery in the collaboration skills before retrying a quiet or apparently blank review.

## 0.5.5 - 2026-07-09

- Persist per-attempt stdout/stderr and redacted command metadata, expose runtime/state paths, and add active/recent status filters for quieter Codex-driven Claude collaboration.
- Record review provenance (`baseRef`, dirty launch paths, diff-staging state) and classify empty-output runs as fallback-eligible.

## 0.5.4 - 2026-07-09

- Re-enable codex as a write-worker, keep it eligible in write-task routing, and document its slower/quiet-run caveats instead of treating it as reviewer-only.

## 0.5.3 - 2026-07-08

- Keep non-exempt real-checkout writes as hard `breach` by default; ambiguous concurrent-edit downgrade now requires explicit opt-in.
- Prevent stale status reads from attaching `stalled` metadata to jobs that already completed.
- Count nested file activity in the idle watchdog when `fs.watch` is unavailable, and steal stale state locks before the write timeout.

## 0.5.2 - 2026-07-07

- Keep healthy quiet codex reviews alive by watching `.codex` log/session activity and giving codex a wider idle budget.
- Treat unparsed reviewer prose as a completed report, normalize verdict synonyms, and ignore extra top-level review keys.
- Downgrade exempt real-checkout edits to `breachWarning` while preserving hard breaches for unsafe worker escapes.
- Mark codex reviewer-only for implementation routing; add visual/multimodal routing to agy.
- Refresh stale background jobs on status reads, harden state locking, add live fallback doctor coverage, and return apply paths/stat.
- Update collaborative-investigation guidance to gate on agreement/no unresolved high-severity objection instead of a numeric threshold.
