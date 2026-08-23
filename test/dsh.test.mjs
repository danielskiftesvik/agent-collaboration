import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import dsh from "../adapters/dsh.mjs";

function stubBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bin-"));
  const file = path.join(dir, "stub.mjs");
  fs.writeFileSync(file, body);
  const sh = path.join(dir, "stub");
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${process.execPath} ${file} "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

function clearEnv() {
  delete process.env.AGENT_COLLAB_DSH_BIN;
  delete process.env.AGENT_COLLAB_DSH_MODEL;
  delete process.env.AGENT_COLLAB_DSH_MODEL_REVIEW;
  delete process.env.DSH_HOME;
}

test("name and structured output support", () => {
  assert.equal(dsh.name, "dsh");
  assert.equal(dsh.supportsStructuredOutput, false);
});

test("buildCommand uses --profile headless and the brief as the task", () => {
  clearEnv();
  const { command, args, env } = dsh.buildCommand({
    role: "worker",
    brief: "do the thing",
    workspace: "/tmp/wt"
  });
  assert.equal(command, "dsh");
  assert.equal(args[0], "--profile");
  assert.equal(args[1], "headless");
  assert.equal(args[2], "do the thing");
  assert.equal(env.DSH_PERMISSION_MODE, "danger-full-access");
});

test("reviewer also uses danger-full-access (headless cannot prompt)", () => {
  clearEnv();
  const { env } = dsh.buildCommand({ role: "reviewer", brief: "review" });
  assert.equal(env.DSH_PERMISSION_MODE, "danger-full-access");
});

test("buildCommand honors AGENT_COLLAB_DSH_BIN and AGENT_COLLAB_DSH_MODEL", () => {
  clearEnv();
  process.env.AGENT_COLLAB_DSH_BIN = "/opt/dsh";
  process.env.AGENT_COLLAB_DSH_MODEL = "deepseek-v4-pro";
  const { command, env } = dsh.buildCommand({ role: "worker", brief: "x" });
  assert.equal(command, "/opt/dsh");
  assert.equal(env.AGENT_COLLAB_DSH_RESOLVED_MODEL, "deepseek-v4-pro");
  clearEnv();
});

test("AGENT_COLLAB_DSH_MODEL_REVIEW applies to reviewers only", () => {
  clearEnv();
  process.env.AGENT_COLLAB_DSH_MODEL_REVIEW = "deepseek-v4-pro";
  const reviewer = dsh.buildCommand({ role: "reviewer", brief: "x" });
  const worker = dsh.buildCommand({ role: "worker", brief: "x" });
  assert.equal(reviewer.env.AGENT_COLLAB_DSH_RESOLVED_MODEL, "deepseek-v4-pro");
  assert.equal(worker.env.AGENT_COLLAB_DSH_RESOLVED_MODEL, undefined);
  clearEnv();
});

test("parseOutput returns trimmed stdout as the answer", () => {
  const out = dsh.parseOutput({ stdout: "  hello from dsh\n" });
  assert.equal(out.answerText, "hello from dsh");
  assert.equal(out.structured, null);
});

test("outputContract is role-specific JSON", () => {
  assert.match(dsh.outputContract("reviewer"), /verdict/);
  assert.match(dsh.outputContract("worker"), /changed/);
});

test("progressDirs watches ~/.dsh/sessions (or $DSH_HOME/sessions)", () => {
  clearEnv();
  const dirs = dsh.progressDirs();
  assert.ok(dirs.some((d) => d.endsWith(path.join(".dsh", "sessions"))));
  process.env.DSH_HOME = "/tmp/custom-dsh-home";
  const custom = dsh.progressDirs();
  assert.ok(custom.some((d) => d === path.join("/tmp/custom-dsh-home", "sessions")));
  clearEnv();
});

test("probe reports available when the binary responds", () => {
  const stub = stubBin("process.stdout.write('dsh 0.1.0-rc.7\\n');");
  process.env.AGENT_COLLAB_DSH_BIN = stub;
  try {
    const p = dsh.probe();
    assert.equal(p.available, true);
    assert.match(p.version, /0\.1\.0-rc\.7/);
  } finally {
    clearEnv();
  }
});

test("probe reports unavailable for a missing binary", () => {
  process.env.AGENT_COLLAB_DSH_BIN = "/no/such/dsh-binary";
  try {
    const p = dsh.probe();
    assert.equal(p.available, false);
    assert.ok(p.error);
  } finally {
    clearEnv();
  }
});

test("unattendedProbe is ok (headless + danger-full-access)", () => {
  const u = dsh.unattendedProbe();
  assert.equal(u.ok, true);
  assert.match(u.detail, /headless/);
});
