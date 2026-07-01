# Prompting qwen (local, via LM Studio)

qwen is **always explicit** — never auto-selected by `recommend`'s default
routing, and never substituted in (or away from) as an automatic fallback. It
exists for exactly two routes:

- `local-only`: a review/investigation task that must never reach a cloud API.
- `plan-execution`: implementing an already-written, fully-specified plan
  (typically from `superpowers:writing-plans`) rather than open-ended work.

## What "local-only" actually guarantees

**Narrower than "sensitive data never leaves this machine."** It guarantees the
*worker run* stays local — not the driver's own context, and not qwen's own
agent-scaffold tools. Two things this does NOT cover, and what to do instead:

1. **Compose the brief as file paths, not pasted content.** If you (the driver)
   read a sensitive file and paste its contents into the brief, that content is
   already in your own context — possibly a cloud conversation — before qwen ever
   runs. For a `local-only` task, reference the file path and let qwen's own local
   process read the bytes; don't read it yourself first.
2. **The runtime does not scrub qwen's report.** Whatever qwen's summary contains
   flows back to you (the driver) same as any other worker's report. Ask qwen for
   a status/redacted summary, not a verbatim dump, when the underlying content is
   sensitive — this is a prompting convention, not something enforced in code.

Network egress beyond the pinned local endpoint is mitigated (a pinned
`--openai-base-url`, `--exclude-tools` for network-capable agent tools like
`web_fetch`, and a `cleanEnv` process with no ambient cloud credentials) but not
kernel-enforced — full OS-level network denial is a known, deferred hardening
item, not a current guarantee.

## How to prompt qwen

- **`local-only` review:**
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" recommend --task local-only --driver <self> --json
  node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" delegate --worker qwen --role reviewer --driver <self> \
    "Investigate <path/to/sensitive-file>. Read it yourself — do not paste its contents into this brief. Report: <what you need to know>, as a short status, not a verbatim excerpt."
  ```
- **`plan-execution` implementation:** paste the plan (or, if it's long relative to
  a local model's small context budget, its current phase only) and forbid
  improvisation:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" delegate --worker qwen --role worker --driver <self> \
    "Implement EXACTLY the following plan. Do not redesign, do not add anything not listed, do not skip steps. If a step is unclear or the codebase doesn't match what the plan expects, stop and report that instead of improvising.

    <paste the plan or its current phase>

    When done, self-report against the plan's own stated verification/test steps — which passed, which didn't."
  ```

## Anti-patterns (qwen-specific)

- Pasting sensitive file contents into a `local-only` brief instead of a path —
  defeats the containment before qwen even starts.
- Using qwen for open-ended work outside `local-only`/`plan-execution` — it's not
  in `recommend`'s default rotation for a reason: local 9-30B models are
  meaningfully weaker than the frontier cloud harnesses at general reasoning.
- Assuming a qwen failure will fall back to another harness — it won't (by
  design); a `local-only`/`plan-execution` job either succeeds on qwen or
  surfaces as failed/blocked.
- Expecting fast turnaround — local inference is materially slower than the cloud
  harnesses, and LM Studio serves one model at a time (concurrent qwen jobs queue).
- Expecting one-shot clean output — real-world testing found qwen's underlying
  work (edits, tests) correct far more often than its final JSON status was
  well-formed on the first try. Budget for a repair round as the norm.
