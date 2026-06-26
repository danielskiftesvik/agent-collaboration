// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Generate a macOS sandbox-exec profile.
 *
 * We use an ALLOW-default base and deny the specific risks. A DENY-default
 * profile crashes complex runtimes — agy's Go/Abseil allocator aborts with a
 * `LowLevelAlloc` overflow under deny-default. Allow-default still blocks the
 * real hazards (reading cross-cutting secrets, writing outside the workspace)
 * while letting the harness read its own config and authenticate.
 *
 * macOS sandbox is last-match-wins, so denies placed after `(allow default)`
 * take effect, and the work-area allows placed last re-open those paths.
 */
export function generateMacSandboxProfile(workspace, artifactDir) {
  const home = process.env.HOME || os.homedir();
  // Cross-cutting secrets that no worker should read.
  const secretDirs = [".ssh", ".aws", ".kube", ".gnupg"].map((d) => path.join(home, d));
  // The harness's own state dirs — needed for auth, logs, conversation history.
  const harnessDirs = [".gemini", ".claude", ".codex", ".config/gcloud"].map((d) =>
    path.join(home, d)
  );

  const lines = ["(version 1)", "(allow default)"];
  for (const d of secretDirs) lines.push(`(deny file-read* (subpath "${d}"))`);
  lines.push(`(deny file-read* file-write* (literal "${path.join(home, ".netrc")}"))`);
  // Block writes into the home tree (dotfiles/config) ...
  lines.push(`(deny file-write* (subpath "${home}"))`);
  // ... except the harness's own state dirs.
  for (const d of harnessDirs) lines.push(`(allow file-write* (subpath "${d}"))`);
  // Work areas (worktree + artifacts) are fully read/write.
  for (const p of [workspace, artifactDir]) lines.push(`(allow file* (subpath "${p}"))`);
  return lines.join("\n");
}

/** Check if bubblewrap is available on Linux. */
let isBwrapAvailableCached = null;
function isBwrapAvailable() {
  if (isBwrapAvailableCached !== null) return isBwrapAvailableCached;
  try {
    const r = spawnSync("which", ["bwrap"], { encoding: "utf8" });
    isBwrapAvailableCached = r.status === 0;
  } catch {
    isBwrapAvailableCached = false;
  }
  return isBwrapAvailableCached;
}

/** Run a command synchronously and return { status, stdout, stderr } without throwing. */
export function run(command, args = [], opts = {}) {
  let finalCommand = command;
  let finalArgs = args;
  let tempProfileFile = null;

  if (opts.sandbox) {
    const platform = os.platform();
    if (platform === "darwin") {
      const workspace = opts.sandboxWorkspace || opts.cwd || process.cwd();
      const artifactDir = opts.sandboxArtifactDir || workspace;
      const profile = generateMacSandboxProfile(workspace, artifactDir);

      const tempDir = os.tmpdir();
      const profileName = `sandbox-${Math.random().toString(36).substring(2)}.sb`;
      tempProfileFile = path.join(tempDir, profileName);
      fs.writeFileSync(tempProfileFile, profile, "utf8");

      finalCommand = "/usr/bin/sandbox-exec";
      finalArgs = ["-f", tempProfileFile, command, ...args];
    } else if (platform === "linux") {
      if (isBwrapAvailable()) {
        const workspace = opts.sandboxWorkspace || opts.cwd || process.cwd();
        const artifactDir = opts.sandboxArtifactDir || workspace;

        finalCommand = "bwrap";
        finalArgs = [
          "--ro-bind", "/usr", "/usr",
          "--ro-bind-try", "/lib", "/lib",
          "--ro-bind-try", "/lib64", "/lib64",
          "--ro-bind-try", "/bin", "/bin",
          "--ro-bind-try", "/sbin", "/sbin",
          "--ro-bind-try", "/etc", "/etc",
          "--ro-bind-try", "/var", "/var",
          "--ro-bind-try", "/run", "/run",
          "--ro-bind-try", "/sys", "/sys",
          "--ro-bind-try", "/proc", "/proc",
          "--ro-bind-try", "/dev", "/dev",
          "--dir", "/tmp",
          "--bind", workspace, workspace,
          "--bind", artifactDir, artifactDir,
          "--unshare-all",
          "--share-net",
          command,
          ...args
        ];
      } else {
        process.stderr.write("Warning: bubblewrap (bwrap) not found. Linux worker executed without sandbox isolation.\n");
      }
    }
  }

  const spawnOpts = { ...opts };
  delete spawnOpts.sandbox;
  delete spawnOpts.sandboxWorkspace;
  delete spawnOpts.sandboxArtifactDir;

  try {
    const result = spawnSync(finalCommand, finalArgs, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...spawnOpts
    });
    return {
      status: result.status ?? (result.signal ? -1 : null),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error
    };
  } finally {
    if (tempProfileFile && fs.existsSync(tempProfileFile)) {
      try {
        fs.unlinkSync(tempProfileFile);
      } catch {
        // ignore
      }
    }
  }
}

/** Like run, but throws when the command exits non-zero. Returns stdout. */
export function runOk(command, args = [], opts = {}) {
  const r = run(command, args, opts);
  if (r.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${r.status}: ${r.stderr || r.stdout}`
    );
  }
  return r.stdout;
}

