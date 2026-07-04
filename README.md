# agent-collaboration

Cross-harness agent collaboration. A driver harness — **Claude Code**, **Codex**, or
**Antigravity (`agy`)** — can delegate a task to a **worker** or **reviewer** running on
another harness, then apply the result to the working tree. Any of the three can drive;
any of the three can do the work. A fourth harness, **`qwen`** (local, via a local LM
Studio server), can also work or review — but only as an explicit, opt-in choice for
sensitive/local-only tasks, never as a driver and never auto-selected.

This is a generalization of OpenAI's Apache-2.0 [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
(see [`NOTICE`](./NOTICE)): its single Claude Code → Codex direction is widened into a
harness-agnostic core plus per-harness adapters, prompt templates, and prompting skills.

## Install

The repo is a self-contained plugin marketplace (it ships `.claude-plugin/` and
`.codex-plugin/` manifests), so it installs natively per harness.

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

> Codex and Antigravity plugin support is newer than Claude Code's and the exact marketplace
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
  and/or `claude`.
- For the local `qwen` harness specifically: the `qwen` CLI (Qwen Code) on your `PATH`,
  **and** a local LM Studio server running an OpenAI-compatible endpoint (default
  `http://127.0.0.1:1234/v1`) with a model loaded — `qwen` is the only harness with this
  extra, separately-running-process dependency; the other three are self-contained CLIs.

## What it does

Two delegation paths, chosen automatically:

- **Native (same harness)** — when driver and worker are the same harness, use that
  harness's own subagent primitive (Claude Code `Agent` tool, Antigravity `invoke_subagent`,
  Codex's native subagent). No worktree, no shell, no companion job. The companion returns
  `{"mode":"native", instruction}` telling the driver to do this.
