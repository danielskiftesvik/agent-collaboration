---
name: companion-runtime
description: Internal contract for invoking the agent-collaboration companion runtime (agent-companion.mjs). Use when a driver or subagent needs to construct companion CLI calls.
user-invocable: false
---

# Companion Runtime

The single shared runtime is `${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs`.
There is one runtime, not one per harness — per-harness CLI construction lives in
`adapters/<harness>.mjs` (`buildCommand`), not here. This contract is the faithful
generalization of codex-plugin-cc's `codex-cli-runtime` skill.

## Subcommands

```
setup [--json] [--gate on|off] [--sandbox on|off] [--retention-days <n>]
doctor [--live] [--workers a,b] [--json]
peers self --harness <h> [--name <name>] [--session-id <id>] [--pid <n>] [--json]
peers heartbeat --name <name> [--pid <n>] [--turn-state idle|busy] [--json]
peers register --name <name> [--harness <h>] [--reply-address <addr>] [--session-id <id>] [--pid <n>] [--reach local|cross-machine] [--json]
peers unregister --name <name> [--json]
peers list [--json]
peers send --to <name> --from <name> <text>
peers inbox --name <name> [--ack] [--json]
peers deliver --name <name> [--limit n] [--json]
peers serve [--listen 127.0.0.1:port]
delegate --worker <agy|codex|claude|cursor|grok|opencode|instance-alias> [--driver <name>] [--role worker|reviewer] [--profile <name>] [--background] [--apply] [--timeout <s>] [--no-fallback] <brief>
review  --worker <name> | --workers a,b [--focus <text>] [--profile <name>] [--background] [--no-fallback] [--json] <diff/context>
adversarial-review --worker <name> | --workers a,b [--surface head|working-tree|diff] [--focus <text>] [--profile <name>] [--background] [--no-fallback] [--json] <diff/context>
review-followup --job <prior-id> [--worker <name>] [--surface head|working-tree|diff] <focused diff/context>
status [jobId|--latest] [--worker <name>] [--role <role>] [--refresh|--wait] [--timeout <s>] [--active] [--recent <n>] [--json]
result <jobId|--latest> [--worker <name>] [--role <role>] [--refresh] [--json]
apply  <jobId>
gc [--dry-run] [--artifacts-older-than <days>] [--include-unapplied] [--json]
cancel <jobId> [--force]
```
(`run-job --job <id>` exists but is INTERNAL — it's the detached worker entrypoint
spawned by `--background`; don't call it directly.)

## Peer plane vs job plane

`peers *` is a **separate plane** from `delegate` / `review` / `apply`. Peer
messages are named plain-text pings (Claude-class list/send/inbox). They are
**not** founder consent, not a merge gate, and not worktree jobs.

- Claude↔Claude that already fits native `ListAgents` / `SendMessage` /
  `/list-agents` / `@` should keep using those.
- Otherwise use `peers list` / `peers send`.
- **Same-machine**: mailbox under `AGENT_COLLAB_PEERS_DIR` or
  `<resolveDataRoot()>/peers` (plugin analog of Claude’s UDS inbox). Two
  sessions on this machine share it. `peers self --harness <you>` registers
  this process (pid + lastSeen); dead pids list as stale.
- **`send` never wakes.** `peers deliver --name` is the consumer
  (`core/peer-deliver.mjs`). Cursor idle wake lives in
  `core/peer-inject-cursor.mjs` (not dispatch, not `adapters/contract.mjs`).
  Receiver must publish `peers heartbeat --name <n> --turn-state idle` and a
  Cursor `--session-id`. Wake uses `--mode ask --trust` and a plugin-owned
  ACK-first prompt (`PEER_ACK <id>`); raw peer text never goes on argv.
  `--trust` is not consent. Claude → `native_required`. Other harnesses →
  `inject-stub`.
- Sandboxed Codex often cannot write `$HOME/.../peers/.lock` and cannot
  reach host `127.0.0.1`. The Codex adapter sets `AGENT_COLLAB_PEERS_DIR`
  and `addDirs` to the shared mailbox. Today's `codex-companion` cannot
  take `--add-dir` (it would pollute the prompt). Until that exists, point
  `AGENT_COLLAB_PEERS_DIR` at a workspace-writable path or run `peers`
  unsandboxed.
- **Cross-machine**: file-path `send` **fails closed** (no write). HTTP
  `peers serve` may enqueue when `allowCrossMachine` is set on that daemon
  path. Bind is loopback unless `AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on`
  and the listen host is Tailscale CGNAT `100.64.0.0/10`. Register / list /
  health are unauthenticated — this is **not** a pair table. Reverse
  mini→MacBook is still a smoke. Do not require Anthropic Remote Control
  for non-Claude peers.
- `delegate` must not be used as a chat bus.

`--driver` is irrelevant to `peers` (not a job). Always pass `--driver` on
job-plane commands.

## Routing (decide before spawning)

- `delegate` returns `{"mode":"native", instruction}` when `driver === worker`
  **and the driver is authoritatively known**. In that case do NOT use the
  companion — follow the instruction (use the harness's native subagent; for
  Claude Code that's the `Agent` tool).
- Otherwise it runs the cross-harness path (worktree → spawn → collect).

### Who is the driver? (avoid the native no-op footgun)

The driver is resolved in this order — only the first two are **authoritative**
and may trigger the native path:

1. `--driver <name>` flag (authoritative)
2. `AGENT_COLLAB_DRIVER` env (authoritative)
3. env auto-detection (label only)
4. `claude` fallback (label only)

Native short-circuiting requires an *authoritative* driver on purpose: when you
drive from **Codex or agy over the raw shell** and forget `--driver`, the driver
would otherwise default to `claude`, so `--worker claude` would look like
`driver === worker` and return a "use your own subagent" no-op **instead of
actually delegating**. So a guessed driver always takes the cross-harness path.

Auto-detection status (verified from live sessions) — cloud harnesses
auto-detect, so `--driver`/`AGENT_COLLAB_DRIVER` is only an override:
- **Codex** — `CODEX_THREAD_ID` (every session) / `CODEX_MANAGED_*`.
- **agy** — `ANTIGRAVITY_AGENT` / `ANTIGRAVITY_CONVERSATION_ID` / `ANTIGRAVITY_PROJECT_ID`.
- **Grok Build** — `GROK_SESSION_ID` / `GROK_PLUGIN_ROOT` / `GROK_PLUGIN_DATA`
  (`GROK_HOME` is install-time only and is **not** treated as a runtime signal).
- **Cursor** — `CURSOR_AGENT` / `CURSOR_CONVERSATION_ID` (IDE agent sessions;
  `CURSOR_SANDBOX` alone is **not** a driver signal).
- **OpenCode** — `OPENCODE_SESSION` / `OPENCODE_SERVER`.
- **Claude Code** — `CLAUDECODE` / `CLAUDE_PLUGIN_ROOT` (its slash commands also pass
  `--driver claude`). Checked after Cursor so an inherited Claude env inside
  Cursor does not win; actively-running Codex/agy/grok still beat Claude.

## Roles & kinds

- `delegate` default role = `worker`; `review`/`adversarial-review` = `reviewer`.
- `review`/`adversarial-review` build the prompt from `prompts/<kind>.md`
  (template path). `delegate` sends the caller's brief + the harness output
  contract (free-form path — compose with the `harness-prompting` skill).

## --json result fields

`{ jobId, worker, status, resultValid, changed, patchApplies, attempts, artifact,
artifactDir, patchPath, breach, escapedPaths, breachWarning, report, logs,
reviewContext, errors }`. `status` is one of
`completed | no-changes | conflicted | breach | blocked | failed`. A worker is
`completed` on a clean non-empty patch even if `resultValid` is false (the patch
is the deliverable); a valid self-report with **no** patch is `no-changes`, never
`completed`. `breach: true` (+ `escapedPaths`) means the worker wrote into the
driver's real checkout — surface it, don't apply. `breachWarning` means only exempt
paths changed, or ambiguous concurrent-edit downgrade was explicitly enabled and the
clean captured artifact was preserved. `patchApplies` is null
for reviewers (no patch). A reviewer can be `completed` with `resultValid:false`
and `report:true`: read the prose report in `reports/<worker>.md`. Apply a worker
patch only via `apply` / `--apply`, after inspection. `worker` is the harness that
actually ran (may differ from the one you asked for — see auto-fallback).
`logs` points at durable stdout/stderr/attempt metadata under `artifactDir/logs/`.
For review jobs, `reviewContext` records `baseRef`, dirty real-checkout paths at
launch, and whether the supplied diff was staged into the reviewer worktree.

On a **failed** run, two more fields explain why: `failureKind`
(`rate-limit` | `auth` | `timeout` | `frozen` | `stalled` | `empty-output` | `other`) and `resetAt`
(best-effort reset hint for a limit). See the `result-handling` skill for how to
present these.

## Auto-fallback on transient failures

`delegate`/`review`/`adversarial-review` auto-fall-back to the next worker-ready
harness when the chosen worker hits a **transient** failure. Default policy:
`rate-limit` + `timeout` + `frozen` + `empty-output` (another worker can do it now);
**`auth` is surfaced**, not routed around (it's a config fix); `other` and `stalled`
never trigger it. Tune with
`AGENT_COLLAB_FALLBACK`: `off` (none), `on` (rate-limit+auth+timeout+frozen+empty-output), or a
comma-list of kinds; `--no-fallback` forces a single worker. The result carries
`note`, `fellBackFrom[]` (`{worker, failureKind, resetAt}`), and — if every worker
failed eligibly — `allWorkersLimited: true`. Fallback only ever moves to another
**worker** harness; it never silently makes the driver do the task.

## Sync vs background

By default `delegate`/`review`/`adversarial-review` run **synchronously** (block until
done, with auto-fallback). With **`--background`** the runtime spawns a **detached**
worker and returns `{jobId, status:"running", background:true}` immediately — the run
survives a driver crash. Then:
- `status <jobId>` — poll once and return a lock-free `health` projection (`live`,
  idle/hard budget state, latest progress, `stalled`). `status <jobId> --wait
  [--timeout <s>]` blocks until the job reaches a terminal status (or the process
  dies → `failureKind:"stalled"`). Retain and use the exact job id from launch.
- `status --active` — show only non-terminal jobs; `status --recent <n>` — limit list output.
- `result <jobId>` — the report + structured output once terminal. Before then it
  returns `ready:false`, the live health projection, and the exact wait command.
- `cancel <jobId>` — refuses a healthy, within-budget job. `cancel <jobId> --force`
  is the explicit override that kills the detached worker's whole process group. After a
  bounded exit wait it removes that job's managed worktree; if the process is still live,
  cleanup is deferred rather than risking a live workspace.

Plain `status` and `result` calls are read-only and do not acquire the state write
lock. The `health` projection reads the live progress marker without mutating state;
use `status --refresh` only to persist/reap objective liveness changes, or
`status --wait` to block. Keep the exact job id whenever launch returned one.
`--latest` is only for lost-launch recovery when that id is unavailable: recover by
creation time with `status --latest --role reviewer [--worker claude]`, capture the
recovered id, then use `result <exact-job-id>`. Check the recovered artifacts before
launching a retry.

Background runs a **single worker** (no auto-fallback — that's the synchronous path).
This is the brokerless version of the reference's async model (no app-server broker).

### Learning that a background job finished

`--background` returns immediately and then **tells you nothing**. There is no callback:
the runtime writes state to disk and the job sits terminal until someone calls `status`.
A driver that dispatches and moves on will not notice completion — observed 2026-07-25:
two jobs sat finished for several minutes while the driver reported them "in flight", and
only a user question surfaced it.

If your harness has its own background-task mechanism that notifies on process exit
(Claude Code's `run_in_background`, and most agentic harnesses), use it — turn the poll
into a push. Two shapes:

**A. Detached job + tracked watcher** (durable; the job survives a driver crash):
```
node "$COMPANION" delegate --worker <w> --background <brief>     # returns {jobId}
# then, as a HARNESS-tracked background task:
node "$COMPANION" status <jobId> --wait --timeout <s>
```
The watcher exits when the job reaches a terminal status, and the harness notifies you.

**B. Synchronous call inside a harness background task** (simpler; one step):
run `delegate` **without** `--background` as a harness background task. It blocks, the
harness notifies on exit, and you keep the synchronous path's auto-fallback. The trade-off
is that killing the harness task can take the run with it — you lose the crash
survivability that makes `--background` detached in the first place.

Prefer **A** for long or expensive runs and anything you'd hate to lose; **B** for short
runs where auto-fallback matters more than durability. What you must not do is dispatch
with `--background` and then rely on remembering to poll.

Harnesses with no background-task notification have to poll — call `status <jobId> --wait`
directly and accept that the driver blocks.

### Supervising a running job

Knowing a job *finished* is not enough. **The driver is the primary failure detector; the
timeouts are a backstop.** For any long write-worker run, watch it while it runs and
intervene early — a problem caught at minute 5 costs 5 minutes, the same problem caught by
the hard timeout costs the whole budget.

Watch **outcome signals**, not process liveness:

| Signal | How | Why it beats the alternative |
|---|---|---|
| **Commits** | `git -C <worktree> log --oneline <base>..HEAD` | The only artifact that survives a kill. Real progress. |
| **Job status** | `status <jobId> --json` → `.status` | Authoritative; `breach`/`failed` are terminal. |
| **Progress heartbeat** | `artifactDir/logs/progress.json` `.at` | Frozen `.at` + alive process = wedged, *before* the idle guard fires. |
| **Job's own pids** | `pgrep -f "run-job --job <jobId>"` | See below — this one is a trap. |

**Trap: never test liveness by matching the worker CLI's name.** `pgrep -f "grok --single"`
matches *any* concurrent job on the machine, including other drivers' — so a dead job reads
as alive. Match the **job id** (`run-job --job <jobId>`), which is unique to your dispatch.
Observed 2026-07-28: a driver reported a worker healthy for several minutes after it died,
because its liveness check was matching a different session's worker.

**Trap: watch the worktree the worker actually writes to.** If you pre-create a worktree and
name it in the brief, the worker may use it instead of the runtime's isolated one — in which
case the runtime records `patch: empty, commits: none` while real work sits on your branch.
Confirm which tree is being written before concluding nothing happened.

**Design the watcher to be quiet.** Key the change-detection on outcome fields only (status,
commit count, HEAD). Including a timestamp that ticks every poll turns every poll into a
notification and buries the real event.

**Instruct write-workers to commit early and often** (see `harness-prompting`). A hard kill
leaves uncommitted work at the mercy of whichever tree it landed in; a commit is
unambiguous, inspectable, and survives.

## Disk lifecycle and garbage collection

Every cross-harness launch runs a best-effort, liveness-aware janitor. It removes managed
worktrees for terminal jobs and for nonterminal jobs whose recorded process is objectively
dead. It never removes a live active job. A terminal worktree whose old PID still appears
alive is preserved for a one-hour grace, then converges so PID reuse cannot pin debris
forever. Fresh worktrees missing from valid state get a 24-hour grace so a launch/state-write
race cannot be reaped; old unknown worktrees are treated as crash debris. Missing, corrupt,
or structurally invalid state disables destructive worktree and artifact collection rather
than treating every live job as unknown. Explicit `status --refresh` and `cancel` also clean
the exact dead job worktree.
Dead nonterminal records whose worktree is already missing are also marked failed, so they
enter the bounded terminal history instead of accumulating as misleading active jobs.

Task artifacts default to a 30-day retention window. Collection enumerates `tasks/` on disk,
not only the capped job history, and preserves active jobs, recent artifacts, and non-empty
unapplied patches. Configure the standing window with `setup --retention-days <n>` or
`AGENT_COLLAB_ARTIFACT_RETENTION_DAYS=<n>` (`0` disables expiry). Use `gc --dry-run` to
preview. `gc --include-unapplied` is intentionally explicit and destructive: it allows old
unapplied patch artifacts to expire too. Launch-time collection recursively inspects at most
100 old artifact trees per invocation; explicit `gc` performs the complete pass.

## Freeze detection (idle watchdog)

Every worker runs under an inactivity guard. **Progress** = stdout/stderr OR file
activity under the worktree, agy's log dir, or codex's `~/.codex/log` /
`~/.codex/sessions` dirs — because workers often log/write files instead of
streaming to the pipe (claude runs in streaming mode to provide a heartbeat;
opencode streams NDJSON progress). Only
NO-progress for `AGENT_COLLAB_IDLE_TIMEOUT` (default 600s; `0` disables) trips it
→ killed, surfaced as `failureKind: "frozen"`, and fallback-eligible. Codex and
qwen also have wider profile idle budgets for quiet long-running work. Separate
from the hard timeout below.
For post-mortems, every attempt writes raw stdout/stderr and redacted command
metadata to `artifactDir/logs/`; `status <jobId>` points at those logs.
Claude's NDJSON can update the progress marker while the outer CLI remains quiet
because the synchronous process wrapper buffers output. This is expected and is why
`status.health`, rather than visible terminal text, is the liveness authority.

## Timeouts — a backstop, not a schedule

**The hard timeout is the last line of defence, not the thing that detects problems.**
Three layers protect a run, in order of specificity:

| # | Layer | Catches | Latency |
|---|---|---|---|
| 1 | **Driver supervision** (§ Supervising a running job) | everything real — wrong turn, wedge, gate hit | seconds–minutes |
| 2 | **Idle guard** — no progress for `AGENT_COLLAB_IDLE_TIMEOUT` (10 min) | frozen / throttled worker | ~10 min |
| 3 | **Hard timeout** | a job that IS progressing but will not end | the budget |

Set layer 3 so it **never fires on legitimate work**. If it fires, you almost always
mis-sized it — or the task was too big for one dispatch.

### Role-sized defaults

- **`reviewer` — 20 min.** A deep reasoner on a large diff runs 10+ min and prints its JSON
  only at the END, so a short budget SIGTERMs it mid-run and you get an empty, unparseable
  result. 20 min is calibrated for that shape.
- **`worker` — 4 h.** An implementer executes a whole plan: many edit/build/test cycles.

Override either with `--timeout <s>` or `AGENT_COLLAB_TIMEOUT=<s>`.

### Sizing a write-worker: count cycles, not thinking

The dominant cost for an implementer is usually **not** model latency. Count the build/test
cycles the task needs and multiply by what a cycle costs *on that machine, including
queueing*. Where builds serialize through a shared lock (`flock`), one build can wait 10+
min for a slot and total wall-clock is set by **contention with other agents**, not by the
worker. A plan needing a dozen cycles cannot finish in 20 minutes however fast the model is.

Observed 2026-07-28: a worker was hard-killed at exactly 20 min (`exit 124`,
`[idle-guard] hard timeout after 1200s`) partway through task 2 of 7 — healthy, correct, and
committing work the whole time. The old default was a *reviewer* budget applied to an
implementer.

**If a worker needs more than the default, split the task** rather than raising the ceiling.
A 4-hour implementer is a plan that should have been two dispatches.

### The free-tier clamp is reviewer-only

`MODEL_TIMEOUTS` caps known free/rate-limited models to 3–5 min — they either answer quickly
or are throttled. That bet holds for a one-shot **review**. It is deliberately **not** applied
to workers: an implementer legitimately runs for hours, so the clamp would guarantee a
mid-task kill, and a genuinely throttled worker is caught sooner and more precisely by the
idle guard.

### On timeout

A timeout is **not** retried in place (re-sending the same slow prompt just times out again)
— it surfaces as `failureKind: "timeout"` and auto-falls-back to a faster worker.

**Diagnosing a killed run:** the headline `status` can read `breach` while the actual cause
was the hard timeout. Check `logs/*.stderr.log` for `[idle-guard] hard timeout` and exit code
`124` **before** believing a containment story. Note also that `breach` can be tripped by a
*different* concurrent agent writing into the shared checkout — that is not evidence this
worker misbehaved.

## Repair by resume (codex)

When a worker's first reply isn't valid (non-timeout), the repair attempt
**continues the worker's existing thread** rather than re-running the task cold —
for codex that's `task --resume-last` with a short "emit clean JSON" ask, so the
loaded diff/context isn't paid for twice. If the thread can't be resumed it
automatically falls back to a fresh full re-send (so resume can never regress).
Disable with `AGENT_COLLAB_CODEX_RESUME=off`.

## Review-output normalization

Reviewer JSON is normalized before validation so a complete report isn't
false-failed over cosmetics: `severity`/`verdict` are lowercased/trimmed (codex
often emits `"High"`), common severity/verdict synonyms are mapped, unknown
top-level keys are stripped, and `next_steps` is optional. If JSON is still invalid
but prose exists, the review completes with `resultValid:false` and `report:true`:
read `tasks/<jobId>/reports/<worker>.md`.

## Env

- `AGENT_COLLAB_PEERS_DIR` — mailbox root (default `<resolveDataRoot()>/peers`).
- `AGENT_COLLAB_PEERS_URL` — if set, companion peers verbs use this HTTP
  broker instead of files. No auto-probe of 127.0.0.1.
- `AGENT_COLLAB_PEERS_TOKEN` — bearer for HTTP send/inbox/heartbeat.
- `AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on` — allow `peers serve` on a
  Tailscale `100.x` address. Still refuses `0.0.0.0` / `::`.
- `AGENT_COLLAB_DATA` — out-of-repo state root (default: tmp/plugin-data).
- `AGENT_COLLAB_DRIVER` — default driver harness.
- `AGENT_COLLAB_SANDBOX` — OS-sandbox: `on` (all non-codex) | `off`. Default: opt-in
  for non-codex workers; **never codex** (it self-sandboxes). If it can't be applied,
  the run degrades to unsandboxed (`sandboxed:false` + a note) — breach detection still active.
  OpenCode delegates write safety to worktree isolation + breach detection.
- `AGENT_COLLAB_SANDBOX_STRICT=on` — tighten the macOS profile to **deny file-write by
  default** (confine writes to the work area + temp + harness state; blocks /tmp, other
  volumes, real repos). Default profile only blocks `$HOME`. Linux bwrap is already strict.
  Validate against your worker with `doctor --live` before relying on it.
- `AGENT_COLLAB_FALLBACK` — fallback policy: `off` | `on` (rate-limit+auth+timeout+frozen+empty-output) | comma-list. Default: `rate-limit,timeout,frozen,empty-output` (auth surfaces).
- `AGENT_COLLAB_TIMEOUT=<s>` — per-attempt worker HARD timeout in seconds (default 1200 = 20 min).
- `AGENT_COLLAB_IDLE_TIMEOUT=<s>` — inactivity timeout in seconds (default 600; 0 = off): no progress (output OR file activity) for this long → killed as `frozen`.
- `AGENT_COLLAB_ARTIFACT_RETENTION_DAYS=<n>` — artifact retention in days (default 30; 0 disables); active jobs and unapplied patches stay protected by default.
- `AGENT_COLLAB_BREACH_EXEMPT_PATHS=a,b` — comma-separated real-checkout paths that should be warnings, not hard breaches (for intentional reports/scratch output).
- `AGENT_COLLAB_BREACH_WARN_CONCURRENT=on` — opt in to downgrading ambiguous concurrent real-checkout edits to warnings. Off by default because they are indistinguishable from a worker escape.
- `AGENT_COLLAB_CODEX_RESUME=off` — repair with a fresh re-send instead of resuming the codex thread (resume is on by default).
- `AGENT_COLLAB_CODEX_HOME` — forward into the spawned codex worker's `CODEX_HOME` (e.g. `~/.codex-business`). Ambient `CODEX_HOME` is also forwarded.
- `AGENT_COLLAB_ALLOW_INPLACE=on` — allow an UNISOLATED in-place run when a worktree can't be created (off by default → such a job is `blocked`, never run in the real cwd).
- `AGENT_COLLAB_<AGY|CLAUDE|CODEX|CURSOR|GROK|OPENCODE>_BIN` — override a harness binary.
- `AGENT_COLLAB_CURSOR_MODEL` / `_MODEL_REVIEW` — Cursor model pin (default `composer-2.5`). Prefer `~/.cursor/bin/agent`; never bare `agent` (may be Grok).
- `CURSOR_API_KEY` — auth for unattended Cursor Agent CLI runs (or `~/.cursor/bin/agent login`).
- `AGENT_COLLAB_GROK_MODEL` / `_MODEL_REVIEW` — Grok Build model pin (default `grok-4.5`).
- `AGENT_COLLAB_GROK_EFFORT` / `_EFFORT_REVIEW` — Grok Build reasoning effort (`--effort`).
- `AGENT_COLLAB_AGY_MODEL[_PRO|_FLASH]` — explicit agy model id (default: unset).

## Instance aliases (multi-account / multi-binary)

`~/.agent-collaboration/config.json` (or `AGENT_COLLAB_INSTANCE_CONFIG`):

```json
{
  "instances": {
    "codex-business": { "harness": "codex", "env": { "CODEX_HOME": "~/.codex-business" } },
    "claude-local": { "harness": "claude", "bin": "/path/to/claude-local" }
  },
  "defaults": { "codex": "codex-business" }
}
```

`--worker codex-business` (or bare `codex` when defaulted) runs the same adapter with
that env/bin overlay. Job records expose `worker` (label) + `harness`. Native short-circuit
only when driver harness matches and the worker has **no** instance overlay.

## Repo-level model pins (`.agent-collab.json`)

A tracked file at the repo root pins standing models per worker+role, readable by EVERY
driver harness (claude/codex/agy/grok/opencode shells) — unlike env vars, it can't drift
with interactive sessions (the codex TUI rewrites `~/.codex/config.toml` with the
last-used model) and it version-controls the pinned reviewer instrument with the repo:

```json
{
  "workers": {
    "codex":  { "reviewer": { "model": "gpt-5.6-terra", "effort": "high" } },
    "claude": { "worker":   { "model": "sonnet" } },
    "grok":   { "reviewer": { "model": "grok-4.5" } },
    "opencode": { "reviewer": { "model": "anthropic/claude-sonnet-4-20250514" } }
  }
}
```

Precedence per dispatch: **env vars win** (the per-dispatch escalation lever — e.g.
`AGENT_COLLAB_CODEX_MODEL=gpt-5.6-sol` for one boundary review), then the file's role pin,
then the adapter default / harness base config. Roles: `reviewer` | `worker`. A malformed
file logs a warning and behaves as unpinned (never silently changes the instrument).

**Profiles** (`pins.profiles.<name>.<worker>`) are named escalation rungs selected per dispatch
with `--profile <name>` (precedence: env > profile > standing pin > harness default; a missing
profile warns and falls back — never silently). **Dual review**: `--workers a,b` on
review/adversarial-review runs each reviewer sequentially without per-leg fallback and returns
`{dual, legs[], merged}` — merged findings carry `workers[]` + `agreement`, severity mismatches
are flagged, verdict is worst-of. Read failed legs from `merged.failedLegs`; the surviving leg's
report is still valid on its own.
- `AGENT_COLLAB_CODEX_MODEL` / `AGENT_COLLAB_CODEX_EFFORT` — per-dispatch codex model/effort (passed as `--model`/`--effort` to codex-companion). Role-scoped defaults: `AGENT_COLLAB_CODEX_MODEL_REVIEW` / `AGENT_COLLAB_CODEX_EFFORT_REVIEW` apply to reviewers only; the generic var wins when both are set. Unset = no flags, the user's `~/.codex/config.toml` governs (prior behavior). Not re-pinned on thread-resume repair.

## Driving from a sandboxed harness

A cross-harness delegation **spawns another agent that makes a network call** (to the
worker's model API) and creates a git worktree. If the driver harness sandboxes shell
commands by default (e.g. **Codex**), the first run comes back empty ("no worker JSON")
because the sandbox blocks the spawn/network. Run the companion with **escalated /
network-enabled permissions** (Codex will offer to escalate; or pre-approve
`node …/agent-companion.mjs` in the harness config). Harnesses that already run
unattended (e.g. `agy --dangerously-skip-permissions`) don't need this. This is
expected: a sandbox *should* gate "spawn a process that calls the internet."

### Cursor worker shows `interactive-only`
`setup` marks cursor `⚠ interactive-only` when the Agent CLI is present but not
usable unattended. Usual causes:

1. **Not logged in** — run `~/.cursor/bin/agent login` once, or set `CURSOR_API_KEY`.
   Do **not** use bare `agent` (often Grok Build on machines that have both).
2. **Wrong binary path** — prefer `~/.cursor/bin/agent` or `AGENT_COLLAB_CURSOR_BIN`;
   brew installs as `cursor-agent` (`ln -sfn "$(command -v cursor-agent)" ~/.cursor/bin/agent`).
3. **Driver sandbox** — Codex (default shell sandbox) can hide host login state so
   `agent status` fails inside the sandbox. Re-run `setup` / `delegate --worker cursor`
   with escalated/network permissions, or inject `CURSOR_API_KEY` into the spawn env.

Until setup prints `cursor ✓ worker-ready`, `delegate --worker cursor` will refuse.

### Codex driver: third-party data-egress can be refused
Separately from the shell sandbox, Codex has a **data-egress / approval** policy that can
refuse to send your **private repo content to a third-party model** — observed: `codex` →
`agy` (Google/Gemini) blocked as an exfiltration risk **even after interactive approval** in
a non-interactive (`-p`) spawn, while `codex` → `claude` runs fine. This is a Codex-side
control; the runtime can't (and shouldn't) override it. Legitimate options:
1. Authorize it in **Codex's own config** (allowlist `node …/agent-companion.mjs`, or enable
   egress for trusted commands) — survives non-interactive spawns.
2. Run the companion **yourself in the shell** (you authorize the export) with
   `AGENT_COLLAB_DRIVER=codex`.
3. Practical default: from a codex driver, use **claude** as the worker/reviewer (it runs);
   reserve agy for when you've authorized Gemini egress; use codex primarily as a
   reviewer/analyst when another harness is driving.
Do **not** obfuscate the payload to slip past the check — it exists to gate third-party export.

## status vs result vs apply

- `status <jobId|--latest>` → the **runtime's job metadata** (status, breach,
  escapedPaths, attempts, failureKind, note, pid…) plus a read-only `health`
  projection for active jobs. `--latest` selects by `createdAt`, optionally filtered
  by `--worker`/`--role`, and is recovery-only; `--refresh` persists objective
  liveness changes and `--wait` blocks until terminal.
- `result <jobId|--latest>` → the **worker's deliverable**: its report (`reports/<worker>.md`)
  + structured self-report (`outputs/<worker>.json`). Self-report can disagree with
  the runtime (e.g. worker claims `changed:true` but the runtime captured nothing →
  `status` says `no-changes` with a `note`). `result --json` returns an envelope
  containing the artifact plus unavoidable job provenance and warnings. Use
  `result --artifact-only --json` only for legacy consumers that require the bare
  structured artifact. A nonterminal result returns `ready:false` and the exact
  wait command instead of a misleading missing-artifact error. Trust the runtime's
  captured state.
- `apply <jobId>` → lands the patch in the **working tree, unstaged** (clean index)
  so you inspect with `git diff` then commit; if you had pre-existing staged work it
  stays **staged**. It never accepts `--latest`; never auto-applies.

## Rules

- One job per invocation. Don't fabricate results if a run fails — surface stderr.
- The driver holds main-branch authority; workers only produce artifacts.
- agy is write-capable through the delegated worker path; if a worker reports changes
  but the runtime captures no patch, trust the runtime's `no-changes` diagnostic.
