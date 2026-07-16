// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const IDLE_GUARD = fileURLToPath(new URL("../scripts/idle-guard.mjs", import.meta.url));

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
/** Escape a path for safe interpolation into a Scheme sandbox-profile string. */
function sbEsc(p) {
  return String(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function generateMacSandboxProfile(workspace, artifactDir, opts = {}) {
  const home = process.env.HOME || os.homedir();
  // Cross-cutting secrets that no worker should read.
  const secretDirs = [".ssh", ".aws", ".kube", ".gnupg"].map((d) => path.join(home, d));
  // The harness's own state dirs — needed for auth, logs, conversation history.
  const harnessDirs = [".gemini", ".claude", ".codex", ".config/gcloud", ".qwen"].map((d) =>
    path.join(home, d)
  );

  if (opts.strict) {
    // STRICT: deny FILE-WRITE by default (reads/process/mmap still allowed, so it
    // won't trip Go's LowLevelAlloc the way a full deny-default did). Writes are
    // confined to the work area + the process temp dir + the harness's own state,
    // so an escape to a real repo, /tmp, /etc, or another volume is denied.
    const writable = [workspace, artifactDir, os.tmpdir(), ...harnessDirs];
    const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
    for (const p of writable) lines.push(`(allow file-write* (subpath "${sbEsc(p)}"))`);
    for (const d of secretDirs) lines.push(`(deny file-read* (subpath "${sbEsc(d)}"))`);
    lines.push(`(deny file-read* file-write* (literal "${sbEsc(path.join(home, ".netrc"))}"))`);
    return lines.join("\n");
  }

  // DEFAULT (proven not to crash agy): allow-default, deny writes under $HOME
  // except the harness state + work dirs. Blocks the primary escape target (real
  // repos under $HOME) but still permits writes elsewhere (e.g. /tmp). Enable
  // `strict` for full work-area confinement.
  const lines = ["(version 1)", "(allow default)"];
  for (const d of secretDirs) lines.push(`(deny file-read* (subpath "${sbEsc(d)}"))`);
  lines.push(`(deny file-read* file-write* (literal "${sbEsc(path.join(home, ".netrc"))}"))`);
  lines.push(`(deny file-write* (subpath "${sbEsc(home)}"))`);
  for (const d of harnessDirs) lines.push(`(allow file-write* (subpath "${sbEsc(d)}"))`);
  for (const p of [workspace, artifactDir]) lines.push(`(allow file* (subpath "${sbEsc(p)}"))`);
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

export function writeTempSandboxProfile(profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-collab-sandbox-"));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "profile.sb");
  fs.writeFileSync(file, profile, { encoding: "utf8", mode: 0o600 });
  return file;
}

/** Run a command synchronously and return { status, stdout, stderr } without throwing. */
export function run(command, args = [], opts = {}) {
  let finalCommand = command;
  let finalArgs = args;
  let tempProfileFile = null;
  // null = not requested; true/false = requested and (not) actually applied. Lets
  // callers detect "sandbox asked for but couldn't be applied" (e.g. no bwrap).
  let sandboxApplied = opts.sandbox ? false : null;

  if (opts.sandbox) {
    const platform = os.platform();
    if (platform === "darwin") {
      const workspace = opts.sandboxWorkspace || opts.cwd || process.cwd();
      const artifactDir = opts.sandboxArtifactDir || workspace;
      const profile = generateMacSandboxProfile(workspace, artifactDir, { strict: opts.sandboxStrict });

      tempProfileFile = writeTempSandboxProfile(profile);

      finalCommand = "/usr/bin/sandbox-exec";
      finalArgs = ["-f", tempProfileFile, command, ...args];
      sandboxApplied = true;
    } else if (platform === "linux") {
      if (isBwrapAvailable()) {
        const workspace = opts.sandboxWorkspace || opts.cwd || process.cwd();
        const artifactDir = opts.sandboxArtifactDir || workspace;

        sandboxApplied = true;
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
  delete spawnOpts.sandboxStrict;
  delete spawnOpts.idleMs;
  delete spawnOpts.watchDirs;
  delete spawnOpts.progressFile;

  // Inactivity watchdog: wrap the (possibly sandboxed) command in idle-guard so a
  // FROZEN run is killed after `idleMs` with no progress, instead of blocking to
  // the hard ceiling. "Progress" = stdout/stderr OR file activity under watchDirs
  // (workers often log/write files rather than streaming to the pipe). The guard
  // also enforces the hard timeout (killing the whole group); spawnSync's own
  // timeout becomes a +30s backstop in case the guard itself wedges.
  const idleMs = Number(opts.idleMs) || 0;
  if (idleMs > 0) {
    const hardMs = Number(opts.timeout) || 0;
    const watchArgs = [];
    for (const d of opts.watchDirs ?? []) {
      if (d) watchArgs.push("--watch", d);
    }
    const progressArgs = opts.progressFile ? ["--progress-file", opts.progressFile] : [];
    finalArgs = [IDLE_GUARD, "--idle", String(idleMs), "--timeout", String(hardMs), ...progressArgs, ...watchArgs, "--", finalCommand, ...finalArgs];
    finalCommand = process.execPath;
    spawnOpts.timeout = hardMs ? hardMs + 30000 : undefined;
    // If the guard's event loop itself wedges, its JS signal handler cannot run.
    // spawnSync does not escalate its default SIGTERM, so make the documented
    // +30s outer backstop a real, unconditional ceiling.
    spawnOpts.killSignal = "SIGKILL";
  }

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
      error: result.error,
      sandboxApplied
    };
  } finally {
    if (tempProfileFile && fs.existsSync(tempProfileFile)) {
      try {
        fs.rmSync(path.dirname(tempProfileFile), { recursive: true, force: true });
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
