# Prompting agy (Antigravity / Gemini) — worker-only

agy is a strong **worker** and an unreliable **reviewer**. Verified empirically:

- `agy -p` runs on **Gemini 3.5 Flash** and cannot be switched off it — it ignores
  `--model` for both `agy models` display labels and class names like `pro`, and a
  spaced `--model` value breaks prompt delivery. So you cannot buy better
  structured output by changing the model.
- On a **review**, Flash narrates its analysis in prose instead of emitting JSON,
  so the review artifact does not validate. **Route reviews to codex or claude.**
- On a **worker** task it is genuinely good: give it a concrete edit goal and it
  produces a correct patch. The **patch is the deliverable**, not the JSON — the
  companion marks a worker `completed` on a clean patch even if the metadata JSON
  is missing.

## How to prompt agy (worker)

- Be concrete and imperative: name the file and the exact change. Vague or
  meta tasks make it ramble (it has wandered into explaining its own
  `--dangerously-skip-permissions` flag).
- Keep the goal first; one task per run.
- The companion fills `{{OUTPUT_CONTRACT}}` with an **emphatic, example-anchored
  "ONLY a JSON, nothing else"** block (Flash needs the example), but don't rely on
  it for reviews.
- It runs with `--dangerously-skip-permissions` inside an ephemeral worktree —
  never rely on it honoring "review-only" by instruction alone; isolation is what
  protects the tree.

### Fix (worker) — the sweet spot
```
In <file> the <thing> currently <wrong behavior>; change it to <right behavior>.
Make only that change.
```

## Anti-patterns (agy-specific)
- Using agy as a reviewer and expecting structured findings — it won't validate.
- Passing `--model "<label>"` to force Pro — ignored, and a spaced value breaks
  prompt delivery.
- Abstract/meta tasks ("analyze the permissions", "what would you like to do") —
  agy derails. Give a concrete edit goal.
