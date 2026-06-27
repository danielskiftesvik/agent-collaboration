import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeRepo, isolateStateRoot, stubBin } from "./helpers.mjs";
import { run } from "../core/process.mjs";

const CLI = fileURLToPath(new URL("../scripts/agent-companion.mjs", import.meta.url));

function cli(args, { cwd, env } = {}) {
  return run(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
}

test("setup --json lists the three adapters", () => {
  const r = cli(["setup", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(rows.map((x) => x.name).sort(), ["agy", "claude", "codex"]);
});

test("setup (human) prints a sandboxed-driver hint; --json stays pure JSON", () => {
  const human = cli(["setup"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /sandbox/i, "human output carries the escalation hint");
  const json = cli(["setup", "--json"]);
  assert.ok(Array.isArray(JSON.parse(json.stdout)), "--json output is still a pure array");
});

test("recommend --profiles --json dumps the model profiles", () => {
  const r = cli(["recommend", "--profiles", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const profiles = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(profiles).sort(), ["agy", "claude", "codex"]);
  assert.ok(profiles.agy.strongerAt.length > 0);
});

test("recommend --task --json returns a worker (or native) with a reason", () => {
  const r = cli(["recommend", "--task", "mechanical", "--driver", "claude", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout);
  assert.equal(rec.task, "mechanical");
  assert.ok(rec.worker || rec.mode === "native" || rec.mode === "none");
  assert.ok(typeof rec.reason === "string");
});

test("delegate to the same harness returns the native-path instruction", () => {
  const r = cli(["delegate", "--driver", "claude", "--worker", "claude", "do a thing"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, "native");
  assert.match(out.instruction, /Agent tool/i);
});

test("raw delegate to claude with no --driver/env does NOT short-circuit to native", () => {
  // The Codex/agy raw-CLI footgun: without --driver the runtime used to default
  // driver=claude, so `--worker claude` looked like driver==worker and returned a
  // native no-op instead of actually delegating. A guessed driver must never do that.
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const claudeBin = stubBin(`
    import fs from 'node:fs';
    if (process.argv.includes('--version')) { process.stdout.write('claude 1.0.0'); process.exit(0); }
    fs.writeFileSync('done.txt','ok\\n');
    process.stdout.write(JSON.stringify({ result: 'ok\\n\\n\`\`\`json\\n{"status":"completed","summary":"did","changed":true}\\n\`\`\`' }));
  `);
  const env = {
    AGENT_COLLAB_DATA: dataDir,
    AGENT_COLLAB_CLAUDE_BIN: claudeBin,
    AGENT_COLLAB_DRIVER: "",
    CLAUDECODE: "",
    CLAUDE_CODE: "",
    CLAUDE_PLUGIN_ROOT: ""
  };

  const r = cli(["delegate", "--worker", "claude", "--json", "do it"], { cwd: repo, env });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.notEqual(res.mode, "native", "a fallback-guessed driver must not yield a native no-op");
  assert.equal(res.status, "completed");
  assert.equal(res.worker, "claude");
});

test("delegate to the same harness IS native when --driver is explicit (authoritative)", () => {
  const r = cli(["delegate", "--driver", "claude", "--worker", "claude", "do a thing"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, "native");
});

test("delegate auto-falls-back to another worker when the first is rate-limited", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const agyBin = stubBin(`
    if (process.argv.includes('--version')) { process.stdout.write('agy 1.0.0'); process.exit(0); }
    if (process.argv.includes('models')) { process.exit(0); }
    process.stderr.write('429 RESOURCE_EXHAUSTED quota; retry-after: 60'); process.exit(1);
  `);
  const claudeBin = stubBin(`
    import fs from 'node:fs';
    if (process.argv.includes('--version')) { process.stdout.write('claude 1.0.0'); process.exit(0); }
    fs.writeFileSync('done.txt','ok\\n');
    process.stdout.write(JSON.stringify({ result: 'Done.\\n\\n\`\`\`json\\n{"status":"completed","summary":"did it","changed":true}\\n\`\`\`' }));
  `);
  const env = { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_AGY_BIN: agyBin, AGENT_COLLAB_CLAUDE_BIN: claudeBin };

  const del = cli(["delegate", "--driver", "codex", "--worker", "agy", "--json", "do a thing"], { cwd: repo, env });
  assert.equal(del.status, 0, del.stderr);
  const res = JSON.parse(del.stdout);
  assert.equal(res.status, "completed");
  assert.equal(res.worker, "claude", "fell back to claude");
  assert.match(res.note, /agy/);
  assert.equal(res.fellBackFrom[0].failureKind, "rate-limit");
});

test("delegate cross-harness reviewer runs and result prints the artifact", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const bin = stubBin(
    `process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'approve',summary:'ok',findings:[],next_steps:[]}) + '\\n\`\`\`')`
  );
  const env = { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_AGY_BIN: bin };

  const del = cli(["delegate", "--driver", "claude", "--worker", "agy", "--role", "reviewer", "--json", "review please"], { cwd: repo, env });
  assert.equal(del.status, 0, del.stderr);
  const res = JSON.parse(del.stdout);
  assert.equal(res.status, "completed");
  assert.equal(res.valid, true);

  const got = cli(["result", res.jobId, "--json"], { cwd: repo, env });
  assert.equal(got.status, 0, got.stderr);
  const artifact = JSON.parse(got.stdout);
  assert.equal(artifact.verdict, "approve");
});
