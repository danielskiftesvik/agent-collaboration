import { test } from "node:test";
import assert from "node:assert/strict";

import { isolateStateRoot, stubBin } from "./helpers.mjs";
import { runDoctor } from "../core/doctor.mjs";

test("doctor (no --live) reports config + worker readiness", () => {
  isolateStateRoot();
  const r = runDoctor(process.cwd(), { live: false });
  assert.ok(r.checks.find((c) => c.name === "node>=20"));
  assert.equal(r.checks.find((c) => c.name === "state-dir-writable").ok, true);
  assert.equal(typeof r.ok, "boolean");
  assert.equal(r.live, false);
});

// agy stub: a clean, well-behaved harness — valid review, and a worker that creates
// the file INSIDE its worktree (cwd) only.
const CLEAN_AGY = `
  import fs from 'node:fs';
  if (process.argv.includes('--version')) { process.stdout.write('agy 1'); process.exit(0); }
  if (process.argv.includes('models')) { process.exit(0); }
  const brief = process.argv[process.argv.length - 1];
  if (/Review this change/i.test(brief)) {
    process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'needs-attention',summary:'bug',findings:[{severity:'high',title:'subtracts',body:'add() subtracts'}]}) + '\\n\`\`\`');
  } else {
    fs.writeFileSync('note.txt', 'ok\\n');
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"made note","changed":true}\\n\`\`\`');
  }
`;

test("doctor --live passes for a clean reviewer + confined worker", () => {
  isolateStateRoot();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(CLEAN_AGY);

  const r = runDoctor(process.cwd(), { live: true, workers: ["agy"] });

  assert.equal(r.checks.find((c) => c.name === "review:agy").ok, true);
  assert.equal(r.checks.find((c) => c.name === "isolation:agy").ok, true);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

// agy stub that ESCAPES: from its worktree it resolves the canonical checkout (via
// the git common-dir back-link, exactly like the real agy escape) and writes there.
const ESCAPING_AGY = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { execFileSync } from 'node:child_process';
  if (process.argv.includes('--version')) { process.stdout.write('agy 1'); process.exit(0); }
  if (process.argv.includes('models')) { process.exit(0); }
  const brief = process.argv[process.argv.length - 1];
  if (/Review this change/i.test(brief)) {
    process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'approve',summary:'ok',findings:[]}) + '\\n\`\`\`');
  } else {
    let common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    common = path.resolve(process.cwd(), common);
    const realRepo = path.dirname(common);
    fs.writeFileSync(path.join(realRepo, 'escaped.txt'), 'leaked\\n'); // escape the worktree
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"done","changed":false}\\n\`\`\`');
  }
`;

test("doctor --live FAILS the isolation check when the worker escapes its worktree", () => {
  isolateStateRoot();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(ESCAPING_AGY);

  const r = runDoctor(process.cwd(), { live: true, workers: ["agy"] });

  const isolation = r.checks.find((c) => c.name === "isolation:agy");
  assert.equal(isolation.ok, false, "an escape must fail the isolation check");
  assert.match(isolation.detail, /BREACH/);
  assert.equal(r.ok, false, "overall doctor fails when any check fails");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});
