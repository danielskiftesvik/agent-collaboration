import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(p, import.meta.url))));

test("marketplace.json is a valid single-plugin catalog pointing at the repo root", () => {
  const m = read("../.claude-plugin/marketplace.json");
  assert.equal(typeof m.name, "string");
  assert.equal(typeof m.owner?.name, "string");
  assert.ok(Array.isArray(m.plugins) && m.plugins.length >= 1);
  const p = m.plugins.find((x) => x.name === "agent-collaboration");
  assert.ok(p, "lists the agent-collaboration plugin");
  assert.equal(p.source, ".", "plugin source is the repo root");
});

test("plugin.json name matches the marketplace entry", () => {
  assert.equal(read("../.claude-plugin/plugin.json").name, "agent-collaboration");
});

test("ships a .codex-plugin manifest for multi-harness install", () => {
  const cx = read("../.codex-plugin/plugin.json");
  assert.equal(cx.name, "agent-collaboration");
  assert.equal(cx.skills, "./skills/", "declares skills for Codex");
});
