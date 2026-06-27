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
