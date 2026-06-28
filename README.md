# agent-collaboration

Cross-harness agent collaboration. A driver harness — **Claude Code**, **Codex**, or
**Antigravity (`agy`)** — can delegate a task to a **worker** or **reviewer** running on
another harness, then apply the result to the working tree. Any of the three can drive;
any of the three can do the work.

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

## What it does

Two delegation paths, chosen automatically:

- **Native (same harness)** — when driver and worker are the same harness, use that
  harness's own subagent primitive (Claude Code `Agent` tool, Antigravity `invoke_subagent`,
  Codex's native subagent). No worktree, no shell, no companion job. The companion returns
  `{"mode":"native", instruction}` telling the driver to do this.
- **Cross-harness** — when driver ≠ worker, the `agent-companion` runtime creates an
  isolated git worktree, writes a brief, spawns the target harness **unattended**, monitors
  it, and collects validated artifacts. The driver — and only the driver — applies the patch.

## Commands

| Command | Purpose |
|---|---|
| `/agent-collab:setup [--gate on\|off] [--sandbox on\|off]` | Detect worker-ready harnesses; toggle the stop-time review gate and the OS sandbox |
| `/agent-collab:recommend --task <type> --driver <self>` (or `--profiles`) | Pick the strongest available worker for a task by underlying-model strength |
| `/agent-collab:delegate --worker <agy\|codex\|claude> [--apply] <brief>` | Run a cross-harness **worker** task (produces a patch) |
| `/agent-collab:review --worker <name> [--focus <text>] <diff>` | Read-only cross-harness **review** |
| `/agent-collab:adversarial-review --worker <name> <diff>` | "Try to break it" review |
| `/agent-collab:status [jobId]` | List / inspect jobs |
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
- **Isolation + breach detection:** cross-harness workers AND reviewers run in an ephemeral git
  worktree; a worker's changes are captured as a patch, a reviewer's are discarded. The runtime
  also snapshots the driver's real tree before/after each run — if a worker *escapes* its
  worktree and writes into the live checkout (observed with `agy` under
  `--dangerously-skip-permissions`), the job is marked **`breach`** with `escapedPaths`, never
  `completed`. A valid self-report that captured **no** patch is `no-changes`, not `completed`.
- **Prompts:** review-grade work uses code-loaded templates (`prompts/adversarial-review.md`,
  `prompts/review.md`) with a `{{OUTPUT_CONTRACT}}` filled per harness; free-form tasks are
  composed by the driver using the `harness-prompting` skill.
- **Output contracts + validation:** each worker's output is validated against a JSON schema
  (`schemas/`); a worker is `completed` on a clean, applying patch even if its metadata JSON
  is missing (the patch is the deliverable).
- **Stall detection:** jobs carry a heartbeat; a job whose heartbeat is stale **and** whose
  process is gone is treated as stalled.
- **Limit & timeout handling:** a failed run is classified (`failureKind` = `rate-limit` |
  `auth` | `timeout` | `other` + a best-effort `resetAt`). On a rate/auth limit **or a
  timeout** the runtime **auto-falls-back to the next worker-ready harness** (never the
  driver), tagging the result with a `note` + `fellBackFrom[]`; if every worker fails that way
  it returns `allWorkersLimited` for the driver to surface. Disable with `--no-fallback` /
  `AGENT_COLLAB_FALLBACK=off`. The default per-attempt budget is 20 min so deep reviews aren't
  killed mid-run (the empty "no JSON found" failure); tune with `AGENT_COLLAB_TIMEOUT`.
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
| **agy** (Gemini) | ✓ | ⚠ | Excellent **reviewer**; pinned to the latest **Flash** for speed (`AGENT_COLLAB_AGY_CLASS=Pro` for stronger reasoning). As a **worker** it has been observed escaping its worktree on a real repo — the runtime flags this as a `breach`; prefer codex/claude as implementers until OS-sandbox confinement is on. Needs label-format `--model` with flags before the prompt — the adapter handles this |

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
| `AGENT_COLLAB_SANDBOX=on` | Opt-in macOS/Linux OS sandbox for workers (off by default) |
| `AGENT_COLLAB_FALLBACK=off` | Disable auto-fallback to another worker on a rate/subscription limit or timeout (on by default) |
| `AGENT_COLLAB_TIMEOUT` | Per-attempt worker timeout in **seconds** (default 1200 = 20 min). Deep reasoners on big diffs need a generous budget — too short SIGTERMs the run mid-flight and yields empty "no JSON" output |
| `AGENT_COLLAB_CODEX_RESUME=off` | Repair a bad codex reply with a fresh re-send instead of resuming its thread (`task --resume-last`); resume is on by default |
| `AGENT_COLLAB_AGY_CLASS` | agy model class to pin (`Flash` default, `Pro`, …) |
| `AGENT_COLLAB_AGY_MODEL` | Pin an exact agy model label (overrides the class) |
| `AGENT_COLLAB_<AGY\|CLAUDE\|CODEX>_BIN` | Override a harness binary path |

Plus `setup --gate on|off` (opt-in stop-time review gate) and `setup --sandbox on|off`.

## Development

```
npm test        # node --test — the full suite
```

Layout: `scripts/agent-companion.mjs` (CLI/dispatch) · `core/` (state, jobs, worktree,
heartbeat, git, prompts, schema, dispatch) · `adapters/` (`claude`/`codex`/`agy`) ·
`prompts/` (review templates) · `schemas/` (artifact contracts) ·
`commands/` `hooks/` `skills/` `.claude-plugin/` `.codex-plugin/` (harness surface).

## Attribution & license

Apache-2.0. Derived from OpenAI's `codex-plugin-cc` (Apache-2.0, © 2026 OpenAI); the prompt
template engine, review template, prompt blocks, and parts of the runtime are adapted from it.
See [`NOTICE`](./NOTICE).
