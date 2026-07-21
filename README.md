# agent-collaboration

Cross-harness agent collaboration. A driver harness — **Claude Code**, **Codex**,
**Antigravity (`agy`)**, or **opencode** — can delegate a task to a **worker** or
**reviewer** running on another harness, then apply the result to the working tree.
Any of the four can drive; any of the four can do the work. A fifth harness,
**`qwen`** (local, via a local LM Studio server), can also work or review — but only
as an explicit, opt-in choice for sensitive/local-only tasks, never as a driver and
never auto-selected.

This is a generalization of OpenAI's Apache-2.0 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
(see [`NOTICE`](./NOTICE)): its single Claude Code → Codex direction is widened into a
harness-agnostic core plus per-harness adapters, prompt templates, and prompting skills.

## Install

The repo is a self-contained plugin marketplace (it ships `.claude-plugin/`,
`.codex-plugin/`, and `.opencode/plugins/`), so it installs natively per harness.

### Claude Code
```
/plugin marketplace add danielskiftesvik/agent-collaboration
/plugin install agent-collaboration@agent-collaboration-marketplace
```

### Codex
```
codex plugin marketplace add https://github.com/danielskiftesvik/agent-collaboration
codex plugin add agent-collaboration@agent-collaboration-marketplace
```

### Antigravity (`agy`)
```
agy plugin install https://github.com/danielskiftesvik/agent-collaboration
```
Reinstall with the same command to update. (Or `agy plugin import claude` if you've already
installed it in Claude Code.)

### Opencode

```bash
# Global (recommended)
opencode plugin "agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git" -g

# Or project-local
opencode plugin "agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git"
```

Alternatively, add to your `opencode.json` / `opencode.jsonc` (global or project-level):

```json
{
  "plugin": ["agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git"]
}
```

Restart OpenCode. The plugin installs through OpenCode's plugin manager and registers
the slash commands (`/agent-collab:delegate`, `/agent-collab:review`, `/agent-collab:setup`, etc.).

Verify by running `setup`:

```
/agent-collab:setup
```

If an update does not appear after reinstall, clear the package cache and reinstall with `--force`:

```bash
rm -rf ~/.cache/opencode/packages/agent-collaboration*
opencode plugin "agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git" -g --force
```

Full OpenCode guide: [`docs/README.opencode.md`](./docs/README.opencode.md).

> Codex, Antigravity, and opencode plugin support is newer than Claude Code's and the exact marketplace
> resolution can vary by CLI version — if a command above doesn't resolve, check
> `codex plugin --help` / `agy plugin --help`. You can always skip install entirely and
> [drive the runtime over the shell](#driving-from-any-harness).

### After installing — detect your workers
```
/agent-collab:setup                                   # Claude Code
node <plugin-dir>/scripts/agent-companion.mjs setup   # Codex / agy / any shell
```
`setup` reports which worker CLIs are **worker-ready** (installed + able to run unattended).

### Prerequisites
- **Node ≥ 20.**
- The worker CLIs you want to delegate to, on your `PATH`: `codex`, `agy` (Antigravity),
  `claude`, and/or `opencode`.
- For the local `qwen` harness specifically: the `qwen` CLI (Qwen Code) on your `PATH`,
  **and** a local LM Studio server running an OpenAI-compatible endpoint (default
  `http://127.0.0.1:1234/v1`) with a model loaded — `qwen` is the only harness with this
  extra, separately-running-process dependency; the other four are self-contained CLIs.

## What it does

Two delegation paths, chosen automatically:

- **Native (same harness)** — when driver and worker are the same harness, use that
  harness's own subagent primitive (Claude Code `Agent` tool, Antigravity `invoke_subagent`,
  Codex's native subagent, opencode's built-in task capabilities). No worktree, no shell,
  no companion job. The companion returns `{"mode":"native", instruction}` telling the
  driver to do this.
