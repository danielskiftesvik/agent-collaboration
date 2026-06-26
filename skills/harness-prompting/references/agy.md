# Prompting agy (Antigravity / Gemini)

agy is a capable **worker and reviewer**. Its default model is **Gemini 3.1 Pro**
(from `settings.json`), which follows the JSON output contract well.

History worth knowing: agy *looked* worker-only for a while, but that was two bugs
in our adapter, not an agy limitation:
- the adapter put `-p` **first**, and agy's flag parser leaks anything after the
  first non-flag token into the prompt — corrupting it; and
- forcing a model via `--model <label/id>` silently **downgraded agy to Flash**
  (the labels from `agy models` and ids like `gemini-3.1-pro` are not valid
  `--model` values), and Flash narrates instead of emitting JSON.

Both are fixed: the companion now invokes `agy [flags] --print-timeout … -p <brief>`
(flags first, `-p <brief>` last) with **no `--model`** (so the Pro default stands).
With that, agy emits clean schema-valid reviews (verified through the companion).

## How to prompt agy

- **Reviews:** use `/agent-collab:review` or `/agent-collab:adversarial-review` —
  the companion supplies the template + the agy output contract. Verified: agy on
  Pro returns valid JSON findings.
- **Workers:** strong at concrete edit tasks (the patch is the deliverable). Be
  concrete and imperative — name the file and the exact change. Vague/meta tasks
  make it ramble.
- **Do NOT pass `--model`** to force Pro — it downgrades to Flash. The default is
  already Pro. (The `AGENT_COLLAB_AGY_MODEL*` env hooks exist only for a future
  known-good id.)
- It runs with `--dangerously-skip-permissions` inside an ephemeral worktree —
  required so the background process never hangs on an approval prompt. Isolation,
  not instructions, is what keeps a reviewer from writing to the real tree.

### Fix (worker)
```
In <file> the <thing> currently <wrong behavior>; change it to <right behavior>.
Make only that change.
```

## Anti-patterns (agy-specific)
- Passing `--model "<label>"` / `--model gemini-3.1-pro` — downgrades to Flash.
- Putting `-p` before other flags — corrupts the prompt (the companion handles this).
- Abstract/meta tasks ("analyze the permissions") — give a concrete goal.
