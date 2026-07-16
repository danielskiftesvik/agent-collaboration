import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const IDLE_GUARD = fileURLToPath(new URL("../scripts/idle-guard.mjs", import.meta.url));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("idle guard forwards cancellation to its detached worker process group", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-idle-cancel-"));
  const pidFile = path.join(dir, "worker.pid");
  const childCode = `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const guard = spawn(
    process.execPath,
    [IDLE_GUARD, "--idle", "60000", "--timeout", "60000", "--", process.execPath, "-e", childCode],
    { stdio: "ignore" }
  );
  let childPid = null;
  t.after(() => {
    try { process.kill(guard.pid, "SIGKILL"); } catch {}
    if (childPid) {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
  });

  assert.equal(await waitUntil(() => fs.existsSync(pidFile)), true, "worker must launch");
  childPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(alive(childPid), true);

  process.kill(guard.pid, "SIGTERM");
  assert.equal(await waitUntil(() => !alive(childPid), 3500), true, "worker must die with the guard");
});

test("idle guard exits after cancellation even when an escaped descendant holds worker pipes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-idle-pipe-holder-"));
  const holderPidFile = path.join(dir, "holder.pid");
  const childCode = `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    const holder = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: ['ignore', process.stdout, process.stderr] }
    );
    fs.writeFileSync(${JSON.stringify(holderPidFile)}, String(holder.pid));
    holder.unref();
  `;
  const guard = spawn(
    process.execPath,
    [IDLE_GUARD, "--idle", "60000", "--timeout", "60000", "--", process.execPath, "-e", childCode],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let holderPid = null;
  t.after(() => {
    try { process.kill(guard.pid, "SIGKILL"); } catch {}
    if (holderPid) {
      try { process.kill(-holderPid, "SIGKILL"); } catch {}
      try { process.kill(holderPid, "SIGKILL"); } catch {}
    }
  });

  assert.equal(await waitUntil(() => fs.existsSync(holderPidFile)), true, "escaped descendant must launch");
  holderPid = Number(fs.readFileSync(holderPidFile, "utf8"));
  assert.equal(alive(holderPid), true);

  const exited = new Promise((resolve) => guard.once("exit", () => resolve(true)));
  process.kill(guard.pid, "SIGTERM");
  const didExit = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(false), 3500))
  ]);

  assert.equal(didExit, true, "guard must not wait forever for pipes held by an escaped descendant");
});
