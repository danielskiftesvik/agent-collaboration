import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isolateStateRoot, real } from "./helpers.mjs";
import {
  loadState,
  appendJob,
  getJob,
  updateJob,
  listJobs,
  resolveStateDir,
  MAX_JOBS
} from "../core/state.mjs";

function tmpCwd() {
  return real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-cwd-")));
}

test("state dir ignores a SIBLING plugin's CLAUDE_PLUGIN_DATA", () => {
  // In a multi-plugin session CLAUDE_PLUGIN_DATA may point at another plugin's
  // dir (observed: codex's). Nesting our state there cross-namespaces it and makes
  // jobs invisible across contexts. We must not reuse a sibling's dir.
  const savedData = process.env.AGENT_COLLAB_DATA;
  const savedPlugin = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.AGENT_COLLAB_DATA;

  process.env.CLAUDE_PLUGIN_DATA = "/x/plugins/data/codex-openai-codex";
  assert.ok(
    !resolveStateDir("/tmp/whatever").includes("codex-openai-codex"),
    "must not nest under a sibling plugin's data dir"
  );

  process.env.CLAUDE_PLUGIN_DATA = "/x/plugins/data/agent-collaboration";
  assert.ok(
    resolveStateDir("/tmp/whatever").includes("agent-collaboration"),
    "our OWN plugin data dir is fine to reuse"
  );

  if (savedData === undefined) delete process.env.AGENT_COLLAB_DATA;
  else process.env.AGENT_COLLAB_DATA = savedData;
  if (savedPlugin === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = savedPlugin;
});

test("loadState returns defaults when nothing is saved", () => {
  isolateStateRoot();
  const cwd = tmpCwd();
  const state = loadState(cwd);
  assert.equal(state.config.stopReviewGate, false);
  assert.deepEqual(state.jobs, []);
});

test("appendJob then getJob round-trips and stamps timestamps", () => {
  isolateStateRoot();
  const cwd = tmpCwd();
  const job = appendJob(cwd, { id: "job-1", worker: "agy", status: "running" });
  assert.equal(job.createdAt !== undefined, true);
  assert.equal(job.updatedAt !== undefined, true);

  const fetched = getJob(cwd, "job-1");
  assert.equal(fetched.worker, "agy");
  assert.equal(fetched.status, "running");
});

test("updateJob merges a patch and bumps updatedAt", () => {
  isolateStateRoot();
  const cwd = tmpCwd();
  const created = appendJob(cwd, { id: "job-2", status: "running" });
  const updated = updateJob(cwd, "job-2", { status: "completed", exitCode: 0 });
  assert.equal(updated.status, "completed");
  assert.equal(updated.exitCode, 0);
  assert.ok(updated.updatedAt >= created.updatedAt);
});

test("appendJob prunes to the newest MAX_JOBS records", () => {
  isolateStateRoot();
  const cwd = tmpCwd();
  for (let i = 0; i < MAX_JOBS + 5; i++) {
    appendJob(cwd, { id: `job-${i}`, status: "completed" });
  }
  const jobs = listJobs(cwd);
  assert.equal(jobs.length, MAX_JOBS);
  // Oldest five dropped; newest retained.
  assert.equal(getJob(cwd, "job-0"), undefined);
  assert.ok(getJob(cwd, `job-${MAX_JOBS + 4}`));
});

test("a corrupt state file degrades to defaults instead of throwing", () => {
  const root = isolateStateRoot();
  const cwd = tmpCwd();
  appendJob(cwd, { id: "x", status: "running" }); // creates the dir + file
  // Corrupt every state.json under the isolated root.
  for (const dir of fs.readdirSync(root)) {
    const f = path.join(root, dir, "state.json");
    if (fs.existsSync(f)) fs.writeFileSync(f, "{ not json");
  }
  const state = loadState(cwd);
  assert.deepEqual(state.jobs, []);
});
