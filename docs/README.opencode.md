# agent-collaboration for OpenCode

Complete guide for using [agent-collaboration](https://github.com/danielskiftesvik/agent-collaboration) with [OpenCode.ai](https://opencode.ai).

## Installation

### CLI (recommended)

```bash
# Global
opencode plugin "agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git" -g

# Or project-local
opencode plugin "agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git"
```

### Config file

Add agent-collaboration to the `plugin` array in your `opencode.json` / `opencode.jsonc`
(global `~/.config/opencode/` or project-level):

```json
{
  "plugin": ["agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git"]
}
```

Restart OpenCode. The plugin installs through OpenCode's plugin manager and registers
slash commands plus the companion runtime.

Verify:

```
/agent-collab:setup
```

OpenCode uses its own plugin install. If you also use Claude Code, Codex, or Antigravity,
install agent-collaboration separately for each harness.

## Usage

### Slash commands

| Command | Purpose |
|---|---|
| `/agent-collab:setup` | Detect worker-ready harnesses |
| `/agent-collab:doctor` | Self-check config + readiness |
| `/agent-collab:recommend --task <type>` | Pick the strongest available worker |
| `/agent-collab:delegate --worker <name> "<task>"` | Cross-harness worker task |
| `/agent-collab:review --worker <name> "<context>"` | Cross-harness review |
| `/agent-collab:adversarial-review --worker <name> "<diff>"` | "Try to break it" review |
| `/agent-collab:status [jobId]` | Job status |
| `/agent-collab:result <jobId>` | Fetch a completed artifact |
| `/agent-collab:apply <jobId>` | Apply a worker patch |

Workers: `claude`, `codex`, `agy`, `opencode`, `qwen` (qwen is explicit/local-only).

### Shell / headless

The companion is one harness-agnostic CLI. From any shell (or when slash commands are unavailable):

```bash
node <plugin-dir>/scripts/agent-companion.mjs setup
node <plugin-dir>/scripts/agent-companion.mjs delegate --worker claude --driver opencode --json "fix the bug"
node <plugin-dir>/scripts/agent-companion.mjs review --worker codex --driver opencode --json "<diff>"
```

When installed via OpenCode's plugin manager, `<plugin-dir>` is under
`~/.cache/opencode/packages/agent-collaboration@git+https:/.../node_modules/agent-collaboration/`.

> When driving from a **sandboxed** harness, run the companion with escalated / network-enabled
> permissions — it spawns a worker that calls an external API.

### Opencode as a worker

Other harnesses can also dispatch **to** opencode:

```bash
# From Claude Code / Codex / agy:
/agent-collab:delegate --worker opencode "implement feature X"
```

Model selection for opencode workers:

| Env var | Purpose |
|---|---|
| `AGENT_COLLAB_OPENCODE_BIN` | Override the `opencode` binary path |
| `AGENT_COLLAB_OPENCODE_MODEL` | Model in `provider/model` format (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `AGENT_COLLAB_OPENCODE_MODEL_REVIEW` | Reviewer-only model; generic `_MODEL` wins if both set |

Or pin standing models in `.agent-collab.json` at your repo root (see main README).

Opencode is **always explicit** in `recommend` — never auto-selected as a default worker.

## Updating

OpenCode installs agent-collaboration through a git-backed package spec. Some OpenCode
and Bun versions pin that resolved git dependency in a lockfile or cache, so a
restart may not pick up the newest commit. If updates do not appear, clear the
package cache and reinstall with `--force`:

```bash
rm -rf ~/.cache/opencode/packages/agent-collaboration*
opencode plugin "agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git" -g --force
```

To pin a specific version, use a branch or tag:

```json
{
  "plugin": ["agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git#v0.7.0"]
}
```

## How It Works

The plugin does two things:

1. **Server target** (`package.json` `"main"`) — registers a `config` hook so OpenCode
   accepts the package as a server plugin (same entrypoint pattern as other OpenCode plugins).
2. **TUI target** (`exports["./tui"]`) — registers `tui.command.execute` so slash commands
   like `/agent-collab:delegate` run the companion inside the TUI.

Cross-harness dispatches create an isolated git worktree, spawn the target harness
unattended (`opencode run --format json --auto --dir=<workspace> ...` when opencode is
the worker), monitor it, and collect validated artifacts. The driver applies the patch.

### Known opencode limitations

- No `--exclude-tools` flag — write safety is via worktree isolation + breach detection.
- No session-ID-based resume — retry is always a full re-send (side effects may repeat).
- Reviewers still get `--auto` (no per-role tool gating on the CLI).

### Tool mapping

When skills or prompts request actions, on OpenCode these resolve to:

- "Create a todo" / "mark complete in todo list" → `todowrite`
- Subagent / general-purpose task → OpenCode's `task` tool with `subagent_type: "general"` (or `"explore"`)
- "Invoke a skill" → OpenCode's native `skill` tool
- "Read a file" → `read`
- "Create a file" / "edit a file" / "delete a file" → `apply_patch` / `edit` / `write`
- "Run a shell command" → `bash`
- "Search file contents" / "find files by name" → `grep`, `glob`
- "Fetch a URL" → `webfetch`

## Troubleshooting

### Plugin not loading

1. Check logs: `opencode run --print-logs "hello" 2>&1 | grep -i agent-collab`
2. Verify the plugin line in your `opencode.json` / `opencode.jsonc`
3. Confirm install detected targets: re-run `opencode plugin "..." -g --force` and look for
   `Detected server + tui targets`
4. Make sure you're running a recent version of OpenCode (tested on 1.18.4+)

### "does not expose plugin entrypoints"

The package must expose `"main"` and/or `exports["./tui"]` in `package.json`. If you see
this after an update, the OpenCode package cache is almost certainly stale:

```bash
rm -rf ~/.cache/opencode/packages/agent-collaboration*
opencode plugin "agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git" -g --force
```

### Slash commands not responding

1. Confirm TUI target was installed (`~/.config/opencode/tui.json` should list the plugin)
2. Restart the OpenCode TUI after install
3. Fall back to the shell companion (see [Shell / headless](#shell--headless))

### Windows install issues

Some Windows OpenCode builds have upstream installer issues with git-backed
plugin specs, including cache paths for `git+https` URLs and Bun not finding
`git.exe` even when it works in a normal terminal. If OpenCode cannot install
the plugin, try installing with system npm and pointing OpenCode at the local
package:

```powershell
npm install agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git --prefix "$HOME\.config\opencode"
```

Then use the installed package path in `opencode.json`:

```json
{
  "plugin": ["~/.config/opencode/node_modules/agent-collaboration"]
}
```

### Worker harness not found

1. Run `/agent-collab:setup` — it reports which CLIs are worker-ready
2. Ensure `claude`, `codex`, `agy`, and/or `opencode` are on your `PATH`
3. For `qwen`: local LM Studio must be running at the configured base URL

## Getting Help

- Report issues: https://github.com/danielskiftesvik/agent-collaboration/issues
- Main documentation: https://github.com/danielskiftesvik/agent-collaboration
- OpenCode docs: https://opencode.ai/docs/
