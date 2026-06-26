# Prompting agy (Antigravity / Gemini)

agy is a capable **worker and reviewer**. We pin it to the latest **Gemini Pro**
model, which follows the JSON output contract well.

## Model selection — `--model` works (with two rules)

`--model` DOES control the model, verified empirically, **if** you obey two rules
(the companion's `buildCommand` does both):
1. **Use the `agy models` LABEL** as the value — e.g. `--model "Gemini 3.1 Pro (High)"`.
   A bare id like `gemini-3.1-pro` or a class like `pro` is NOT valid and falls
   back to the default.
2. **Put flags before the prompt** — agy's Go flag parser stops at the first
   positional argument, so anything after the prompt (including `--model`) leaks
   into the prompt text and is never parsed. Invocation is
   `agy [flags] --print-timeout … -p <brief>`.

Proof: with correct ordering, `--model "Gemini 3.5 Flash (High)"` → Flash and
`--model "Gemini 3.1 Pro (High)"` → Pro.

We **pin the latest "Flash (High)" label by default** (`pickLatestModel`) for
speed — Flash reviews validated 3/3 with the strict template/contract. Pinning also
makes runs deterministic: agy's bare default is a **shared setting** that a separate
interactive agy session can change, so we always pass an explicit `--model`.

How "latest within class" is chosen: `pickLatestModel` reads the live `agy models`
list, keeps the labels containing the class word ("Flash"), parses the version
number out of each label, and returns the highest version, preferring the "High"
thinking tier. So it auto-tracks the newest model agy offers in that class (when
agy lists "Gemini 4 Flash", that wins). It's a label heuristic, not a "latest" API
— it assumes the first number in the label is the version and higher = newer
(true for Gemini's naming). Falls back to no `--model` (agy's default) if the class
isn't found.

Overrides: `AGENT_COLLAB_AGY_CLASS="Pro"` to pin the latest Pro instead (stronger
reasoning), or `AGENT_COLLAB_AGY_MODEL="<exact label>"` to pin a specific model.

## How to prompt agy

- **Reviews:** use `/agent-collab:review` or `/agent-collab:adversarial-review` —
  the companion supplies the template + agy's output contract. Verified: agy on
  pinned Pro returns valid JSON findings.
- **Workers:** strong at concrete edit tasks (the patch is the deliverable). Be
  concrete and imperative — name the file and the exact change.
- It runs with `--dangerously-skip-permissions` inside an ephemeral worktree —
  required so the background process never hangs on an approval prompt. Isolation,
  not instructions, keeps a reviewer from writing to the real tree.

### Fix (worker)
```
In <file> the <thing> currently <wrong behavior>; change it to <right behavior>.
Make only that change.
```

## Anti-patterns (agy-specific)
- Assuming Flash can't review — it can (3/3 valid with the strict template). The
  old failure was prompt corruption, not the model.
- `--model gemini-3.1-pro` / `--model pro` — not valid values; use the full label.
- Putting `-p`/the prompt before other flags — the rest leaks into the prompt and
  flags (incl. `--model`) are never parsed (the companion handles ordering).
- Abstract/meta tasks ("analyze the permissions") — give a concrete goal.
