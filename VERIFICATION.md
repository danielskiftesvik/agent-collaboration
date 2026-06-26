# Verification

## Automated (run: `npm test` → 63 tests passing)

| Plan scenario | Covered by |
|---|---|
| Cross-harness reviewer → valid `outputs/*.json` + `reports/*.md` | `test/dispatch.test.mjs`, `test/cli.test.mjs` (stubbed worker) |
| Cross-harness worker → patch applies via `git apply --3way` | `test/dispatch.test.mjs` (`runWorkerSync` + `applyResult`) |
| Stall detection (stale heartbeat + dead pid) | `test/heartbeat.test.mjs` |
| Native path (driver == worker → no job) | `test/dispatch.test.mjs`, `test/cli.test.mjs` |
| Malformed output → retry then fail | `test/dispatch.test.mjs` |
| Worktree shared-state / outside-repo | `test/workspace.test.mjs` |
| OS-level sandboxing (macOS / Linux) | `test/process.test.mjs` |

## Real binaries (read-only)

- `setup` probe: **agy 1.0.12**, **claude 2.1.193**, **codex 1.0.2** all `✓ worker-ready`.
- Native-path routing returns the `Agent` tool instruction (no job, no API call).
- Codex regression: the installed `openai-codex` plugin is untouched (its commands still present).

## Empirical results from live runs (disposable sandboxes)

Real cross-harness runs against a buggy `add.js` in throwaway `/tmp` repos:

- **codex reviewer** → `completed`, valid structured review, correctly flagged the
  subtraction bug. codex follows the JSON contract reliably. (A real run also
  found a bug in our codex adapter — see Task 9.)
- **agy worker** → produced the **correct patch** (`a - b` → `a + b`) inside the
  ephemeral worktree; the main tree was untouched. The patch is the deliverable
  (Task 11), so this is a success even though agy replied in prose.
- **agy reviewer** → **works** (verified 2/2 via the companion: `completed`,
  `resultValid: true`, valid findings) on agy's default **Gemini 3.1 Pro**.
  Earlier this looked broken, but the cause was two adapter bugs, not agy:
  (1) `-p` was placed first, so agy leaked later flags into the prompt and
  corrupted it; (2) forcing `--model` downgraded agy to **Flash**, which narrates
  instead of emitting JSON. Fixed by invoking `agy [flags] … -p <brief>` (flags
  first, `-p <brief>` last) and pinning the latest Pro **label** via `--model`
  (`--model` works with the `agy models` label + flags-before-prompt ordering;
  the earlier "Flash" reads were a wrong id plus a separate agy session changing
  the shared default). agy is a worker **and** reviewer.

Two safety consequences, both confirmed live:
- Worktree isolation bounds a worker's *intended writes* but does NOT sandbox the
  process — agy roamed the filesystem with skip-permissions. Real OS sandboxing
  is the actual fix.
- Reviewers (Task 10) and workers must therefore only ever run against a
  disposable sandbox until OS-level sandboxing lands.

## DEFERRED — live worker/reviewer runs

Running a **real** `agy`/`claude` worker or reviewer end-to-end is intentionally
NOT done here. During development a live `agy` run (and a separate `agy` session
that ran `git clean -fd`) destroyed the then-uncommitted working tree. Lesson
learned, now mitigated by **committing after every task**.

Before any live-harness run:
1. Run it against a **throwaway copy/sandbox**, never the live working tree.
2. Ensure the repo is committed first (clean `git status`).

## Hardening and Sandboxing (Task 14 Completed)

To prevent workers and reviewers from roaming the filesystem or making unauthorized edits/reads, we have implemented OS-level sandboxing:
- **macOS (`sandbox-exec`)**: Generates an ephemeral sandbox profile that strictly permits read/write operations *only* inside the worktree/workspace, artifact directory, and standard temp paths (`/tmp`, `/private/var`, `/var/folders`). Outbound network access is allowed for API calls, but all sensitive user config directories (e.g., `~/.ssh`, `~/.gemini`, `~/.config`, `~/.aws`, `~/.kube`) are explicitly denied.
- **Linux (`bwrap` / Bubblewrap)**: Restricts namespace and bind-mounts standard directories, confining writes strictly to the workspace and artifact directories.
- **Configuration**: Toggleable globally via `agent-companion setup --sandbox on|off`, or overrideable via `AGENT_COLLAB_SANDBOX=off`.
