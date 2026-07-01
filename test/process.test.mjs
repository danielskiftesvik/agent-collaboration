import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run, generateMacSandboxProfile } from "../core/process.mjs";

test("run captures stdout and a zero status", () => {
  const r = run("node", ["-e", "process.stdout.write('hi')"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "hi");
});

test("run returns a non-zero status without throwing", () => {
  const r = run("node", ["-e", "process.exit(3)"]);
  assert.equal(r.status, 3);
});

test("macOS profile is allow-default, denies secrets, allows harness config + workspace", () => {
  const home = process.env.HOME || os.homedir();
  const p = generateMacSandboxProfile("/work/ws", "/work/art");
  // allow-default base (deny-default crashes runtimes like agy's Go/Abseil)
  assert.match(p, /\(allow default\)/);
  // cross-cutting secrets unreadable
  assert.match(p, new RegExp(`deny file-read\\* \\(subpath "${home}/\\.ssh"`));
  // the harness's own state dir must stay writable (auth/logs)
  assert.match(p, new RegExp(`allow file-write\\* \\(subpath "${home}/\\.gemini"`));
  // work areas writable
  assert.match(p, /allow file\* \(subpath "\/work\/ws"/);
});

test("macOS profile allows writes under .qwen (qwen's own session/config state)", () => {
  const home = process.env.HOME || os.homedir();
  const p = generateMacSandboxProfile("/work/ws", "/work/art");
  assert.match(p, new RegExp(`allow file-write\\* \\(subpath "${home}/\\.qwen"`));
});

test("profile interpolation escapes quotes in paths (no profile injection)", () => {
  const p = generateMacSandboxProfile('/work/a"b', "/work/art");
  assert.match(p, /subpath "\/work\/a\\"b"/, "a quote in the path must be escaped");
});

test("STRICT profile denies file-write by default and allows only the work area", () => {
  const p = generateMacSandboxProfile("/work/ws", "/work/art", { strict: true });
  assert.match(p, /\(deny file-write\*\)/, "writes denied by default");
  assert.match(p, /allow file-write\* \(subpath "\/work\/ws"/, "workspace writable");
  assert.match(p, /allow file-write\* \(subpath "\/work\/art"/, "artifactDir writable");
});

test("run reports sandboxApplied true on darwin, null when not requested", () => {
  const plain = run("node", ["-e", "0"]);
  assert.equal(plain.sandboxApplied, null, "not requested => null");
  if (os.platform() === "darwin") {
    const r = run("node", ["-e", "0"], { sandbox: true, sandboxWorkspace: os.tmpdir(), sandboxArtifactDir: os.tmpdir() });
    assert.equal(r.sandboxApplied, true);
  }
});

test("STRICT sandbox blocks a /tmp escape that the default profile would allow", () => {
  if (os.platform() !== "darwin") return;
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sbstrict-")));
  const target = "/tmp/agent-collab-strict-escape-DELETEME.txt";
  try { fs.unlinkSync(target); } catch {}
  const code = `import fs from 'node:fs'; try { fs.writeFileSync(${JSON.stringify(target)}, 'x'); console.log('WROTE'); } catch (e) { console.log('DENIED'); }`;
  const r = run("node", ["-e", code], { sandbox: true, sandboxStrict: true, sandboxWorkspace: ws, sandboxArtifactDir: ws });
  assert.match(r.stdout, /DENIED/, "strict profile must deny a /tmp write");
  assert.equal(fs.existsSync(target), false);
  try { fs.unlinkSync(target); } catch {}
});

test("a normal workload still SUCCEEDS under the sandbox (not just blocked secrets)", () => {
  if (os.platform() !== "darwin") return;
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sbok-")));
  const r = run(
    "node",
    ["-e", `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ws + "/ok.txt")}, 'x'); console.log('OK')`],
    { sandbox: true, sandboxWorkspace: ws, sandboxArtifactDir: ws }
  );
  assert.equal(r.status, 0, "workload must run + write to its workspace: " + r.stderr);
  assert.match(r.stdout, /OK/);
});

test("run with sandbox: true blocks read from sensitive path on macOS", () => {
  if (os.platform() !== "darwin") return;

  const sensitivePath = path.join(os.homedir(), ".ssh");
  // Execute a node command trying to read the sensitive path under sandbox-exec
  const r = run("node", ["-e", `import fs from 'node:fs'; fs.readdirSync('${sensitivePath.replace(/\\/g, "\\\\")}')`], {
    sandbox: true,
    sandboxWorkspace: os.tmpdir(),
    sandboxArtifactDir: os.tmpdir()
  });

  // The command should exit with non-zero (or throw inside the child process, resulting in exit status > 0)
  assert.notEqual(r.status, 0, "should be denied access to ~/.ssh");
});

