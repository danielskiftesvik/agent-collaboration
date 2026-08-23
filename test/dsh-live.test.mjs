// Live DeepSeek Harness checks. Cheap probe runs when `dsh` is on PATH.
// The doctor review+isolation cycle spends model usage — opt in with
// AGENT_COLLAB_LIVE_DSH=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import dsh from "../adapters/dsh.mjs";
import { apply } from "../.dsh-plugin/index.js";
import { runDoctor } from "../core/doctor.mjs";
import { detectDriver } from "../core/dispatch.mjs";
import { isolateStateRoot } from "./helpers.mjs";

function dshOnPath() {
  const r = spawnSync("dsh", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

test("real dsh binary probes worker-ready when installed", (t) => {
  if (!dshOnPath()) {
    t.skip("dsh not on PATH");
    return;
  }
  const p = dsh.probe();
  assert.equal(p.available, true, p.error);
  assert.match(p.version, /\d+/);
  const u = dsh.unattendedProbe();
  assert.equal(u.ok, true);
});

test("Cordis /ac handler runs setup against the real companion", (t) => {
  if (!dshOnPath()) {
    t.skip("dsh not on PATH");
    return;
  }
  const prevRoot = process.env.DSH_PLUGIN_ROOT;
  let registered;
  try {
    apply({ commands: { register(def) { registered = def; } } });
    const result = registered.handler({ rawInput: "setup --json" });
    assert.equal(result.kind, "ok", result.text);
    const rows = JSON.parse(result.text.match(/\[[\s\S]*\]/)[0]);
    const row = rows.find((r) => r.name === "dsh");
    assert.equal(row?.available, true);
    assert.equal(row?.validWorker, true);
    assert.equal(detectDriver({ DSH_PLUGIN_ROOT: process.cwd() }), "dsh");
  } finally {
    if (prevRoot === undefined) delete process.env.DSH_PLUGIN_ROOT;
    else process.env.DSH_PLUGIN_ROOT = prevRoot;
  }
});

test("live doctor: dsh review is valid and the write-worker stays confined", async (t) => {
  if (process.env.AGENT_COLLAB_LIVE_DSH !== "1") {
    t.skip("set AGENT_COLLAB_LIVE_DSH=1 to spend model usage on a live dsh cycle");
    return;
  }
  if (!dshOnPath()) {
    t.skip("dsh not on PATH");
    return;
  }
  isolateStateRoot();
  const report = runDoctor(process.cwd(), { live: true, workers: ["dsh"] });
  const review = report.checks.find((c) => c.name === "review:dsh");
  const isolation = report.checks.find((c) => c.name === "isolation:dsh");
  assert.equal(review?.ok, true, JSON.stringify(review));
  assert.equal(isolation?.ok, true, JSON.stringify(isolation));
  assert.equal(isolation?.warn, false, isolation?.detail);
});
