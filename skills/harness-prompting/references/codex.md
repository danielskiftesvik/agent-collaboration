# Prompting codex

Adapted from codex-plugin-cc's `gpt-5-4-prompting` skill (Apache-2.0).

Prompt Codex like an operator, not a collaborator. Keep prompts compact and
block-structured with XML tags. State the task, the output contract, the
follow-through defaults, and the few extra constraints that matter.

- One clear task per run; split unrelated asks into separate runs.
- Tell Codex what "done" looks like — don't assume it infers the end state.
- Prefer a better prompt contract over raising reasoning or adding long prose.
- Use stable XML tag names that match [prompt-blocks.md](prompt-blocks.md).
- Codex reliably honors a `<structured_output_contract>` for JSON — good for
  **both reviewer and worker** roles. (The companion fills `{{OUTPUT_CONTRACT}}`
  in review templates with a codex-tuned XML block.)

When to add blocks:
- Coding/debugging: `completeness_contract`, `verification_loop`, `missing_context_gating`.
- Review/adversarial: `grounding_rules`, `structured_output_contract`, `dig_deeper_nudge`.
- Research/recommendation: `research_mode`, `citation_rules`.
- Write-capable: `action_safety`.

## Recipes (copy the smallest that fits, then trim)

### Diagnosis
```xml
<task>Diagnose why the failing test/command breaks in this repo. Identify the most likely root cause.</task>
<compact_output_contract>Return: 1) most likely root cause 2) evidence 3) smallest safe next step</compact_output_contract>
<default_follow_through_policy>Keep going until the root cause is confident; only stop if a missing detail changes correctness.</default_follow_through_policy>
<verification_loop>Verify the root cause matches the observed evidence before finalizing.</verification_loop>
<missing_context_gating>Do not guess missing repo facts; state what remains unknown.</missing_context_gating>
```

### Narrow Fix
```xml
<task>Implement the smallest safe fix for the identified issue. Preserve behavior outside the failing path.</task>
<structured_output_contract>Return: 1) summary 2) touched files 3) verification performed 4) residual risks</structured_output_contract>
<completeness_contract>Resolve fully; do not stop after identifying the issue without applying the fix.</completeness_contract>
<verification_loop>Verify the fix matches requirements and the changed code is coherent.</verification_loop>
<action_safety>Keep changes tightly scoped; avoid unrelated refactors.</action_safety>
```

### Root-Cause Review
```xml
<task>Analyze this change for the most likely correctness/regression issues. Use the provided context only.</task>
<structured_output_contract>Return: 1) findings by severity 2) supporting evidence 3) brief next steps</structured_output_contract>
<grounding_rules>Ground every claim in the context/tool outputs; label inferences.</grounding_rules>
<dig_deeper_nudge>Check second-order failures, empty-state, retries, stale state, rollback paths.</dig_deeper_nudge>
```

### Research / Recommendation
```xml
<task>Research the options and recommend the best path.</task>
<structured_output_contract>Return: 1) observed facts 2) recommendation 3) tradeoffs 4) open questions</structured_output_contract>
<research_mode>Separate observed facts, inferences, and open questions; breadth first.</research_mode>
<citation_rules>Back claims with explicit source references; prefer primary sources.</citation_rules>
```

### Prompt-Patching
```xml
<task>Diagnose why this prompt underperforms and propose the smallest high-leverage improvements.</task>
<structured_output_contract>Return: 1) failure modes 2) root causes in the prompt 3) a revised prompt 4) why it's better</structured_output_contract>
<grounding_rules>Base the diagnosis on the prompt text and failure examples; don't invent failure modes.</grounding_rules>
```

## Anti-patterns
1. Vague framing ("take a look and let me know"). State the concrete job + end state.
2. Missing output contract ("investigate and report back").
3. No follow-through default ("debug this") — say whether to keep going or stop.
4. Asking for more reasoning ("think harder") instead of a tighter contract.
5. Mixing unrelated jobs into one run (review + fix + docs + roadmap).
6. Unsupported certainty — require claims grounded in context.
