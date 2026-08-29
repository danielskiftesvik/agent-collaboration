import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeRepo, addWorktree, isolateStateRoot, stubBin, real, git } from "./helpers.mjs";
import { run } from "../core/process.mjs";
import { appendJob, getJob, loadState, resolveStateDir, saveState, updateJob } from "../core/state.mjs";
import { headRef } from "../core/git.mjs";
import { createWorktree } from "../core/workspace.mjs";

const CLI = fileURLToPath(new URL("../scripts/agent-companion.mjs", import.meta.url));

function cli(args, { cwd, env } = {}) {
  return run(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
}

test("setup --json lists all adapters", () => {
  // Isolate HOME: ~/.agent-collaboration/config.json instance aliases
  // legitimately surface as extra setup rows on machines that configure
  // them (e.g. codex-business/codex-personal here), which is orthogonal
  // to the adapter list this test pins.
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "ac-home-"));
  const r = cli(["setup", "--json"], { env: { HOME: emptyHome } });
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(rows.map((x) => x.name).sort(), ["agy", "claude", "codex", "cursor", "dsh", "grok", "opencode", "qwen"]);
});

test("version --json reports runtime path and state dir", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const r = cli(["version", "--json"], { cwd: repo, env: { AGENT_COLLAB_DATA: dataDir } });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.name, "agent-collaboration");
  assert.match(v.runtimePath, /agent-companion\.mjs$/);
  assert.ok(v.stateDir.startsWith(dataDir), v.stateDir);
});

test("setup (human) prints a sandboxed-driver hint; --json stays pure JSON", () => {
  const human = cli(["setup"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /sandbox/i, "human output carries the escalation hint");
  const json = cli(["setup", "--json"]);
  assert.ok(Array.isArray(JSON.parse(json.stdout)), "--json output is still a pure array");
});

test("setup persists configurable artifact retention", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const r = cli(["setup", "--retention-days", "14", "--json"], {
    cwd: repo,
    env: { AGENT_COLLAB_DATA: dataDir }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadState(repo).config.artifactRetentionDays, 14);
});

test("gc --dry-run previews old artifacts without deleting them", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  saveState(repo, loadState(repo));
  const task = path.join(resolveStateDir(repo), "tasks", "old-review");
  fs.mkdirSync(path.join(task, "reports"), { recursive: true });
  fs.writeFileSync(path.join(task, "reports", "claude.md"), "saved review");
  const old = (Date.now() - 45 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(task, "reports", "claude.md"), old, old);
  fs.utimesSync(path.join(task, "reports"), old, old);
  fs.utimesSync(task, old, old);

  const r = cli(["gc", "--dry-run", "--artifacts-older-than", "30", "--json"], {
    cwd: repo,
    env: { AGENT_COLLAB_DATA: dataDir }
  });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.dryRun, true);
  assert.ok(result.artifacts.removed.some((item) => item.id === "old-review"));
  assert.equal(fs.existsSync(task), true);
});

