# Installing agent-collaboration for OpenCode

## Prerequisites

- [OpenCode.ai](https://opencode.ai) installed
- Node ≥ 20
- Worker CLIs you want to delegate to, on your `PATH` (`claude`, `codex`, `agy`, and/or `opencode`)

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
(global or project-level):

```json
{
  "plugin": ["agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git"]
}
```

Restart OpenCode. The plugin installs through OpenCode's plugin manager and
registers slash commands.

Verify:

```
/agent-collab:setup
```

OpenCode uses its own plugin install. If you also use Claude Code, Codex, or
another harness, install agent-collaboration separately for each one.

## Usage

```
/agent-collab:setup
/agent-collab:delegate --worker claude "implement feature X"
/agent-collab:review --worker codex "<diff or context>"
/agent-collab:recommend --task hard-debug
```

## Updating

OpenCode installs agent-collaboration through a git-backed package spec. Some OpenCode
and Bun versions pin that resolved git dependency in a lockfile or cache, so a
restart may not pick up the newest commit. If updates do not appear, clear the
package cache or reinstall with `--force`:

```bash
rm -rf ~/.cache/opencode/packages/agent-collaboration*
opencode plugin "agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git" -g --force
```

To pin a specific version:

```json
{
  "plugin": ["agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git#v0.7.0"]
}
```

## Troubleshooting

### Plugin not loading

1. Check logs: `opencode run --print-logs "hello" 2>&1 | grep -i agent-collab`
2. Verify the plugin line in your `opencode.json` / `opencode.jsonc`
3. Make sure you're running a recent version of OpenCode

### "does not expose plugin entrypoints"

Stale package cache. Clear and reinstall:

```bash
rm -rf ~/.cache/opencode/packages/agent-collaboration*
opencode plugin "agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git" -g --force
```

### Windows install issues

Some Windows OpenCode builds have upstream installer issues with git-backed
plugin specs. If OpenCode cannot install the plugin, try installing with system
npm and pointing OpenCode at the local package:

```powershell
npm install agent-collaboration@git+https://github.com/danielskiftesvik/agent-collaboration.git --prefix "$HOME\.config\opencode"
```

Then use the installed package path in `opencode.json`:

```json
{
  "plugin": ["~/.config/opencode/node_modules/agent-collaboration"]
}
```

## Getting Help

- Report issues: https://github.com/danielskiftesvik/agent-collaboration/issues
- Full documentation: https://github.com/danielskiftesvik/agent-collaboration/blob/main/docs/README.opencode.md
