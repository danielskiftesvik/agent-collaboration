// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI).
import { spawnSync } from "node:child_process";

/** Run a command synchronously and return { status, stdout, stderr } without throwing. */
export function run(command, args = [], opts = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts
  });
  return {
    status: result.status ?? (result.signal ? -1 : null),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
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
