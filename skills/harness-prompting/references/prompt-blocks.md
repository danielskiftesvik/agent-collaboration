# Prompt Blocks

Reusable brief-construction blocks. Wrap each in the XML tag shown in its
heading and include only the ones the task needs.

Adapted from codex-plugin-cc's `gpt-5-4-prompting` skill (Apache-2.0,
Copyright 2026 OpenAI). The XML-block style is most effective for codex/GPT-5.x;
for agy/Gemini keep the same intent but lean on the adapter's emphatic
JSON-only output contract.

## Core wrapper

### `task`
Use in nearly every brief.
```xml
<task>
Describe the concrete job, the relevant repository or failure context, and the expected end state.
</task>
```

## Output and format

### `structured_output_contract`
Use when the response shape matters.
```xml
<structured_output_contract>
Return exactly the requested output shape and nothing else.
Keep it compact. Put the highest-value findings or decisions first.
</structured_output_contract>
```

### `compact_output_contract`
Use when you want concise prose instead of a schema.
```xml
<compact_output_contract>
Keep the final answer compact and structured. No long scene-setting or recap.
</compact_output_contract>
```

## Follow-through and completion

### `default_follow_through_policy`
```xml
<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going.
Only stop to ask when a missing detail changes correctness, safety, or an irreversible action.
</default_follow_through_policy>
```

### `completeness_contract`
```xml
<completeness_contract>
Resolve the task fully before stopping. Do not stop at the first plausible answer.
Check for follow-on fixes, edge cases, or cleanup needed for a correct result.
</completeness_contract>
```

### `verification_loop`
```xml
<verification_loop>
Before finalizing, verify the result against the task requirements and the changed files or tool outputs.
If a check fails, revise instead of reporting the first draft.
</verification_loop>
```

## Grounding and missing context

### `missing_context_gating`
```xml
<missing_context_gating>
Do not guess missing repository facts. Retrieve them with tools, or state exactly what remains unknown.
</missing_context_gating>
```

### `grounding_rules`
```xml
<grounding_rules>
Ground every claim in the provided context or your tool outputs.
Do not present inferences as facts. Label hypotheses clearly.
</grounding_rules>
```

### `citation_rules`
Use when external research or quotes matter.
```xml
<citation_rules>
Back important claims with explicit references to the sources you inspected. Prefer primary sources.
</citation_rules>
```

## Safety and scope

### `action_safety`
Use for write-capable tasks.
```xml
<action_safety>
Keep changes tightly scoped to the stated task.
Avoid unrelated refactors, renames, or cleanup unless required for correctness.
Call out any risky or irreversible action before taking it.
</action_safety>
```

### `tool_persistence_rules`
Use for long-running, tool-heavy tasks.
```xml
<tool_persistence_rules>
Keep using tools until you have enough evidence to finish confidently.
Do not abandon the workflow after a partial read when another targeted check would change the answer.
</tool_persistence_rules>
```

## Task-specific

### `research_mode`
```xml
<research_mode>
Separate observed facts, reasoned inferences, and open questions.
Prefer breadth first, then go deeper only where the evidence changes the recommendation.
</research_mode>
```

### `dig_deeper_nudge`
Use for review and adversarial inspection.
```xml
<dig_deeper_nudge>
After the first plausible issue, check for second-order failures, empty-state behavior, retries, stale state, and rollback paths before finalizing.
</dig_deeper_nudge>
```

### `progress_updates`
Use when the run may take a while.
```xml
<progress_updates>
If you provide progress updates, keep them brief and outcome-based. Mention only major phase changes or blockers.
</progress_updates>
```
