# Changelog

## 0.13.1 - 2026-08-29

- **Launch no longer parks on janitor I/O or sibling probes (#1548).**
  `delegate`/`review`/`setup` used to run `collectGarbage` synchronously, then
  `runWithFallback` probed every adapter via unbounded `spawnSync` even with
  `--no-fallback`. A hung `probe()` or `git worktree remove` left the parent at
  ~0% CPU with no `tasks/<uuid>/` dir. Now:
  - Launch GC is detached (`AGENT_COLLAB_LAUNCH_GC=sync|off` to override).
  - `--no-fallback` / empty `fallbackKinds` with an explicit worker skips
    `runSetup()`, then bound-probes only that worker so a hung `--version`
    fails in ~15s instead of the 4h worker budget.
  - Control-plane `run()` gets a 15s default timeout (`AGENT_COLLAB_CMD_TIMEOUT_MS`;
    `0` disables). Idle-guarded workers keep the role-sized hard timeout.
  - `git worktree add/remove/prune` and `listWorktrees` use that deadline.
  - GC unlinks out-of-root symlinks without following them into a live tree.
  - Stderr `agent-collab <iso> …` lines log before task registration.

## 0.13.0 - 2026-08-23

- **DeepSeek Harness (`dsh`) is a full citizen.** Driver, worker, and reviewer.
  Always explicit (`explicitOnly`) — `recommend` will not auto-select it.
  Workers run `dsh --profile headless` with `DSH_PERMISSION_MODE=danger-full-access`
  so headless cannot block on an approval prompt. Isolation is the worktree +
  breach detection (there is no grok-style read-only `plan` mode).
- **Native Cordis plugin.** `dsh plugin --profile web add` installs `/ac`, which
  forwards to the companion with `--driver dsh`. Detection keys off
  `DSH_PLUGIN_ROOT` only (`DSH_HOME` is install-time, not a driver signal).
- Cheap live probe coverage when `dsh` is on PATH; the spendy doctor cycle is
  opt-in via `AGENT_COLLAB_LIVE_DSH=1` (`test/dsh-live.test.mjs`).

## 0.12.4 - 2026-08-21

- **OpenCode same-session continue after null turn.** On a detected null turn,
  dispatch makes one `run --session <id>` nudge (session id from telemetry;
  never bare `--continue`) before failing as `empty-output`.
- **Soft quiet warn (~45s).** `status`/`health` report `quiet: true` /
  `state: "quiet"` when a live worker has no progress for
  `AGENT_COLLAB_QUIET_AFTER` seconds (default 45). Idle kill stays at 10 min.
  Drivers should poll `status <jobId> --json` and treat quiet as an early wedge.

## 0.12.3 - 2026-08-21

- **OpenCode null-turn detection.** A terminal `step_finish` with no answer text
  (e.g. `x-preview-f` `reason=unknown` + zero tokens after real tool calls) is
  now an adapter error with `workerTelemetry.nullTurn`, classified as
  `failureKind: empty-output` (fallback-eligible). OpenCode remains
  `explicitOnly`, so `runWithFallback` still will not auto-cascade away from it
  — use `--no-fallback` for locked seats, or an explicit multi-worker chain /
  driver-level retry for recovery. Previously these runs were `failed`/`other`
  and dumped raw NDJSON into the report (reviewers could look "completed").
  Raw-stdout fallback only applies when no NDJSON events parsed; mid-step text
  is salvaged.

## 0.12.2 - 2026-08-21

- **Soften breach remediation when shared-checkout dirt is disjoint from the job
  patch (#1098).** Containment still diffs the driver's shared checkout status over
  the job wall-clock window (not worker cwd / touchedFiles), so concurrent writers
  remain a hard `breach` by default. The error text and `result-handling` skill no
  longer lead with "inspect and revert them"; they require path attribution first.
  Process/writer attribution after exit is not cheap — this is the safer default
  message, not a full scoping rewrite. Opt-in `AGENT_COLLAB_BREACH_WARN_CONCURRENT=on`
  still downgrades ambiguous concurrent dirt to `breachWarning`.

## 0.12.1 - 2026-08-13

- **Fix grok false-positive `INCOMPLETE RUN` banner**: normalize `stopReason`
  before comparing so both CLI spellings (`EndTurn` and `end_turn`) count as a
  clean finish; keep `Cancelled` (and other non-end_turn reasons) as incomplete.
  Telemetry now also records `stopReasonNormalized`.

## 0.12.0 - 2026-08-12

- **New `cursor` harness** (driver + worker + reviewer) via the Cursor Agent CLI.
  Binary resolution never falls back to bare `agent` (Grok Build collision);
  prefers `AGENT_COLLAB_CURSOR_BIN` → `~/.cursor/bin/agent` → newest
  `~/.local/share/cursor-agent` installs → `cursor-agent`.
- Driver auto-detect: `CURSOR_AGENT` / `CURSOR_CONVERSATION_ID` (before Claude).
- `recommend` includes Cursor for SWE/refactor/plan/mechanical routes; review and
  second-opinion stay on calibrated reasoners (explicit `--worker cursor` still works).
- Codex workers forward `AGENT_COLLAB_CODEX_HOME` / ambient `CODEX_HOME` (e.g.
  `codex-business` / `~/.codex-business`) into the spawn env **and** cleanup.
- Curated `recommend` routes no longer escape their worker list via generic
  fallback (keeps Cursor out of auto review/second-opinion when preferred
  workers are down).
- Docs: `examples/CURSOR.md`, `skills/harness-prompting/references/cursor.md`.

## 0.11.0 - 2026-07-29

- **Per-harness concurrency slots with visible queueing**: background jobs
  acquire a per-harness+instance slot before running (grok default 1;
  `AGENT_COLLAB_MAX_CONCURRENT_<HARNESS>` overrides); waiting jobs show
  `status: queued` / `awaiting-slot` in run.log instead of dying opaquely.
  Dead-holder slots self-reclaim by pid. Grok's default of 1 is conservative —
  a 2026-07-29 experiment showed three same-home headless runs can overlap
  cleanly (sessions are per-cwd; `active_sessions` is a list, not a mutex);
  raise via env when auth is solid (2–3 is fine).
- **`GROK_HOME` joins the instance env allowlist**: a second authenticated grok
  home (one-time `GROK_HOME=~/.grok-worker grok login`, then a config.json
  instance) lifts the cap per-instance since slots are keyed by harness+instance.

## 0.10.1 - 2026-07-29

Driver-observability fixes from the 2026-07-29 prspctv parallel-batch retro
(18-finding ledger: prspctv docs/reports/2026-07/2026-07-29-parallel-regime-retro.md):

- **Early-DOA detection**: `launchBackground` polls the detached child once
  (~750ms); instantly-dead child + empty `run.log` now returns/records
  `status: failed, failureKind: spawn-died` instead of a forever-"running"
  job nobody hears from again (observed silent dispatch loss).
- **Start banner**: `run-job` writes a first-line banner to `run.log`, making
  "empty run.log after launch" a reliable death signature.
- **Queued-behind visibility**: launching while another background job of the
  same harness is active returns `queuedBehind: [ids]` + a note — grok's
  runtime serializes internally and a queued job was indistinguishable from a
  dead one.
- **Worker subtree tagging**: workers run with `AGENT_COLLAB_JOB_ID` /
  `AGENT_COLLAB_WORKER_HARNESS` in env so machine hygiene can positively
  identify companion-owned processes (name-based cleanup killed interactive
  sessions that looked identical in `ps`).
- **Truncated-report evidence**: an `⚠️ INCOMPLETE RUN` report now appends the
  runtime worktree's last commits + dirty files, so driver post-flight starts
  from facts instead of branch archaeology.

## 0.10.0 - 2026-07-28

- **Role-sized timeouts.** `defaultTimeoutMs(role)` now returns 20 min for `reviewer` (unchanged) and **4 h for `worker`**. The old single 20-min default was calibrated for a one-shot review — "a deep reasoner prints its JSON only at the END" — and was silently applied to implementers executing whole plans. Observed 2026-07-28: a write-worker was hard-killed at exactly 20 min (`exit 124`) partway through task 2 of 7, while healthy and committing correct work. `--timeout <s>` / `AGENT_COLLAB_TIMEOUT` still override both roles.
- **The free-tier model clamp (`MODEL_TIMEOUTS`, 3–5 min) is now reviewer-only.** It would otherwise clamp a `--worker` on a `*-free` model from 4 h to 5 min and guarantee a mid-task kill. The "fast or throttled" bet holds for a single review; for a worker it is both wrong and redundant, since a throttled implementer is caught sooner and more precisely by the idle guard.
- **New doctrine: the hard timeout is a backstop, not a schedule.** Three layers protect a run — driver supervision, the idle guard (no progress → `frozen`), then the hard timeout. Layer 3 should never fire on legitimate work; if it does, the task wanted splitting.
- **New `companion-runtime` section: "Supervising a running job."** The docs covered learning that a background job *finished* but nothing about watching one *run*. Adds outcome-signal supervision (commits, status, progress heartbeat) plus two field-observed traps: never test liveness by matching the worker CLI's name (`pgrep -f "grok --single"` matches *other drivers'* jobs, so a dead job reads as alive), and watch the worktree the worker actually writes to (a worker may use a driver-supplied worktree, leaving the runtime recording `patch: empty, commits: none` while real work sits on the branch).
- **`harness-prompting`: two clauses for long write-worker briefs** — "commit early and often" (a commit is the only artifact that reliably survives a kill) and "tell the worker what slow looks like on this machine" (so a worker queued behind a shared build lock doesn't conclude it is stuck and improvise).
- Diagnostics: a job's headline `status` can read `breach` while the real cause was the hard timeout (`exit 124` in `logs/*.stderr.log`), and `breach` can be tripped by a *different* concurrent agent writing into the shared checkout.

## 0.9.1 - 2026-07-25

- Grok worker fixes: keep only the final streaming segment as the answer; flag non-`end_turn` runs as incomplete; run implementers with `--permission-mode bypassPermissions` so headless shell/build/test tool calls are not cancelled on turn 1.
- Docs: how a driver learns a background job finished; drop stale acceptEdits note on the Grok adapter.

## 0.9.0 - 2026-07-25

- **Instance aliases** for multi-account / multi-binary harnesses: `~/.agent-collaboration/config.json` defines named identities (`codex-business` → `CODEX_HOME=~/.codex-business`, `claude-local` → alternate bin) and optional `defaults.codex` redirects. Jobs store `worker` (label) + `harness`; sandbox allows instance home dirs; missing defaults fail loud; fallback dedupes by harness family.

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
