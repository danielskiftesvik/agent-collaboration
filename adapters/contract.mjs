// The adapter contract. An adapter describes how to run ONE target harness as a
// non-interactive worker/reviewer in the cross-harness path. It is deliberately
// declarative: the dispatch layer owns spawning, worktrees, heartbeats and job
// state generically, and only asks the adapter to (a) build the command and
// (b) parse raw output into a normalized artifact.
//
// Required:
//   name: string
//   buildCommand({ role, brief, workspace, timeoutMs, structured }) -> { command, args, env? }
//   parseOutput({ role, stdout, stderr, exitCode, workspace }) -> artifact object
//   probe() -> { available: boolean, version?: string, error?: string }
// Optional:
//   unattendedProbe() -> { ok: boolean, detail?: string }   (used by `setup`)
//   supportsStructuredOutput: boolean   (default false)
//   background: boolean                 (default true; can it be detached?)

const REQUIRED = ["name", "buildCommand", "parseOutput", "probe"];

export function defineAdapter(spec) {
  for (const key of REQUIRED) {
    if (spec[key] === undefined) {
      throw new Error(`adapter is missing required member: ${key}`);
    }
  }
  return Object.freeze({
    supportsStructuredOutput: false,
    background: true,
    unattendedProbe: () => ({ ok: true }),
    ...spec
  });
}