test("recommend --profiles --json dumps the model profiles", () => {
  const r = cli(["recommend", "--profiles", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const profiles = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(profiles).sort(), ["agy", "claude", "codex", "cursor", "dsh", "grok", "opencode", "qwen"]);
  assert.ok(profiles.agy.strongerAt.length > 0);
  assert.ok(profiles.cursor.canWrite);
  assert.ok(profiles.opencode.explicitOnly);
  assert.ok(profiles.grok.explicitOnly);
  assert.ok(profiles.dsh.explicitOnly);
});

test("recommend --task --json returns a worker (or native) with a reason", () => {
  const r = cli(["recommend", "--task", "mechanical", "--driver", "claude", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout);
  assert.equal(rec.task, "mechanical");
  assert.ok(rec.worker || rec.mode === "native" || rec.mode === "none");
  assert.ok(typeof rec.reason === "string");
});

test("doctor --json reports checks and an overall ok", () => {
  const dataDir = isolateStateRoot();
  const r = cli(["doctor", "--json"], { env: { AGENT_COLLAB_DATA: dataDir } });
  const report = JSON.parse(r.stdout);
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.checks.find((c) => c.name === "node>=20"));
  assert.equal(typeof report.ok, "boolean");
  assert.equal(report.live, false);
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

test("each collaboration launch runs the safe worktree janitor", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const workspace = createWorktree(repo, "completed-debris", headRef(repo));
  appendJob(repo, {
    id: "completed-debris",
    worker: "agy",
    role: "reviewer",
    status: "completed",
    workspace
  });

  const r = cli(["delegate", "--driver", "claude", "--worker", "claude", "do a thing"], {
    cwd: repo,
    env: { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_LAUNCH_GC: "sync" }
  });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(getJob(repo, "completed-debris").worktreeCleanup.removed, true);
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

test("delegate --background returns immediately; status --wait blocks to completion", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const bin = stubBin(`
    import fs from 'node:fs';
    if (process.argv.includes('models')) { process.exit(0); }
    fs.writeFileSync('bg-was-here.txt', 'hi\\n');
    process.stdout.write('Done.\\n\\n\`\`\`json\\n{"status":"completed","summary":"made","changed":true}\\n\`\`\`');
  `);
  const env = { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_AGY_BIN: bin };

  const launch = cli(["delegate", "--driver", "claude", "--worker", "agy", "--background", "--json", "make a file"], { cwd: repo, env });
  assert.equal(launch.status, 0, launch.stderr);
  const l = JSON.parse(launch.stdout);
  assert.equal(l.status, "running");
  assert.equal(l.background, true);
  assert.ok(l.jobId);

  const waited = cli(["status", l.jobId, "--wait", "--timeout", "30", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  const j = JSON.parse(waited.stdout);
  assert.equal(j.status, "completed");
});

test("status supports --active and --recent filters", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const base = { worker: "claude", role: "reviewer", driver: "codex", artifactDir: dataDir };
  appendJob(repo, { ...base, id: "done", status: "completed" });
  appendJob(repo, { ...base, id: "run1", status: "running" });
  appendJob(repo, { ...base, id: "run2", status: "running" });

  const active = cli(["status", "--active", "--json"], { cwd: repo, env: { AGENT_COLLAB_DATA: dataDir } });
  assert.equal(active.status, 0, active.stderr);
  assert.deepEqual(new Set(JSON.parse(active.stdout).map((j) => j.id)), new Set(["run1", "run2"]));

  const recent = cli(["status", "--recent", "1", "--json"], { cwd: repo, env: { AGENT_COLLAB_DATA: dataDir } });
  assert.equal(recent.status, 0, recent.stderr);
  assert.equal(JSON.parse(recent.stdout).length, 1);
});

test("status/result --latest recover by createdAt with worker and role filters", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const env = { AGENT_COLLAB_DATA: dataDir };
  const addReview = ({ id, worker, role = "reviewer", createdAt, summary }) => {
    const artifactDir = path.join(dataDir, "artifacts", id);
    fs.mkdirSync(path.join(artifactDir, "outputs"), { recursive: true });
    fs.mkdirSync(path.join(artifactDir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "outputs", `${worker}.json`), JSON.stringify({ verdict: "approve", summary, findings: [] }));
    fs.writeFileSync(path.join(artifactDir, "reports", `${worker}.md`), summary);
    appendJob(repo, { id, worker, role, driver: "codex", status: "completed", artifactDir, createdAt, updatedAt: createdAt });
  };

  addReview({ id: "old-claude", worker: "claude", createdAt: "2026-07-10T08:00:00.000Z", summary: "old" });
  addReview({ id: "new-claude", worker: "claude", createdAt: "2026-07-10T09:00:00.000Z", summary: "new" });
  addReview({ id: "newer-agy", worker: "agy", createdAt: "2026-07-10T10:00:00.000Z", summary: "agy" });
  updateJob(repo, "old-claude", { note: "updated later" });

  const status = cli(["status", "--latest", "--worker", "claude", "--role", "reviewer", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).id, "new-claude", "updatedAt must not make an old job latest");

  const result = cli(["result", "--latest", "--worker", "claude", "--role", "reviewer", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const recovered = JSON.parse(result.stdout);
  assert.deepEqual(recovered.artifact, { verdict: "approve", summary: "new", findings: [] });
  assert.equal(recovered.job.id, "new-claude");
});

test("status and result are lock-free reads; --refresh explicitly updates liveness", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const artifactDir = path.join(dataDir, "artifacts", "dead");
  fs.mkdirSync(path.join(artifactDir, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(artifactDir, "reports"), { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "outputs", "claude.json"), JSON.stringify({ verdict: "approve", summary: "saved", findings: [] }));
  fs.writeFileSync(path.join(artifactDir, "reports", "claude.md"), "saved");
  appendJob(repo, {
    id: "dead",
    worker: "claude",
    role: "reviewer",
    driver: "codex",
    status: "running",
    pid: 2147483600,
    artifactDir
  });
  const env = { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_LOCK_TIMEOUT_MS: "30" };
  const lock = path.join(resolveStateDir(repo), ".lock");
  fs.writeFileSync(lock, "held");

  const status = cli(["status", "dead", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, "running");
  const result = cli(["result", "--latest", "--worker", "claude", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ready, false);
  assert.equal(JSON.parse(result.stdout).job.id, "dead");
  assert.equal(getJob(repo, "dead").status, "running", "read-only commands must not reap jobs");

  fs.unlinkSync(lock);
  const refreshed = cli(["status", "dead", "--refresh", "--json"], { cwd: repo, env });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).failureKind, "stalled");
  const recovered = cli(["result", "dead", "--json"], { cwd: repo, env });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).ready, true);
  assert.equal(JSON.parse(recovered.stdout).artifact.summary, "saved");
});

test("status projects live progress without mutating state; result says a running job is not ready", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const artifactDir = path.join(dataDir, "artifacts", "healthy-running");
  const progressFile = path.join(artifactDir, "logs", "progress.json");
  fs.mkdirSync(path.dirname(progressFile), { recursive: true });
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const progressAt = new Date(Date.now() - 1_000).toISOString();
  fs.writeFileSync(progressFile, JSON.stringify({ at: progressAt, kind: "stdout" }) + "\n");
  appendJob(repo, {
    id: "healthy-running",
    worker: "claude",
    role: "reviewer",
    driver: "codex",
    status: "running",
    pid: process.pid,
    artifactDir,
    progressFile,
    startedAt,
    heartbeatAt: startedAt,
    lastProgressAt: startedAt,
    lastProgressKind: "launch",
    idleMs: 600_000,
    timeoutMs: 1_200_000
  });
  const env = { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_LOCK_TIMEOUT_MS: "30" };
  const lock = path.join(resolveStateDir(repo), ".lock");
  fs.writeFileSync(lock, "held");

  const status = cli(["status", "healthy-running", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  const projected = JSON.parse(status.stdout);
  assert.equal(projected.status, "running");
  assert.equal(projected.health.live, true);
  assert.equal(projected.health.withinIdleBudget, true);
  assert.equal(projected.health.withinHardBudget, true);
  assert.equal(projected.health.stalled, false);
  assert.equal(projected.health.lastProgressAt, progressAt);
  assert.equal(projected.health.lastProgressKind, "stdout");
  assert.equal(getJob(repo, "healthy-running").lastProgressKind, "launch", "projection must stay lock-free");

  const result = cli(["result", "healthy-running", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const pending = JSON.parse(result.stdout);
  assert.equal(pending.ready, false);
  assert.equal(pending.job.id, "healthy-running");
  assert.equal(pending.health.live, true);
  assert.equal(pending.health.stalled, false);
  assert.equal(pending.waitCommand, "status healthy-running --wait");

  fs.unlinkSync(lock);
});

test("cancel refuses a healthy live job unless --force is explicit", (t) => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const bin = stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    process.stdout.write('Done.\\n\\n\`\`\`json\\n{"status":"completed","summary":"late","changed":false}\\n\`\`\`');
  `);
  const env = { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_AGY_BIN: bin };
  const launch = cli([
    "delegate", "--driver", "claude", "--worker", "agy", "--background", "--json", "wait"
  ], { cwd: repo, env });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  const workspaceDeadline = Date.now() + 15000;
  while (!getJob(repo, jobId)?.workspace && Date.now() < workspaceDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.ok(getJob(repo, jobId)?.workspace, "background child should record its isolated worktree");
  t.after(() => {
    const job = getJob(repo, jobId);
    if (!job?.pid) return;
    try { process.kill(-job.pid, "SIGKILL"); } catch {}
    try { process.kill(job.pid, "SIGKILL"); } catch {}
  });

  const refused = cli(["cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(refused.status, 2, refused.stderr);
  const refusal = JSON.parse(refused.stdout);
  assert.equal(refusal.cancelled, false);
  assert.equal(refusal.health.live, true);
  assert.equal(refusal.health.withinIdleBudget, true);
  assert.equal(refusal.health.withinHardBudget, true);
  assert.ok(refusal.health.idleSecondsRemaining > 0);
  assert.ok(refusal.health.hardSecondsRemaining > 0);
  assert.equal(refusal.waitCommand, `status ${jobId} --wait`);
  assert.equal(refusal.forceCommand, `cancel ${jobId} --force`);
  assert.equal(getJob(repo, jobId).status, "running");

  const forced = cli(["cancel", jobId, "--force", "--json"], { cwd: repo, env });
  assert.equal(forced.status, 0, forced.stderr);
  const cancelled = JSON.parse(forced.stdout);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.worktreeCleanup.removed, true, JSON.stringify(cancelled.worktreeCleanup));
  assert.equal(fs.existsSync(cancelled.workspace), false);
  assert.equal(getJob(repo, jobId).status, "cancelled");
});

test("cancel performs targeted codex broker cleanup", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const artifactDir = path.join(dataDir, "cancel-codex-artifact");
  fs.mkdirSync(artifactDir, { recursive: true });
  const companionRoot = fs.mkdtempSync(path.join(dataDir, "codex-companion-"));
  const scriptsDir = path.join(companionRoot, "scripts");
  const libDir = path.join(scriptsDir, "lib");
  fs.mkdirSync(libDir, { recursive: true });
  const companion = path.join(scriptsDir, "codex-companion.mjs");
  fs.writeFileSync(companion, "// fake codex companion\n");
  const marker = path.join(dataDir, "cancel-cleanup.marker");
  fs.writeFileSync(
    path.join(libDir, "broker-lifecycle.mjs"),
    `
      import fs from 'node:fs';
      const mark = (line) => fs.appendFileSync(process.env.AC_CLEANUP_MARKER, line + '\\n');
      export function loadBrokerSession(cwd) {
        mark('load:' + cwd + ':' + process.env.CLAUDE_PLUGIN_DATA);
        return { pid: 424242, endpoint: 'fake.sock', cwd };
      }
      export async function sendBrokerShutdown(endpoint) { mark('shutdown:' + endpoint); }
      export function teardownBrokerSession({ pid, killProcess }) { mark('teardown:' + pid); killProcess(pid); }
      export function clearBrokerSession(cwd) { mark('clear:' + cwd); }
    `
  );
  fs.writeFileSync(
    path.join(libDir, "process.mjs"),
    `
      import fs from 'node:fs';
      export function terminateProcessTree(pid) {
        fs.appendFileSync(process.env.AC_CLEANUP_MARKER, 'kill:' + pid + '\\n');
      }
    `
  );

  appendJob(repo, {
    id: "cancel-codex",
    driver: "claude",
    worker: "codex",
    role: "reviewer",
    status: "running",
    pid: null,
    workspace: repo,
    artifactDir,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    idleMs: 1,
    timeoutMs: 1
  });

  const result = cli(["cancel", "cancel-codex", "--json"], {
    cwd: repo,
    env: {
      AGENT_COLLAB_DATA: dataDir,
      AGENT_COLLAB_CODEX_COMPANION: companion,
      AC_CLEANUP_MARKER: marker
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const cancelled = JSON.parse(result.stdout);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.runtimeCleanup.attempted, true);
  assert.equal(cancelled.runtimeCleanup.ok, true);
  assert.match(fs.readFileSync(marker, "utf8"), /shutdown:fake\.sock/);
  assert.match(fs.readFileSync(marker, "utf8"), /teardown:424242/);
  assert.match(fs.readFileSync(marker, "utf8"), /clear:/);
});

test("status --refresh only refreshes jobs selected by --recent", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const base = { worker: "claude", role: "reviewer", driver: "codex", artifactDir: dataDir };
  appendJob(repo, {
    ...base,
    id: "old-running",
    status: "running",
    pid: 2147483600,
    createdAt: "2026-07-10T08:00:00.000Z",
    updatedAt: "2026-07-10T08:00:00.000Z"
  });
  appendJob(repo, {
    ...base,
    id: "new-completed",
    status: "completed",
    createdAt: "2026-07-10T09:00:00.000Z",
    updatedAt: "2026-07-10T09:00:00.000Z"
  });

  const r = cli(["status", "--recent", "1", "--refresh", "--json"], {
    cwd: repo,
    env: { AGENT_COLLAB_DATA: dataDir }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((job) => job.id), ["new-completed"]);
  assert.equal(getJob(repo, "old-running").status, "running");
});

test("apply never accepts --latest", () => {
  const repo = makeRepo();
  const r = cli(["apply", "--latest", "--json"], { cwd: repo, env: { AGENT_COLLAB_DATA: isolateStateRoot() } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /job id is required/i);
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
  const envelope = JSON.parse(got.stdout);
  assert.equal(envelope.artifact.verdict, "approve");
  assert.equal(envelope.job.status, "completed");
});

test("result envelope makes review provenance and warnings unavoidable", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const artifactDir = path.join(dataDir, "artifacts", "warned");
  fs.mkdirSync(path.join(artifactDir, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(artifactDir, "reports"), { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, "outputs", "claude.json"),
    JSON.stringify({ verdict: "approve", summary: "looks fine", findings: [] })
  );
  fs.writeFileSync(path.join(artifactDir, "reports", "claude.md"), "looks fine");
  appendJob(repo, {
    id: "warned",
    worker: "claude",
    role: "reviewer",
    driver: "codex",
    status: "completed",
    resultValid: true,
    artifactDir,
    note: "review surface was not captured",
    reviewContext: { stagedIntoWorktree: false, mainDirtyPathsAtLaunch: ["a.swift"] },
    breachWarning: { escapedPaths: ["b.swift"] },
    sandboxed: false
  });

  const got = cli(["result", "warned", "--json"], { cwd: repo, env: { AGENT_COLLAB_DATA: dataDir } });
  assert.equal(got.status, 0, got.stderr);
  const envelope = JSON.parse(got.stdout);
  assert.equal(envelope.job.note, "review surface was not captured");
  assert.deepEqual(envelope.job.reviewContext.mainDirtyPathsAtLaunch, ["a.swift"]);
  assert.deepEqual(envelope.job.breachWarning.escapedPaths, ["b.swift"]);
  assert.equal(envelope.artifact.verdict, "approve");

  const legacy = cli(["result", "warned", "--artifact-only", "--json"], {
    cwd: repo,
    env: { AGENT_COLLAB_DATA: dataDir }
  });
  assert.equal(JSON.parse(legacy.stdout).verdict, "approve");
});

test("review-followup ties a focused review job to the prior review", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const artifactDir = path.join(dataDir, "artifacts", "prior-review");
  fs.mkdirSync(path.join(artifactDir, "outputs"), { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, "outputs", "agy.json"),
    JSON.stringify({ verdict: "needs-attention", summary: "one bug", findings: [{ severity: "high", title: "bug" }] })
  );
  appendJob(repo, {
    id: "prior-review", worker: "agy", role: "reviewer", driver: "claude",
    status: "completed", resultValid: true, artifactDir
  });
  const bin = stubBin(
    `process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'approve',summary:'fixed',findings:[],next_steps:[]}) + '\\n\`\`\`')`
  );
  const env = { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_AGY_BIN: bin };

  const result = cli([
    "review-followup", "--job", "prior-review", "--driver", "claude",
    "--surface", "head", "--json", "Verify the focused fix."
  ], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.status, "completed");
  assert.equal(getJob(repo, response.jobId).followupOf, "prior-review");
});

test("review-followup rejects a prior review that did not complete", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  appendJob(repo, {
    id: "failed-review", worker: "agy", role: "reviewer", driver: "claude",
    status: "failed", resultValid: false, artifactDir: path.join(dataDir, "missing")
  });
  const result = cli([
    "review-followup", "--job", "failed-review", "--driver", "claude",
    "--surface", "head", "Verify the fix."
  ], { cwd: repo, env: { AGENT_COLLAB_DATA: dataDir } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a completed review/);
});

test("review --workers a,b reaches the dual branch (no --worker required)", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  // Bogus harness names: the dual branch must be REACHED (failing on
  // "unknown worker"), not rejected up front with "--worker <name> is required".
  const r = cli(["review", "--workers", "nopeA,nopeB", "--driver", "claude", "--json", "some diff"], {
    cwd: repo,
    env: { AGENT_COLLAB_DATA: dataDir }
  });
  assert.ok(!/--worker <name> is required/.test(r.stderr), r.stderr);
  assert.match(r.stderr + r.stdout, /unknown worker/i, "dual branch validates workers");
});

test("review --workers rejects --background and single-entry lists explicitly", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const bg = cli(["review", "--workers", "codex,agy", "--background", "--json", "x"], { cwd: repo, env: { AGENT_COLLAB_DATA: dataDir } });
  assert.match(bg.stderr, /does not support --background/);
  const one = cli(["review", "--workers", "codex", "--json", "x"], { cwd: repo, env: { AGENT_COLLAB_DATA: dataDir } });
  assert.match(one.stderr, /needs >=2/);
});

// ---- #1395 CLI guard. Guard-quality standard from the issue: these tests
// invoke `apply` with the working directory set to a PRIMARY checkout and
// assert refusal — a test that only exercised apply inside a linked
// worktree would have passed against the defective build. ----

const APPLY_DIFF = [
  "diff --git a/worker-was-here.txt b/worker-was-here.txt",
  "new file mode 100644",
  "index 0000000..9daeafb",
  "--- /dev/null",
  "+++ b/worker-was-here.txt",
  "@@ -0,0 +1 @@",
  "+hi from worker"
].join("\n") + "\n";

function fabricateApplyJob(repo, id, dataDir) {
  const artifact = fs.mkdtempSync(path.join(os.tmpdir(), "ac-apply-artifact-"));
  const patchPath = path.join(artifact, `${id}.diff`);
  fs.writeFileSync(patchPath, APPLY_DIFF);
  appendJob(repo, {
    id,
    worker: "agy",
    harness: "agy",
    role: "worker",
    status: "completed",
    artifactDir: artifact,
    patchPath
  });
  return { env: { AGENT_COLLAB_DATA: dataDir } };
}

test("apply invoked FROM the primary checkout refuses by default and lands nothing (#1395)", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const { env } = fabricateApplyJob(repo, "guard-primary", dataDir);

  const r = cli(["apply", "guard-primary"], { cwd: repo, env });

  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout + r.stderr, /primary checkout/);
  assert.equal(fs.existsSync(path.join(repo, "worker-was-here.txt")), false, "nothing may land on shared main");
  assert.equal(git(["status", "--porcelain"], repo), "", "the primary tree is untouched");
});

test("apply --force-primary opts into the primary checkout explicitly (#1395)", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const { env } = fabricateApplyJob(repo, "guard-optin", dataDir);

  const r = cli(["apply", "guard-optin", "--force-primary"], { cwd: repo, env });

  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(fs.readFileSync(path.join(repo, "worker-was-here.txt"), "utf8"), "hi from worker\n");
});

test("apply --target <linked-worktree> lands there while cwd stays primary, and names it (#1395)", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const wt = addWorktree(repo, "cli-target");
  const { env } = fabricateApplyJob(repo, "guard-target", dataDir);

  const r = cli(["apply", "guard-target", "--target", wt], { cwd: repo, env });

  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes(real(wt)), "the output names the resolved absolute target");
  assert.equal(fs.readFileSync(path.join(wt, "worker-was-here.txt"), "utf8"), "hi from worker\n");
  assert.equal(fs.existsSync(path.join(repo, "worker-was-here.txt")), false);
});

test("apply inside a LINKED worktree needs no flags at all (#1395 normal flow)", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const wt = addWorktree(repo, "cli-normal");
  const { env } = fabricateApplyJob(repo, "guard-normal", dataDir);

  const r = cli(["apply", "guard-normal"], { cwd: wt, env });

  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(fs.readFileSync(path.join(wt, "worker-was-here.txt"), "utf8"), "hi from worker\n");
});

test("delegate --background with an invalid --base exits NON-zero and prints no poll instruction (#1395 codex r2)", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  // A valid worker binary so the ONLY failure source is the base ref.
  const env = { AGENT_COLLAB_DATA: dataDir, AGENT_COLLAB_AGY_BIN: stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    process.stdout.write('ok');
  `) };

  const r = cli(["delegate", "--driver", "codex", "--worker", "agy", "--base", "no-such-ref", "--background", "--json", "x"], { cwd: repo, env });

  assert.equal(r.status, 2, `a refused dispatch must not exit 0 (got stdout=${r.stdout} stderr=${r.stderr})`);
  assert.match(r.stdout + r.stderr, /blocked/);
  assert.doesNotMatch(r.stdout + r.stderr, /Poll:/, "there is no job to poll — printing poll instructions would send automation into a loop");
});
