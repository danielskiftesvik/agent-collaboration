#!/usr/bin/env node
// Run a command under an INACTIVITY (idle) timeout so a FROZEN worker is caught
// fast instead of blocking to the hard ceiling. If the command produces no
// stdout/stderr for --idle ms, kill its process group and exit 124 with a marker;
// also enforces an optional --timeout (hard) ceiling. The child's stdout/stderr
// are re-emitted verbatim, so the caller captures output exactly as before.
//
// "Output" here means EITHER stdout/stderr OR file activity under a --watch dir —
// many workers stream progress to their own logs / write files rather than to the
// pipe, so watching only the pipe would false-kill a healthy-but-quiet run.
//
// Usage: node idle-guard.mjs --idle <ms> [--timeout <ms>] [--watch <dir>]... -- <cmd> [args...]
import { spawn } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
let idleMs = 0;
let hardMs = 0;
const watchDirs = [];
let i = 0;
for (; i < argv.length; i++) {
  if (argv[i] === "--idle") idleMs = Number(argv[++i]) || 0;
  else if (argv[i] === "--timeout") hardMs = Number(argv[++i]) || 0;
  else if (argv[i] === "--watch") watchDirs.push(argv[++i]);
  else if (argv[i] === "--") {
    i++;
    break;
  } else break;
}
const cmd = argv[i];
const rest = argv.slice(i + 1);
if (!cmd) {
  process.stderr.write("idle-guard: no command given\n");
  process.exit(2);
}

const child = spawn(cmd, rest, { stdio: ["ignore", "pipe", "pipe"], detached: true });

let last = Date.now();
const start = Date.now();
let reason = null;

const bump = () => {
  last = Date.now();
};
child.stdout.on("data", (d) => {
  process.stdout.write(d);
  bump();
});
child.stderr.on("data", (d) => {
  process.stderr.write(d);
  bump();
});

// File activity under the worktree (and, for agy, its own log dir) ALSO counts as
// progress — so a worker that writes files / logs while silent on the pipe isn't
// mistaken for frozen. Event-driven (fs.watch), best-effort.
const watchers = [];
const watchMtimes = new Map();
const addWatcher = (w) => {
  w.on?.("error", () => {}); // fs.watch can fail asynchronously (EMFILE, races); ignore.
  watchers.push(w);
};
for (const dir of watchDirs) {
  try {
    watchMtimes.set(dir, fs.statSync(dir).mtimeMs);
    addWatcher(fs.watch(dir, { recursive: true }, bump));
  } catch {
    try {
      if (!watchMtimes.has(dir)) watchMtimes.set(dir, fs.statSync(dir).mtimeMs);
      addWatcher(fs.watch(dir, bump)); // recursive unsupported (older Linux) → top-level only
    } catch {
      /* dir missing/unwatchable — skip */
    }
  }
}
const closeWatchers = () => {
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
};

const killTree = (sig) => {
  try {
    process.kill(-child.pid, sig); // the whole group (sandbox-exec + the worker)
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
};

const timer = setInterval(() => {
  const now = Date.now();
  for (const [dir, prev] of watchMtimes) {
    try {
      const mtime = fs.statSync(dir).mtimeMs;
      if (mtime > prev) {
        watchMtimes.set(dir, mtime);
        bump();
      }
    } catch {
      // best-effort only
    }
  }
  if (idleMs > 0 && now - last > idleMs) {
    reason = "idle";
  } else if (hardMs > 0 && now - start > hardMs) {
    reason = "hard";
  }
  if (reason) {
    clearInterval(timer);
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 2000).unref?.();
  }
}, 1000);

child.on("error", (e) => {
  clearInterval(timer);
  closeWatchers();
  process.stderr.write(`idle-guard: ${e.message}\n`);
  process.exit(2);
});

// 'close' fires after the child AND its stdio are fully drained — so all output
// has been re-emitted before we decide the exit code.
child.on("close", (code, signal) => {
  clearInterval(timer);
  closeWatchers();
  if (reason === "idle") {
    process.stderr.write(`\n[idle-guard] no output for ${Math.round(idleMs / 1000)}s — worker appears frozen; killed.\n`);
    process.exit(124);
  }
  if (reason === "hard") {
    process.stderr.write(`\n[idle-guard] hard timeout after ${Math.round(hardMs / 1000)}s; killed.\n`);
    process.exit(124);
  }
  process.exit(code == null ? (signal ? 1 : 0) : code);
});
