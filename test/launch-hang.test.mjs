import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeRepo, isolateStateRoot, stubBin } from "./helpers.mjs";
import { run } from "../core/process.mjs";
import { runWithFallback } from "../core/dispatch.mjs";
import { collectGarbage, cleanupJobWorktree } from "../core/gc.mjs";
import { worktreesDir } from "../core/workspace.mjs";
import { appendJob, loadState, saveState } from "../core/state.mjs";

const CLI = fileURLToPath(new URL("../scripts/agent-companion.mjs", import.meta.url));
const HANG = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);`;

const WRITE_STUB = `
import fs from 'node:fs';
if (process.argv.includes('models')) { process.stdout.write('Gemini 3.5 Flash (High)'); process.exit(0); }
fs.writeFileSync('worker-was-here.txt', 'hi from worker\\n');
process.stdout.write('Done.\\n\\n\`\`\`json\\n{"status":"completed","summary":"made a file","changed":true}\\n\`\`\`\\n');
`;

function hungBin() {
  return stubBin(HANG);
}

test("run applies a default timeout when idle-guard is not used", { timeout: 4000 }, () => {
  const prev = process.env.AGENT_COLLAB_CMD_TIMEOUT_MS;
  process.env.AGENT_COLLAB_CMD_TIMEOUT_MS = "400";
  const t0 = Date.now();
  let r;
  try {
    r = run(process.execPath, ["-e", HANG]);
  } finally {
    if (prev === undefined) delete process.env.AGENT_COLLAB_CMD_TIMEOUT_MS;
    else process.env.AGENT_COLLAB_CMD_TIMEOUT_MS = prev;
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 2500, `default timeout should kill a hung command, took ${ms}ms`);
  assert.equal(r.error?.code, "ETIMEDOUT");
});

test("runWithFallback with empty fallbackKinds does not probe sibling harnesses", { timeout: 8000 }, () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);
  process.env.AGENT_COLLAB_DSH_BIN = hungBin();
  process.env.AGENT_COLLAB_CMD_TIMEOUT_MS = "15000";
  const t0 = Date.now();
  let res;
  try {
    res = runWithFallback(repo, {
      driver: "claude",
      worker: "agy",
      role: "worker",
      brief: "make a file",
      fallbackKinds: new Set(),
      maxAttempts: 1
    });
  } finally {
    delete process.env.AGENT_COLLAB_AGY_BIN;
    delete process.env.AGENT_COLLAB_DSH_BIN;
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 6000, `--no-fallback must not wait on a hung sibling probe, took ${ms}ms`);
  assert.notEqual(res.status, undefined);
  assert.notEqual(res.failureKind, "timeout");
});

test("delegate --no-fallback writes a pre-registration launch log to stderr", { timeout: 15000 }, () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);
  process.env.AGENT_COLLAB_DSH_BIN = hungBin();
  const r = run(
    process.execPath,
    [CLI, "delegate", "--worker", "agy", "--driver", "claude", "--no-fallback", "--timeout", "8", "make a file"],
    {
      cwd: repo,
      env: { ...process.env, AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_LAUNCH_GC: "off", AGENT_COLLAB_VERBOSE: "on" },
      timeout: 12000
    }
  );
  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_DSH_BIN;
  assert.match(r.stderr, /agent-collab \S+ .*start/, "launch must log before task registration so a hang is observable");
});

test("collector unlinks an out-of-root symlink without deleting the target", () => {
  isolateStateRoot();
  const repo = makeRepo();
  saveState(repo, loadState(repo));
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), "ac-live-tree-"));
  fs.writeFileSync(path.join(victim, "keep-me.txt"), "live\n");
  const root = worktreesDir(repo);
  fs.mkdirSync(root, { recursive: true });
  const link = path.join(root, "escaped-link");
  fs.symlinkSync(victim, link);
  appendJob(repo, { id: "escaped-link", status: "completed", workspace: link });

  const result = collectGarbage(repo, { artifactRetentionDays: 0 });

  assert.equal(fs.existsSync(path.join(victim, "keep-me.txt")), true, "must not follow the symlink into a live tree");
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink(), undefined);
  assert.ok(
    result.worktrees.removed.some((item) => item.id === "escaped-link") ||
      result.worktrees.skipped.some((item) => item.id === "escaped-link" && /symlink|outside/i.test(item.reason ?? "")),
    "GC must account for the out-of-root symlink"
  );
  const viaCleanup = cleanupJobWorktree(repo, { id: "escaped-link", status: "completed", workspace: link });
  assert.notEqual(viaCleanup.reason, undefined);
  fs.rmSync(victim, { recursive: true, force: true });
});