- **Cross-harness** — when driver ≠ worker, the `agent-companion` runtime creates an
  isolated git worktree, writes a brief, spawns the target harness **unattended**, monitors
  it, and collects validated artifacts. The driver — and only the driver — applies the patch.
  Runs **synchronously** by default; pass `--background` to detach the worker and poll it with
  `status <jobId> --wait` / `result` / `cancel` (a brokerless take on the reference's async model).

## Commands

| Command | Purpose |
|---|---|
| `/agent-collab:setup [--gate on\|off] [--sandbox on\|off]` | Detect worker-ready harnesses; toggle the stop-time review gate and the OS sandbox |
| `/agent-collab:doctor [--live] [--workers a,b]` | Self-check: config + readiness, and (with `--live`) a review-cycle + worktree-isolation smoke per worker against a throwaway repo |
| `/agent-collab:recommend --task <type> --driver <self>` (or `--profiles`) | Pick the strongest available worker for a task by underlying-model strength |
| `/agent-collab:delegate --worker <agy\|codex\|claude> [--background] [--apply] <brief>` | Run a cross-harness **worker** task (produces a patch); `--background` detaches and returns a jobId |
| `/agent-collab:review --worker <name> [--focus <text>] <diff>` | Read-only cross-harness **review** |
| `/agent-collab:adversarial-review --worker <name> <diff>` | "Try to break it" review |
| `/agent-collab:status [jobId] [--wait]` | List / inspect jobs; `--wait` blocks until a job finishes |
| `/agent-collab:result <jobId>` | Show a job's report + structured output |
| `/agent-collab:apply <jobId>` | Apply a worker's patch (3-way) to the working tree |
| `/agent-collab:cancel <jobId>` | Cancel a running job |

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
careful SWE/planning, agy (Gemini) for speed + large-context. See
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
  process is gone is treated as stalled.
- **Freeze detection:** every worker runs under an inactivity watchdog (`idle-guard`). Progress
  = stdout/stderr **or** file activity (worktree + agy's log dir) — workers often log/write
  files rather than streaming to the pipe (claude is run in streaming mode to provide a
  heartbeat). Only a worker making NO progress for `AGENT_COLLAB_IDLE_TIMEOUT` (default 10 min)
  is killed as `failureKind: "frozen"` (and falls back), so a real hang surfaces before the
  20-min hard ceiling without false-killing a slow-but-working run.
- **Limit & timeout handling:** a failed run is classified (`failureKind` = `rate-limit` |
  `auth` | `timeout` | `frozen` | `other` + a best-effort `resetAt`). On a **transient** failure
  (`rate-limit`/`timeout` by default) the runtime **auto-falls-back to the next worker-ready
  harness** (never the driver), tagging the result with a `note` + `fellBackFrom[]`; **`auth`
  is surfaced** (a config fix), not routed around. Tune via `AGENT_COLLAB_FALLBACK`
  (`off`/`on`/comma-list) or `--no-fallback`. The default per-attempt budget is 20 min so deep
  reviews aren't killed mid-run (the empty "no JSON found" failure); tune with
  `AGENT_COLLAB_TIMEOUT`.
- **Review-output normalization:** reviewer JSON is normalized before validation (severity
  lowercased/trimmed, synonyms mapped, `next_steps` optional) so a complete report isn't
  false-failed over cosmetics like codex emitting `"High"`.
- **Repair by resume:** a non-timeout repair attempt *continues* the worker's existing thread
  (codex `task --resume-last`) with a short "emit clean JSON" ask instead of re-running cold,
  falling back to a fresh re-send if the thread can't be resumed.
- **State** lives **outside** the repo (keyed by a hash of the workspace root), so it survives
  worktrees and is never committed.

## Harnesses

| Harness | Reviewer | Worker | Notes |
|---|---|---|---|
| **codex** (GPT-5.x) | ✓ | ✓ | Deepest reasoning; prefers XML-block prompts. Slower — give it a generous timeout; severity case is normalized for you |
| **claude** | ✓ | ✓ | Use the native `Agent` tool when Claude Code is also the driver |
| **agy** (Gemini) | ✓ | ✓ | Fast reviewer and implementer (Flash by default; `AGENT_COLLAB_AGY_CLASS=Pro` for depth). The adapter pins model flags before the prompt and harvests patches from agy's internal worktree when needed |
| **qwen** (local) | ✓ (local-only tasks) | ✓ (plan-execution only) | Local-only, via a local LM Studio server. **Always explicit** — never in `recommend`'s default rotation, never a fallback target, never falls back away from itself on failure. Two routes only: `local-only` (sensitive-data review) and `plan-execution` (implementing a pre-written plan). See [Configuration](#configuration) for the `AGENT_COLLAB_QWEN_*` env vars. Local-only means the *worker run* stays local — compose briefs as file paths, not pasted content, and see the harness-prompting qwen guide for the full privacy boundary |

## Driving from any harness

The companion is one harness-agnostic CLI. From Codex or Antigravity you delegate by running
it over the shell (this is what the slash commands do under the hood):

```
node /path/to/agent-collaboration/scripts/agent-companion.mjs \
  adversarial-review --worker codex --driver agy --json "<diff/context>"
```

> When driving from a **sandboxed** harness (e.g. Codex), run the companion with
> **escalated / network-enabled** permissions — it spawns a worker that calls an external
> API, which a default sandbox will block.

## Configuration

| Env var | Effect |
|---|---|
| `AGENT_COLLAB_DATA` | Out-of-repo state root (default: a per-plugin / tmp dir) |
| `AGENT_COLLAB_DRIVER` | Override which harness is driving (`codex`/`agy`/`claude`). Normally auto-detected (Codex `CODEX_THREAD_ID`, agy `ANTIGRAVITY_*`, Claude Code `CLAUDECODE`); set only if detection misses |
| `AGENT_COLLAB_SANDBOX` | OS sandbox: `on` (all non-codex) \| `off`. Default: opt-in for non-codex workers, **never codex** (it self-sandboxes). Degrades to unsandboxed if it can't be applied |
| `AGENT_COLLAB_SANDBOX_STRICT=on` | Tighten the macOS profile to deny file-write by default (confine writes to work area + temp + harness state; blocks /tmp & other volumes). Default profile only blocks `$HOME`; Linux bwrap is already strict |
| `AGENT_COLLAB_FALLBACK` | Auto-fallback policy: `off` \| `on` (rate-limit+auth+timeout) \| comma-list of kinds. Default `rate-limit,timeout` (transient; **auth is surfaced**, not routed around) |
| `AGENT_COLLAB_TIMEOUT` | Per-attempt worker **hard** timeout in **seconds** (default 1200 = 20 min). Deep reasoners on big diffs need a generous budget — too short kills the run mid-flight |
| `AGENT_COLLAB_IDLE_TIMEOUT` | **Inactivity** timeout in **seconds** (default 600 = 10 min; `0` disables). If a worker makes **no progress** — neither stdout/stderr **nor file activity** (worktree, and agy's own log dir) — for this long it's killed as `frozen`. Generous so a slow-but-working worker isn't false-killed. **qwen has its own, more generous built-in default (30 min, via `MODEL_PROFILES.qwen.idleMsOverride`) that takes precedence over this env var** — `--output-format json` gives no stdout heartbeat, and live testing found no genuine hangs, only wrong/incomplete output within normal wall-time budgets, so a wider allowance was chosen over chasing a streaming heartbeat |
| `AGENT_COLLAB_CODEX_RESUME=off` | Repair a bad codex reply with a fresh re-send instead of resuming its thread (`task --resume-last`); resume is on by default |
| `AGENT_COLLAB_ALLOW_INPLACE=on` | Permit an **unisolated** in-place run when a git worktree can't be created. Off by default — without it such a job is `blocked` rather than run in your real tree |
| `AGENT_COLLAB_ALLOW_NONWRITER=on` | Force a harness marked reviewer-only to run as a write-worker anyway. Off by default; use only for local experiments because patch capture may be empty |
| `AGENT_COLLAB_AGY_CLASS` | agy model class to pin (`Flash` default, `Pro`, …) |
| `AGENT_COLLAB_AGY_MODEL` | Pin an exact agy model label (overrides the class) |
| `AGENT_COLLAB_CLAUDE_MODEL` | Pin the model passed to `claude --model` (default: `default`, Claude Code's account-tier recommendation — never Fable/Haiku) |
| `AGENT_COLLAB_QWEN_BIN` | Override the `qwen` binary path |
| `AGENT_COLLAB_QWEN_MODEL` | Pin a specific local model via `-m` (default: none — inherits qwen's own configured default in `~/.qwen/settings.json`, since LM Studio serves one model at a time and can't be reliably auto-detected) |
| `AGENT_COLLAB_QWEN_BASE_URL` | Override the local LM Studio endpoint (default `http://127.0.0.1:1234/v1`). Must be loopback (`127.0.0.1`/`localhost`/`::1`) — a non-loopback value is refused unless `AGENT_COLLAB_QWEN_ALLOW_REMOTE=on` |
| `AGENT_COLLAB_QWEN_API_KEY` | Override the local endpoint's API key (default `lm-studio` — LM Studio doesn't validate it, it just needs to be present) |
| `AGENT_COLLAB_QWEN_ALLOW_REMOTE=on` | Explicitly permit a non-loopback `AGENT_COLLAB_QWEN_BASE_URL`. Off by default — qwen's entire purpose is keeping a job off the cloud, so a remote endpoint must be opt-in, never silently accepted |
| `AGENT_COLLAB_<AGY\|CLAUDE\|CODEX\|QWEN>_BIN` | Override a harness binary path |

Plus `setup --gate on|off` (opt-in stop-time review gate) and `setup --sandbox on|off`.

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
heartbeat, git, prompts, schema, dispatch) · `adapters/` (`claude`/`codex`/`agy`/`qwen`) ·
`prompts/` (review templates) · `schemas/` (artifact contracts) ·
`commands/` `hooks/` `skills/` `.claude-plugin/` `.codex-plugin/` (harness surface).

## Attribution & license

Apache-2.0. Derived from OpenAI's `codex-plugin-cc` (Apache-2.0, © 2026 OpenAI); the prompt
template engine, review template, prompt blocks, and parts of the runtime are adapted from it.
See [`NOTICE`](./NOTICE).
