import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const readText = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

test("ships example CLAUDE.md and AGENTS.md autonomous-wiring templates", () => {
  for (const f of ["../examples/CLAUDE.md", "../examples/AGENTS.md"]) {
    const t = readText(f);
    assert.match(t, /recommend/, `${f} mentions strength routing`);
    assert.match(t, /collaborative-investigation/, `${f} mentions the gate`);
    assert.match(t, /boundary/i, `${f} has a project boundary-code placeholder`);
  }
});

test("CLAUDE.md defaults the second opinion to codex; AGENTS.md to claude", () => {
  assert.match(readText("../examples/CLAUDE.md"), /codex/);
  assert.match(readText("../examples/AGENTS.md"), /claude/);
});

test("ships a Codex auto-review TOML example for agy review egress", () => {
  const t = readText("../examples/codex-auto-review-policy.toml");
  assert.match(t, /approvals_reviewer = "auto_review"/);
  assert.match(t, /Allowed worker: agy/);
  assert.match(t, /Deny:/);
  assert.doesNotMatch(t, /prspctv|nbfcqrtwxevypgtsysqr|supabase/i);
});

test("runtime guidance keeps exact job ids and treats --latest as lost-launch recovery only", () => {
  for (const f of [
    "../skills/agent-collaboration/SKILL.md",
    "../skills/companion-runtime/SKILL.md",
    "../skills/result-handling/SKILL.md"
  ]) {
    const t = readText(f);
    assert.match(t, /exact job id/i, `${f} requires exact job ids`);
    assert.match(t, /--latest[^\n]*(lost|recovery)|lost[^\n]*--latest/i, `${f} limits --latest to recovery`);
  }
  const cancel = readText("../commands/cancel.md");
  assert.match(cancel, /--force/);
  assert.match(cancel, /healthy|within-budget/i);
});
