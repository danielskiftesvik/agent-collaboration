# Verification

## Automated (run: `npm test` → 56 tests passing)

| Plan scenario | Covered by |
|---|---|
| Cross-harness reviewer → valid `outputs/*.json` + `reports/*.md` | `test/dispatch.test.mjs`, `test/cli.test.mjs` (stubbed worker) |
| Cross-harness worker → patch applies via `git apply --3way` | `test/dispatch.test.mjs` (`runWorkerSync` + `applyResult`) |
| Stall detection (stale heartbeat + dead pid) | `test/heartbeat.test.mjs` |
| Native path (driver == worker → no job) | `test/dispatch.test.mjs`, `test/cli.test.mjs` |
| Malformed output → retry then fail | `test/dispatch.test.mjs` |
| Worktree shared-state / outside-repo | `test/workspace.test.mjs` |

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
- **agy reviewer** → **unreliable.** Even with the emphatic JSON-only contract
  (Task 12), Gemini Flash in headless mode derailed — it fixated on its own
  `--dangerously-skip-permissions` flag and **read files outside the worktree**
  (the user's `~/.gemini/.../settings.json`) instead of reviewing. Conclusion:
  **use codex/claude for reviews; use agy only as a worker.**

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

## KNOWN RISK — reviewer permissions (follow-up)

`adapters/agy.mjs` passes `--dangerously-skip-permissions` and `runWorkerSync`
runs a **reviewer in `cwd`** (the live tree). A misbehaving reviewer could
therefore write/execute in the real tree. Recommended hardening (not yet
applied — pending decision):
- Reviewers run read-only (no skip-permissions; rely on the harness's read-only
  mode), or inside a throwaway worktree whose changes are discarded.
- Workers always run inside the ephemeral worktree (already the case).
