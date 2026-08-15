---
name: assigning-across-machines
description: Use when sending work to another machine with peers assign, writing a fleet brief, passing --hint-harness, or waiting on a remote orchestrator reply.
---

# Assigning across machines

**REQUIRED BACKGROUND:** `peer-fleet` — this is not `delegate`.

1. `peers machines --json` — target `available` and not `busy`.
2. `--from` is the fleet name (`main` on Mini). Do not target `main` unless `--to main`.
3. Brief is new work only.

```
node "$COMPANION" peers assign --from main \
  --to-computer "2017 MacBook Pro" \
  --hint-harness agy \
  --wait-seconds 120 \
  "implement: same cycle file as last time, worker agy"
```

`--hint-harness` is the worker hint and is not `--harness` (sender identity on HTTP register). Put the same worker on the flag, not as a `delegate` command in the brief. `--to` pins a session; `--to-computer` pins a machine.

## Brief

Write exactly these lines:

1. Goal — one line. Lead with `ping:` or `implement:`.
2. One new constraint, if any (path, isolate). Skip if the same session already has it.
3. Done check — one line.

Same orchestrator session already has the last cycle. The command block above is the follow-up shape.

Wait with `--wait-seconds` or `peers lineage --id`. The peer reply closes the loop. Do not `apply` on the sender. Do not implement locally to save a hop.

| Excuse | Reality |
|---|---|
| "Make the prompt self-contained" | Same session already has the last cycle. One sentence. |
| "Put delegate --worker in the brief" | Hint goes on `--hint-harness`. The receiver runs local `delegate`. |
| "I'll just do it here" | User asked another computer. Assign. |
