import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

export function real(p) {
  return fs.realpathSync.native(p);
}

/** Create a throwaway git repo with one commit. Returns its canonical root. */
export function makeRepo(prefix = "ac-repo-") {
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

/** Add a linked worktree as a sibling dir. Returns its canonical path. */
export function addWorktree(repo, name) {
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}-${name}`);
  git(["worktree", "add", "-q", wt], repo);
  return real(wt);
}

/** Point state at a fresh temp dir so tests never touch real state. Also pins the
 *  OS sandbox OFF so worker tests are deterministic across environments (the sandbox
 *  policy + degradation are unit-tested separately; live confinement via doctor). */
export function isolateStateRoot() {
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-data-")));
  process.env.AGENT_COLLAB_DATA = dir;
  process.env.AGENT_COLLAB_SANDBOX = "off";
  return dir;
}

/** Create an executable stub that runs the given JS body via node. */
export function stubBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bin-"));
  const js = path.join(dir, "stub.mjs");
  fs.writeFileSync(js, body);
  const sh = path.join(dir, "stub");
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${process.execPath} ${js} "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}
