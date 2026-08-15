import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = path.join(ROOT, "skills");

function readSkill(name) {
  return fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
}

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, "SKILL.md must have YAML frontmatter");
  const block = m[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description, body: md.slice(m[0].length) };
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const FLEET = ["peer-fleet", "assigning-across-machines", "receiving-peer-assign"];

test("fleet skill set exists with Use-when descriptions", () => {
  for (const name of FLEET) {
    const md = readSkill(name);
    const fm = frontmatter(md);
    assert.equal(fm.name, name);
    assert.match(fm.description, /^Use when /);
    assert.ok(fm.description.length < 500, `${name} description too long`);
    assert.ok(wordCount(md) < 500, `${name} is ${wordCount(md)} words; keep under 500`);
  }
});

test("peer-fleet differentiates job plane from peer plane", () => {
  const md = readSkill("peer-fleet");
  assert.match(md, /delegate/);
  assert.match(md, /review/);
  assert.match(md, /apply/);
  assert.match(md, /peers assign/);
  assert.match(md, /Job plane|job plane/);
  assert.match(md, /Peer plane|peer plane/);
  assert.match(md, /hint-harness|hintHarness/);
  assert.doesNotMatch(md, /just use delegate for another machine/i);
  assert.match(md, /\/collab/);
  assert.match(md, /lineage/);
});

test("assigning-across-machines uses a short-brief recipe and hint-harness", () => {
  const md = readSkill("assigning-across-machines");
  assert.match(md, /--hint-harness/);
  assert.match(md, /--harness/);
  assert.match(md, /one (line|sentence)/i);
  assert.match(md, /peer-fleet/);
  assert.doesNotMatch(md, /dispatch\.mjs/);
});

test("receiving-peer-assign keeps implement on this machine and requires an outcome block", () => {
  const md = readSkill("receiving-peer-assign");
  assert.match(md, /assign <id> done/);
  assert.match(md, /kind: ping/);
  assert.match(md, /PEER_ACK|wake-only/);
  assert.match(md, /delegate/);
  assert.match(md, /this (computer|machine)|stays here/i);
});

test("agent-collaboration skill forks to peer-fleet instead of treating assign as delegate", () => {
  const md = readSkill("agent-collaboration");
  assert.match(md, /peer-fleet/);
  assert.match(md, /Job plane|job plane|Two planes/i);
  assert.match(md, /not `delegate`|not delegate|is not `delegate`/i);
});

test("companion-runtime lists fleet assign flags and lineage", () => {
  const md = readSkill("companion-runtime");
  assert.match(md, /--hint-harness/);
  assert.match(md, /peers lineage/);
  assert.match(md, /peer-fleet/);
});
