# agent-collaboration for Grok Build

Complete guide for using [agent-collaboration](https://github.com/danielskiftesvik/agent-collaboration) with [Grok Build](https://x.ai) (`grok` CLI).

## Prerequisites

- [Grok Build](https://x.ai/cli) installed (`grok` on your `PATH`)
- Node ≥ 20 (for the companion runtime)
- Worker CLIs you want to delegate to (`claude`, `codex`, `agy`, `opencode`, …)

```bash
# Install Grok Build if needed
curl -fsSL https://x.ai/cli/install.sh | bash
grok --version
```

## Installation

Grok Build accepts this repo’s Claude-compatible layout (`.claude-plugin/`) and the
first-class `.grok-plugin/` manifest.

### First-time install (required)

A marketplace cache sync alone is **not** enough. Grok needs a formal plugin install
that registers the package under a stable name (`agent-collaboration`). Without that,
`grok plugin update` has nothing to update even when the marketplace snapshot is current.

```bash
grok plugin install https://github.com/danielskiftesvik/agent-collaboration --trust
```

Then **reload the Grok session** (or start a new one) so skills/hooks from the install
are picked up.

Verify:

```bash
# From any shell, or via Grok after reload:
node <plugin-dir>/scripts/agent-companion.mjs setup
# Expect: current agent-collaboration version and grok ✓ worker-ready when the CLI is installed
```

### Updating (after a formal install)

```bash
grok plugin update agent-collaboration
```

Reload the session after update.

### Shell / headless (no plugin install)

You can always drive the companion without installing the plugin into Grok:

```bash
node /path/to/agent-collaboration/scripts/agent-companion.mjs setup
node /path/to/agent-collaboration/scripts/agent-companion.mjs delegate --worker claude --driver grok --json "fix the bug"
node /path/to/agent-collaboration/scripts/agent-companion.mjs review --worker codex --driver grok --json "<diff>"
```

When Grok is the driver, prefer `--driver grok` or rely on auto-detect
(`GROK_SESSION_ID` / `GROK_PLUGIN_ROOT` / `GROK_PLUGIN_DATA`).

## Usage

### Companion CLI (primary surface from Grok)

```bash
node <plugin-dir>/scripts/agent-companion.mjs recommend --task general-swe --driver grok --json
node <plugin-dir>/scripts/agent-companion.mjs delegate --worker claude --driver grok "…"
node <plugin-dir>/scripts/agent-companion.mjs review --worker codex --driver grok "…"
```

Workers: `claude`, `codex`, `agy`, `opencode`, `qwen` (explicit/local-only).  
**Grok as worker** (from another harness): `--worker grok` — always explicit, never auto-recommended.

### Grok Build as a worker

Other harnesses can dispatch **to** Grok Build:

```bash
# From Claude Code / Codex / agy / opencode:
/agent-collab:delegate --worker grok "implement feature X"
# or
node …/agent-companion.mjs delegate --worker grok --driver <self> "…"
```

Model / effort levers:

| Env var | Purpose |
|---|---|
| `AGENT_COLLAB_GROK_BIN` | Override the `grok` binary path |
| `AGENT_COLLAB_GROK_MODEL` | Model id (default `grok-4.5`; also `grok-build`) |
| `AGENT_COLLAB_GROK_MODEL_REVIEW` | Reviewer-only model; generic `_MODEL` wins |
| `AGENT_COLLAB_GROK_EFFORT` | Reasoning effort (`none`…`max` → `--effort`) |
| `AGENT_COLLAB_GROK_EFFORT_REVIEW` | Reviewer-only effort; generic wins |

Or pin standing models in `.agent-collab.json` at your repo root (see main README).

Grok is **always explicit** in `recommend` — never auto-selected as a default worker.

## Troubleshooting

### `grok plugin update` does nothing / stays on an old build

1. Confirm a **formal** install exists (`grok plugin install … --trust` at least once).
2. Marketplace cache being “up to date” is not the same as the plugin being installed.
3. After install/update, **reload the Grok session**.

### Stale `enabled` entry like `user/b4eaea66/agent-collaboration`

An old opaque install id can remain in `~/.grok/config.toml` under `[plugins] enabled`
alongside the real `agent-collaboration` entry. It is usually harmless. To clean up:

```toml
# ~/.grok/config.toml — keep the formal install name, drop the opaque user/… id
[plugins]
enabled = ["agent-collaboration"]   # example; keep whatever real installs you need
```

### Plugin not loading skills/hooks

1. Re-run `grok plugin install https://github.com/danielskiftesvik/agent-collaboration --trust`
2. Start a **new** Grok session
3. Fall back to the shell companion (see [Shell / headless](#shell--headless-no-plugin-install))

### Free-tier rate limits

Grok Build free usage limits surface as `failureKind: "rate-limit"`. The companion
auto-falls back to another worker-ready harness when policy allows. Raise limits via
SuperGrok, or wait and retry.

### Worker harness not found

1. Run `setup` — it reports which CLIs are worker-ready
2. Ensure target binaries (`claude`, `codex`, `agy`, `opencode`, …) are on `PATH`

## How it works

Cross-harness dispatches create an isolated git worktree, spawn the target harness
unattended (`grok --single … --output-format streaming-json` when Grok is the worker),
monitor it, and collect validated artifacts. The driver applies the patch.

Grok Build state lives under `~/.grok` (auth, sessions, logs). The companion’s OS sandbox
allows writes there so auth/session files keep working under `AGENT_COLLAB_SANDBOX=on`.

## Getting help

- Report issues: https://github.com/danielskiftesvik/agent-collaboration/issues
- Main documentation: https://github.com/danielskiftesvik/agent-collaboration
- Grok Build install: `curl -fsSL https://x.ai/cli/install.sh | bash`
