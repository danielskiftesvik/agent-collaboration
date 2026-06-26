import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { run } from "../core/process.mjs";

test("run captures stdout and a zero status", () => {
  const r = run("node", ["-e", "process.stdout.write('hi')"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "hi");
});

test("run returns a non-zero status without throwing", () => {
  const r = run("node", ["-e", "process.exit(3)"]);
  assert.equal(r.status, 3);
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

