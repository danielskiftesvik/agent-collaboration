# agent-collaboration for DeepSeek Harness (`dsh`)

DeepSeek Harness is a first-class driver and worker: other harnesses can
`--worker dsh`, and a DeepSeek Harness session can drive the companion via `/ac`.

`dsh` is **always explicit** — `recommend` will not auto-select it.

## Prerequisites

- `dsh` on your `PATH` (DeepSeek Harness CLI)
- Node ≥ 20
- Worker CLIs you want to delegate to (`claude`, `codex`, `agy`, `grok`, `opencode`, …)

```bash
dsh --version
```

State lives under `$DSH_HOME` (default `~/.dsh`). Auth and the default model are
whatever you already configured in the web UI (`~/.dsh/settings.yaml`).

## Installation (driver plugin)

The repo is a Cordis bundle (`dsh.bundle.patch` in `package.json`). Add it to the
**web** profile (the interactive driver), not headless:

```bash
# GitHub
dsh plugin --profile web add github:danielskiftesvik/agent-collaboration

# Local checkout
dsh plugin --profile web add /path/to/agent-collaboration
```

Restart `dsh --profile web`. You should get `/ac`.

```
/ac setup
/ac recommend --task general-swe
/ac delegate --worker claude "…"
/ac review --worker codex "…"
```

`/ac` forwards the rest of the line to `scripts/agent-companion.mjs` with
`--driver dsh`. Detection also keys off `DSH_PLUGIN_ROOT` (set by the plugin).
`$DSH_HOME` alone is **not** treated as “dsh is driving.”

### Shell / headless (no plugin)

```bash
node /path/to/agent-collaboration/scripts/agent-companion.mjs setup
node /path/to/agent-collaboration/scripts/agent-companion.mjs delegate --worker claude --driver dsh --json "fix the bug"
```

## DeepSeek Harness as a worker

```bash
node scripts/agent-companion.mjs delegate --worker dsh --driver claude "…"
node scripts/agent-companion.mjs review --worker dsh --driver claude "…"
```

The adapter runs:

```bash
dsh --profile headless "<brief + output contract>"
```

in the job worktree, with `DSH_PERMISSION_MODE=danger-full-access` so the process
cannot block on an approval prompt (headless has no TTY). Isolation is the
worktree + breach detection.

There is no grok-style read-only `plan` mode. Reviewers get the same unattended
permission env; keep them read-only in the brief.

## Env / pins

| Lever | Effect |
|---|---|
| `AGENT_COLLAB_DSH_BIN` | Override the `dsh` binary |
| `AGENT_COLLAB_DSH_MODEL` | Recorded on the spawn env as the resolved model pin (dsh itself still uses `~/.dsh/settings.yaml` until a CLI model flag exists) |
| `AGENT_COLLAB_DSH_MODEL_REVIEW` | Reviewer-only pin; generic `_MODEL` wins |
| `DSH_HOME` | Harness home (default `~/.dsh`) |
| `.agent-collab.json` `workers.dsh` | Standing pin |

Instance aliases may set `DSH_HOME` / `AGENT_COLLAB_DSH_BIN` in
`~/.agent-collaboration/config.json`.
