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
//   buildRetryCommand({ role, repairBrief, workspace, timeoutMs }) -> { command, args, env? } | null
//       A repair attempt that CONTINUES/RESUMES the worker's existing thread with
//       a short ask (cheaper + higher-quality than re-running cold). Return null to
//       fall back to a fresh buildCommand re-send. (codex: `task --resume-last`.)
//   isResumeMiss({ stdout, stderr, status }) -> boolean
//       True when a resume attempt failed because there was no thread to resume;
//       dispatch then redoes the attempt fresh so resume can never regress.
//   progressDirs({ workspace, artifactDir }) -> string[]
//       Worker-specific directories whose activity is evidence of progress for
//       THIS job. Dispatch creates them before the idle guard starts watching.
//   buildCleanupCommand({ workspace, artifactDir }) -> { command, args, env? } | null
//       Targeted lifecycle cleanup run after every terminal attempt and explicit
//       cancellation. It must affect only resources owned by this job.

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
