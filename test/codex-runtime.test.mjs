import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLEANUP = fileURLToPath(new URL("../scripts/cleanup-codex-broker.mjs", import.meta.url));

test("codex broker cleanup uses the companion lifecycle and scoped state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-cleanup-"));
  const scriptsDir = path.join(root, "scripts");
  const libDir = path.join(scriptsDir, "lib");
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const marker = path.join(root, "cleanup.marker");
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  const companion = path.join(scriptsDir, "codex-companion.mjs");
  fs.writeFileSync(companion, "// fake codex companion\n");
  fs.writeFileSync(
    path.join(libDir, "broker-lifecycle.mjs"),
    `
      import fs from 'node:fs';
      const mark = (line) => fs.appendFileSync(process.env.AC_CLEANUP_MARKER, line + '\\n');
      export function loadBrokerSession(cwd) {
        mark('load:' + cwd + ':' + process.env.CLAUDE_PLUGIN_DATA);
        return { pid: 12345, endpoint: 'broker.sock', cwd };
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

  const result = spawnSync(
    process.execPath,
    [CLEANUP, "--companion", companion, "--workspace", workspace, "--plugin-data", pluginData],
    {
      encoding: "utf8",
      env: { ...process.env, AC_CLEANUP_MARKER: marker }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.cleaned, true);
  const lines = fs.readFileSync(marker, "utf8");
  assert.match(lines, new RegExp(`load:${workspace.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:${pluginData.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  assert.match(lines, /shutdown:broker\.sock/);
  assert.match(lines, /teardown:12345/);
  assert.match(lines, /kill:12345/);
  assert.match(lines, /clear:/);
});

test("codex broker cleanup is a successful no-op for companion stubs without broker helpers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-cleanup-stub-"));
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  const companion = path.join(scriptsDir, "codex-companion.mjs");
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(workspace);
  fs.mkdirSync(pluginData);
  fs.writeFileSync(companion, "// test stub\n");

  const result = spawnSync(
    process.execPath,
    [CLEANUP, "--companion", companion, "--workspace", workspace, "--plugin-data", pluginData],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cleaned: false, reason: "broker lifecycle helpers unavailable" });
});

test("codex broker cleanup still tears down when graceful shutdown never answers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-cleanup-hung-"));
  const scriptsDir = path.join(root, "scripts");
  const libDir = path.join(scriptsDir, "lib");
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  const marker = path.join(root, "cleanup.marker");
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(workspace);
  fs.mkdirSync(pluginData);
  const companion = path.join(scriptsDir, "codex-companion.mjs");
  fs.writeFileSync(companion, "// fake codex companion\n");
  fs.writeFileSync(
    path.join(libDir, "broker-lifecycle.mjs"),
    `
      import fs from 'node:fs';
      const mark = (line) => fs.appendFileSync(process.env.AC_CLEANUP_MARKER, line + '\\n');
      export function loadBrokerSession(cwd) { return { pid: 99, endpoint: 'hung.sock', cwd }; }
      export async function sendBrokerShutdown() { await new Promise(() => {}); }
      export function teardownBrokerSession({ pid, killProcess }) { mark('teardown:' + pid); killProcess(pid); }
      export function clearBrokerSession(cwd) { mark('clear:' + cwd); }
    `
  );
  fs.writeFileSync(
    path.join(libDir, "process.mjs"),
    `
      import fs from 'node:fs';
      export function terminateProcessTree(pid) { fs.appendFileSync(process.env.AC_CLEANUP_MARKER, 'kill:' + pid + '\\n'); }
    `
  );

  const result = spawnSync(
    process.execPath,
    [CLEANUP, "--companion", companion, "--workspace", workspace, "--plugin-data", pluginData],
    {
      encoding: "utf8",
      timeout: 2500,
      env: { ...process.env, AC_CLEANUP_MARKER: marker }
    }
  );

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(fs.readFileSync(marker, "utf8"), /teardown:99/);
  assert.match(fs.readFileSync(marker, "utf8"), /clear:/);
});