- **Cross-harness** — when driver ≠ worker, the `agent-companion` runtime creates an
  isolated git worktree, writes a brief, spawns the target harness **unattended**, monitors
  it, and collects validated artifacts. The driver — and only the driver — applies the patch.
  Runs **synchronously** by default; pass `--background` to detach the worker, retain its exact
  job id, and use `status <jobId> --wait` then `result <jobId>` (a brokerless take on the
  reference's async model). Quiet terminal output is not a stall; status exposes live health.

## Commands

| Command | Purpose |
|---|---|
| `/agent-collab:setup [--gate on\|off] [--sandbox on\|off] [--retention-days n]` | Detect worker-ready harnesses; configure gates/sandbox and artifact retention (default 30 days; 0 disables) |
| `/agent-collab:doctor [--live] [--workers a,b]` | Self-check: config + readiness, and (with `--live`) a review-cycle + worktree-isolation smoke per worker against a throwaway repo |
| `/agent-collab:recommend --task <type> --driver <self>` (or `--profiles`) | Pick the strongest available worker for a task by underlying-model strength |
| `/agent-collab:delegate --worker <agy\|claude\|codex\|opencode> [--background] [--apply] <brief>` | Run a cross-harness **worker** task (produces a patch); `--background` detaches and returns a jobId |
| `/agent-collab:review --worker <name> [--focus <text>] <diff>` | Read-only cross-harness **review** |
| `/agent-collab:adversarial-review --worker <name> <diff>` | "Try to break it" review |
| `/agent-collab:review-followup --job <prior-id> [--worker <name>] <focused diff/context>` | Recheck a focused fix against a prior review |
| `/agent-collab:status [jobId\|--latest] [--worker name] [--role role] [--refresh\|--wait] [--active] [--recent n]` | List / inspect jobs with lock-free live health; reads mutate state only when explicitly refreshed or waited |
| `/agent-collab:result <jobId\|--latest> [--worker name] [--role role]` | Show a terminal job's report, or `ready:false` plus the exact wait command while it runs |
| `/agent-collab:apply <jobId>` | Apply a worker's patch (3-way) to the working tree |
| `/agent-collab:gc [--dry-run] [--artifacts-older-than days] [--include-unapplied]` | Reclaim dead/terminal worktrees and expired artifacts; unapplied patches are preserved by default |
| `/agent-collab:cancel <jobId> [--force]` | Cancel an unhealthy job; healthy within-budget jobs require the explicit `--force` override |

Review commands accept `--surface head|working-tree|diff`. Unified diffs are detected automatically and clean prose defaults to `head`. Dirty prose fails closed until the caller chooses `working-tree` (safely snapshotted with a temporary Git index) or `head` (dirty paths excluded). `review-followup --job <prior-id> ...` runs a focused verification tied to the earlier review.

## Skills

| Skill | What it governs |
|---|---|
| `agent-collaboration` | Policy: when/how to delegate, the authority model, routing by model strength |
| `harness-prompting` | How to compose a brief; per-harness guides + prompt blocks + the model-strengths matrix |
| `collaborative-investigation` | Two-party confidence gate: hypothesis + an independent second opinion from another harness before hard work |
| `companion-runtime` | Internal contract for invoking the companion CLI |
| `result-handling` | How to present a worker's output — and the "after a review, STOP and ask before fixing" guardrail |

## Strength-based routing

Classify the task; `recommend` maps it to the strongest **available** worker (excluding the
driver) by the underlying model's strengths — codex for hard reasoning/review, claude for
careful SWE/planning, agy (Gemini) for speed + large-context, opencode for multi-provider
flexibility. See
[`skills/harness-prompting/references/model-strengths.md`](./skills/harness-prompting/references/model-strengths.md)
or run `recommend --profiles`. Wire it (and the investigation gate) into your project
autonomously with the templates in [`examples/`](./examples/) (`CLAUDE.md` for a Claude Code
driver, `AGENTS.md` for Codex/agy drivers).

## How it works

- **Authority model:** workers only produce artifacts (a report, a result JSON, a patch);
  **only the driver applies** changes, via `git apply --3way` against a recorded `baseRef`.
- **Isolation, sandbox & breach detection:** cross-harness workers AND reviewers run in an
  ephemeral git worktree; a worker's changes are captured as a patch, a reviewer's are discarded.
  Two safety layers guard against an unattended worker escaping: (1) **preventive** — an
  opt-in OS sandbox can deny writes outside the worktree/artifacts; never applied to codex
  (it self-sandboxes), degrades gracefully if unavailable. (2) **reactive** — the runtime
  snapshots the real tree before/after each run; an escaping write is marked **`breach`**
  with `escapedPaths`, never `completed`. A valid self-report that captured **no** patch is
  `no-changes`, not `completed`.
- **Prompts:** review-grade work uses code-loaded templates (`prompts/adversarial-review.md`,
  `prompts/review.md`) with a `{{OUTPUT_CONTRACT}}` filled per harness; free-form tasks are
  composed by the driver using the `harness-prompting` skill. When the review input is a real
  diff it's **staged into the reviewer's worktree** so it reads the actual post-change files
  (not a stale HEAD baseline); non-diff input falls back to the pasted-text path.
- **Output contracts + validation:** each worker's output is validated against a JSON schema
  (`schemas/`); a worker is `completed` on a clean, applying patch even if its metadata JSON
  is missing (the patch is the deliverable).
- **Stall detection:** jobs carry a heartbeat; a job whose heartbeat is stale **and** whose
  process is gone is treated as stalled. `status.health` also reads the idle-guard's live
  progress marker, so internally streaming work remains visibly healthy even when the outer
  synchronous process wrapper has not printed yet.
- **Diagnostics:** every attempt persists raw stdout/stderr plus redacted command
  metadata in `artifactDir/logs/`. `version --json` reports the runtime path and
  state dir, and `status --active` / `status --recent <n>` keep current jobs visible.
  Keep and use the exact job id from launch. `--latest` is only for lost-launch recovery:
  recover once with `status --latest --role reviewer [--worker claude]`, capture that id,
  then read `result <exact-job-id>`. Do this before retrying a review.
- **Review provenance:** review jobs record `reviewContext` (`baseRef`, dirty paths
  at launch, and whether the supplied diff was staged into the reviewer worktree)
  so you can prove what code the reviewer saw.
- **Freeze detection:** every worker runs under an inactivity watchdog (`idle-guard`). Progress
  = stdout/stderr **or** file activity (worktree, agy's log dir, and codex's `.codex` log/session dirs) — workers often log/write
  files rather than streaming to the pipe (claude is run in streaming mode to provide a
  heartbeat; opencode streams NDJSON progress). Only a worker making NO progress for `AGENT_COLLAB_IDLE_TIMEOUT` (default 10 min)
  is killed as `failureKind: "frozen"` (and falls back), so a real hang surfaces before the
  20-min hard ceiling without false-killing a slow-but-working run.
- **Limit & timeout handling:** a failed run is classified (`failureKind` = `rate-limit` |
  `auth` | `timeout` | `frozen` | `empty-output` | `stalled` | `other` + a best-effort `resetAt`). On a **transient** failure
  (`rate-limit`/`timeout`/`frozen`/`empty-output` by default) the runtime **auto-falls-back to the next worker-ready
  harness** (never the driver), tagging the result with a `note` + `fellBackFrom[]`; **`auth`
  is surfaced** (a config fix), not routed around. Tune via `AGENT_COLLAB_FALLBACK`
  (`off`/`on`/comma-list) or `--no-fallback`. The default per-attempt budget is 20 min so deep
  reviews aren't killed mid-run (the empty "no JSON found" failure); tune with
  `AGENT_COLLAB_TIMEOUT`.
- **Review-output normalization:** reviewer JSON is normalized before validation (severity/verdict
  lowercased/trimmed, synonyms mapped, top-level extras stripped, `next_steps` optional) so a complete report isn't
  false-failed over cosmetics like codex emitting `"High"` or `"Approved"`. If prose exists but JSON
  is still invalid, the review completes with `resultValid:false` and `report:true`.
- **Repair by resume:** a non-timeout repair attempt *continues* the worker's existing thread
  (codex `task --resume-last`) with a short "emit clean JSON" ask instead of re-running cold,
  falling back to a fresh re-send if the thread can't be resumed.
- **State** lives **outside** the repo (keyed by a hash of the workspace root), so it survives
  worktrees and is never committed.
- **Bounded disk use:** every launch runs a liveness-aware janitor. Terminal worktrees and
  dead-process worktrees are removed; a live active job is never reaped. A terminal tree
  whose old PID appears reused converges after a one-hour safety grace, while missing/corrupt
  state disables destructive collection. Dead nonterminal records are reconciled even when
  their worktree is already absent. Artifact retention scans the task directories on
  disk (including records older than the in-memory history), expires them after 30 days by
  default, and preserves active jobs, recent reports, and unapplied patches. Automatic
  launch cleanup recursively inspects at most 100 old artifact trees per invocation.
  Preview the unbounded explicit pass with `gc --dry-run`; change the standing window with
  `setup --retention-days <n>` or `AGENT_COLLAB_ARTIFACT_RETENTION_DAYS`.

## Harnesses

| Harness | Reviewer | Worker | Notes |
|---|---|---|---|
| **codex** | ✓ | ✓ | Deepest review reasoning and hard-debug implementation; prefers XML-block prompts. Slower and often quiet — it has a wider idle budget and `.codex` log/session activity counts as progress |
| **claude** | ✓ | ✓ | Use the native `Agent` tool when Claude Code is also the driver |
| **agy** (Gemini) | ✓ | ✓ | Fast reviewer and implementer (Flash by default; `AGENT_COLLAB_AGY_CLASS=Pro` for depth). The adapter pins model flags before the prompt and harvests patches from agy's internal worktree when needed |
| **opencode** | ✓ | ✓ | Multi-provider harness (Anthropic, OpenAI, Google, DeepSeek, local, etc.). Model configured per dispatch via env var or pin. **Always explicit** — never auto-selected. No per-tool exclusion (`--exclude-tools`); write safety via worktree isolation + breach detection. Has no thread-resume mechanism; retry is always a full re-send |
| **qwen** (local) | ✓ (local-only tasks) | ✓ (plan-execution only) | Local-only, via a local LM Studio server. **Always explicit** — never in `recommend`'s default rotation, never a fallback target, never falls back away from itself on failure. Two routes only: `local-only` (sensitive-data review) and `plan-execution` (implementing a pre-written plan). See [Configuration](#configuration) for the `AGENT_COLLAB_QWEN_*` env vars. Local-only means the *worker run* stays local — compose briefs as file paths, not pasted content, and see the harness-prompting qwen guide for the full privacy boundary |

## Driving from any harness

The companion is one harness-agnostic CLI. From Codex, Antigravity, or OpenCode you delegate by running
it over the shell (this is what the slash commands do under the hood):

```
node /path/to/agent-collaboration/scripts/agent-companion.mjs \
  adversarial-review --worker codex --driver agy --json "<diff/context>"
```

> When driving from a **sandboxed** harness (e.g. Codex), run the companion with
> **escalated / network-enabled** permissions — it spawns a worker that calls an external
> API, which a default sandbox will block.

## Model pins — `.agent-collab.json`

**The problem:** the model your reviews run on shouldn't depend on what you last did in a
terminal. Harness base configs drift — the Codex TUI, for example, writes whatever model you
last picked in a session back to `~/.codex/config.toml`. If dispatches read that file, your
carefully-chosen review model silently follows your interactive habits.

**The fix:** commit a `.agent-collab.json` at your repo root. It pins standing models per
worker and role, and the runtime reads it on every dispatch — no matter which harness is
driving (Claude Code, Codex, Antigravity, or OpenCode shells all get the same pins), no env vars, no
shell-profile exports.

```json
{
  "workers": {
    "codex":  { "reviewer": { "model": "gpt-5.6-terra", "effort": "high" } },
    "agy":    { "reviewer": { "model": "Gemini 3.5 Flash (High)" } },
    "claude": { "worker":   { "model": "sonnet" } },
    "opencode": { "reviewer": { "model": "anthropic/claude-sonnet-4-20250514" } }
  }
}
```

**Precedence** (per dispatch, most-specific wins):

```
env var (this dispatch)  >  .agent-collab.json (standing pin)  >  harness default
AGENT_COLLAB_CODEX_MODEL     tracked in your repo                 e.g. ~/.codex/config.toml
```

- **Env = the escalation lever.** A single hard review can be bumped without touching the
  standing pin: `AGENT_COLLAB_CODEX_MODEL=gpt-5.6-sol node …/agent-companion.mjs review …`
- **File = the instrument.** Because it's version-controlled, changing a review model is a
  visible diff — pair it with whatever re-validation your project requires (recommended:
  re-run a planted-bug calibration before changing a reviewer pin).
- Roles are `reviewer` and `worker`; pin only what you need — anything unpinned falls through
  to the harness's own default.
- A malformed file logs a warning and behaves as unpinned; it never silently changes models.

**Named profiles — declarative escalation.** Add a `"profiles"` section for the escalation
rungs your process ladder needs, then select one per dispatch with `--profile <name>`:

```json
{
  "workers":  { "codex": { "reviewer": { "model": "gpt-5.6-terra", "effort": "high" } } },
  "profiles": { "deep":  { "codex": { "model": "gpt-5.6-sol",  "effort": "xhigh" } } }
}
```

`review --worker codex --profile deep …` runs the deep rung; no `--profile` runs the standing
pin. Precedence: env > profile > standing pin > harness default. A `--profile` that doesn't
exist for the chosen worker WARNS and falls back to the standing pin — escalation never fails
silently.

**Dual review — two families, one report.** `review --workers codex,agy …` (also
`adversarial-review`) fans the same brief out to each reviewer (sequentially, no auto-fallback
per leg — a fallback could collapse the family diversity dual review exists for) and merges the
artifacts: findings both reviewers raised are deduped and tagged `agreement: true` (severity
mismatches flagged, more severe copy wins), single-reviewer findings stay tagged with their
source, and the verdict is worst-of. Cross-model reviewers typically agree on only a minority
of findings — the disagreements are the value, so nothing is dropped.

If a requested review leg fails, the merged result is `incomplete` and carries only a
`provisionalVerdict` from completed legs; it is never presented as final approval.

Optional repo-owned resource guards can live alongside model pins:

```json
{"preflight":{"maxWorktrees":3,"minFreeDiskGb":20}}
```

They are checked before another isolated worktree is created.

## Configuration

| Env var | Effect |
|---|---|
| `AGENT_COLLAB_DATA` | Out-of-repo state root (default: a per-plugin / tmp dir) |
| `AGENT_COLLAB_DRIVER` | Override which harness is driving (`codex`/`agy`/`claude`). Normally auto-detected (Codex `CODEX_THREAD_ID`, agy `ANTIGRAVITY_*`, Claude Code `CLAUDECODE`); set only if detection misses |
| `AGENT_COLLAB_SANDBOX` | OS sandbox: `on` (all non-codex) \| `off`. Default: opt-in for non-codex workers, **never codex** (it self-sandboxes). Degrades to unsandboxed if it can't be applied |
| `AGENT_COLLAB_SANDBOX_STRICT=on` | Tighten the macOS profile to deny file-write by default (confine writes to work area + temp + harness state; blocks /tmp & other volumes). Default profile only blocks `$HOME`; Linux bwrap is already strict |
| `AGENT_COLLAB_FALLBACK` | Auto-fallback policy: `off` \| `on` (rate-limit+auth+timeout+frozen+empty-output) \| comma-list of kinds. Default `rate-limit,timeout,frozen,empty-output` (transient; **auth is surfaced**, not routed around) |
| `AGENT_COLLAB_TIMEOUT` | Per-attempt worker **hard** timeout in **seconds** (default 1200 = 20 min). Deep reasoners on big diffs need a generous budget — too short kills the run mid-flight |
| `AGENT_COLLAB_IDLE_TIMEOUT` | **Inactivity** timeout in **seconds** (default 600 = 10 min; `0` disables). If a worker makes **no progress** — neither stdout/stderr **nor file activity** (worktree, agy's log dir, codex log/session dirs) — for this long it's killed as `frozen`. Generous so a slow-but-working worker isn't false-killed. **codex and qwen have more generous built-in defaults (30 min via `MODEL_PROFILES.<worker>.idleMsOverride`) that take precedence over this env var** |
| `AGENT_COLLAB_ARTIFACT_RETENTION_DAYS` | Override saved artifact retention in days (default 30; `0` disables expiry). Active jobs and unapplied patches remain protected unless `gc --include-unapplied` is explicitly used |
| `AGENT_COLLAB_BREACH_EXEMPT_PATHS` | Comma-separated real-checkout paths that become `breachWarning` instead of hard `breach` (for intentional report/scratch output) |
| `AGENT_COLLAB_BREACH_WARN_CONCURRENT=on` | Opt in to downgrading ambiguous concurrent real-checkout edits to `breachWarning`. Off by default because those edits are indistinguishable from a worker escape |
| `AGENT_COLLAB_CODEX_RESUME=off` | Repair a bad codex reply with a fresh re-send instead of resuming its thread (`task --resume-last`); resume is on by default |
| `AGENT_COLLAB_ALLOW_INPLACE=on` | Permit an **unisolated** in-place run when a git worktree can't be created. Off by default — without it such a job is `blocked` rather than run in your real tree |
| `AGENT_COLLAB_ALLOW_NONWRITER=on` | Force a harness marked reviewer-only to run as a write-worker anyway. Off by default; use only for local experiments because patch capture may be empty |
| `AGENT_COLLAB_AGY_CLASS` | agy model class to pin (`Flash` default, `Pro`, …) |
| `AGENT_COLLAB_AGY_MODEL` | Pin an exact agy model label (overrides the class) |
| `.agent-collab.json` (repo root, tracked) | Standing per-worker+role model/effort pins read by every driver harness; env vars above always win per-dispatch. See skills/companion-runtime |
| `AGENT_COLLAB_CODEX_MODEL` / `_EFFORT` | Per-dispatch codex model/effort override (e.g. escalate one boundary review to `gpt-5.6-sol` while base config stays on a cheaper tier). `_MODEL_REVIEW` / `_EFFORT_REVIEW` variants apply to reviewers only; generic wins. Unset = base `~/.codex/config.toml` governs |
| `AGENT_COLLAB_CLAUDE_MODEL` | Pin the model passed to `claude --model` (default: `default`, Claude Code's account-tier recommendation — never Fable/Haiku) |
| `AGENT_COLLAB_OPENCODE_BIN` | Override the `opencode` binary path |
| `AGENT_COLLAB_OPENCODE_MODEL` | Per-dispatch opencode model override in `provider/model` format (e.g. `anthropic/claude-sonnet-4-20250514`). `_MODEL_REVIEW` variant applies to reviewers only; generic wins |
| `AGENT_COLLAB_OPENCODE_VARIANT` | Per-dispatch reasoning-effort override (e.g. `high`, `max`, `minimal` — passed as `--variant`). `_VARIANT_REVIEW` variant applies to reviewers only; generic wins |
| `AGENT_COLLAB_QWEN_BIN` | Override the `qwen` binary path |
| `AGENT_COLLAB_QWEN_MODEL` | Pin a specific local model via `-m` (default: none — inherits qwen's own configured default in `~/.qwen/settings.json`, since LM Studio serves one model at a time and can't be reliably auto-detected) |
| `AGENT_COLLAB_QWEN_BASE_URL` | Override the local LM Studio endpoint (default `http://127.0.0.1:1234/v1`). Must be loopback (`127.0.0.1`/`localhost`/`::1`) — a non-loopback value is refused unless `AGENT_COLLAB_QWEN_ALLOW_REMOTE=on` |
| `AGENT_COLLAB_QWEN_API_KEY` | Override the local endpoint's API key (default `lm-studio` — LM Studio doesn't validate it, it just needs to be present) |
| `AGENT_COLLAB_QWEN_ALLOW_REMOTE=on` | Explicitly permit a non-loopback `AGENT_COLLAB_QWEN_BASE_URL`. Off by default — qwen's entire purpose is keeping a job off the cloud, so a remote endpoint must be opt-in, never silently accepted |
| `AGENT_COLLAB_<AGY\|CLAUDE\|CODEX\|OPENCODE\|QWEN>_BIN` | Override a harness binary path |

Plus `setup --gate on|off` (opt-in stop-time review gate), `setup --sandbox on|off`, and
`setup --retention-days <n>` (30 by default; 0 disables artifact expiry).

## Versioning

Check which build a harness is actually running:

```
node <plugin-dir>/scripts/agent-companion.mjs version   # -> agent-collaboration v0.2.0
```
The version also heads `setup` output and shows as a `doctor` check.

**Bump the version on every push** — a harness `update` gates on the version field, so an
unchanged version reports "already latest" and your edits never install. Size the bump to
the amount of change (semver):

- **patch** (`0.0.x`) — a bug fix, docs, or a small tweak.
- **minor** (`0.x.0`) — new feature(s), a notable behavior change, or a batch of fixes.
- **major** (`x.0.0`) — a breaking change to the CLI/contract/behavior.

```
npm run bump 0.2.1     # rewrites the version in package.json + all 3 manifests
```
Then commit/push and re-run your harness's update/reload. (A test enforces that all
manifests share one version.)

## Development

```
npm test        # node --test — the full suite
```

Layout: `scripts/agent-companion.mjs` (CLI/dispatch) · `core/` (state, jobs, worktree,
heartbeat, git, prompts, schema, dispatch) · `adapters/` (`claude`/`codex`/`agy`/`opencode`/`qwen`) ·
`prompts/` (review templates) · `schemas/` (artifact contracts) ·
`commands/` `hooks/` `skills/` `.claude-plugin/` `.codex-plugin/` (harness surface).

## Attribution & license

Apache-2.0. Derived from OpenAI's `codex-plugin-cc` (Apache-2.0, © 2026 OpenAI); the prompt
template engine, review template, prompt blocks, and parts of the runtime are adapted from it.
See [`NOTICE`](./NOTICE).
