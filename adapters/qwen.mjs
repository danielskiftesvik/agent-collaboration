// Qwen Code CLI, driving a local OpenAI-compatible model server (LM Studio) over
// http://127.0.0.1:1234/v1 by default. Third-party CLI, prompt-coaxed JSON (like
// agy) — but UNLIKE agy, qwen writes directly into the --add-dir workspace, so
// parseOutput needs no worktree/log-harvesting logic (that's agy-specific: agy
// writes into its own internal worktree instead of the one it's handed).
//
// --output-format json (buffered — a single JSON array printed at process exit),
// NOT stream-json. stream-json was the original design (chosen for an incremental
// idle-watchdog heartbeat) but was piloted against this very plan (8 live runs,
// 2026-07-01, qwen 0.19.3 + LM Studio serving qwen3-coder-30b-a3b-instruct) and
// never once let qwen finish a multi-turn tool-calling task (0/3) — it consistently
// narrated the right next action in text, then the session ended with no
// corresponding tool call. Buffered `json` completed the actual work in 3/3 pilot
// attempts. The terminal array entry is
// {"type":"result","subtype":"success","result":"<answer text>"}, matching
// claude.mjs's convention. The idle-watchdog gap this leaves for the read-only
// reviewer role (no stdout AND no file writes until exit) is handled instead via
// MODEL_PROFILES.qwen.idleMsOverride (Task 5) — a wider timeout rather than a
// heartbeat, since nothing in the pilot looked like a genuine hang.
//
// --allowed-tools is required alongside --approval-mode yolo, not redundant with
// it: one pilot run had a `glob` call DECLINED despite yolo mode. yolo mode alone
// is not sufficient for full unattended operation in this CLI version.
//
// A repair round should be the expected norm, not a failure signal: in the pilot,
// the underlying work (file edits, tests) was correct in every attempt using this
// config, but the final JSON status was clean only 1 of 3 times.
//
// cleanEnv: MODEL_PROFILES.qwen.cleanEnv = true (Task 5) — a local-only job's
// entire point is "never touch the cloud"; pinning --openai-base-url only
// constrains the LLM inference backend, not this process's ambient environment
// (ANTHROPIC_API_KEY, proxy vars, etc. sitting in the user's shell). See
// core/dispatch.mjs's cleanEnv handling (Task 3) — the flag lives on the model
// profile, not here, because defineAdapter's return value is frozen.
//
// --exclude-tools web_fetch — pinning the inference endpoint does not stop the
// qwen-code agent SCAFFOLD's own tools (confirmed present: web_fetch) from making
// an arbitrary outbound request if the model decides to (or is prompted into it).
// This is a cheap, immediately-available mitigation; full OS-level network denial
// remains out of scope (see the design spec's non-goals).
//
// safeBaseUrl()/AGENT_COLLAB_QWEN_ALLOW_REMOTE — found in review: an unvalidated
// AGENT_COLLAB_QWEN_BASE_URL would let a stray or malicious env var silently
// redirect a "local-only" job to a remote host, even though our own flags force
// what LOOKS like a pinned endpoint. Refuse non-loopback by default; require an
// explicit opt-out to send anywhere else, matching this codebase's existing
// pattern for other deliberately-relaxed safety defaults
// (AGENT_COLLAB_ALLOW_NONWRITER, AGENT_COLLAB_ALLOW_INPLACE).
//
// No buildRetryCommand/isResumeMiss: qwen supports --resume <sessionId>, but the
// current adapter contract has no way to thread a captured session id into a
// retry call (shared plumbing, not a qwen-only change) — deferred; repair falls
// back to the dispatch layer's existing fresh-re-send path.
import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";

const bin = () => process.env.AGENT_COLLAB_QWEN_BIN || "qwen";
const rawBaseUrl = () => process.env.AGENT_COLLAB_QWEN_BASE_URL || "http://127.0.0.1:1234/v1";
const apiKey = () => process.env.AGENT_COLLAB_QWEN_API_KEY || "lm-studio";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Returns the base URL if it's loopback (or remote access was explicitly
 *  allowed), else null. Callers must treat null as "refuse to run" — see
 *  buildCommand/probe below. */
function safeBaseUrl() {
  const url = rawBaseUrl();
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null; // unparseable — treat as unsafe
  }
  if (LOOPBACK_HOSTS.has(host)) return url;
  if (process.env.AGENT_COLLAB_QWEN_ALLOW_REMOTE === "on") return url;
  return null;
}

// Network-capable qwen-code CLI tools that must be excluded for a job whose whole
// point is to never call out to the network. Confirm this list against a live
// --bare tool listing if qwen-code's tool set changes (see plan Step 0).
const EXCLUDED_TOOLS = ["web_fetch"];

// Tools qwen is allowed to use without an approval prompt. --approval-mode yolo
// alone was found, live, to still decline a `glob` call — this explicit list is
// required, not redundant. read_file/edit/run_shell_command/glob were observed
// working in the pilot; write_file is included defensively for file-creation
// (untested — see Step 0 item 1).
const ALLOWED_TOOLS = ["glob", "read_file", "write_file", "edit", "run_shell_command"];

export default defineAdapter({
  name: "qwen",
  supportsStructuredOutput: false,
  buildCommand({ role, brief, workspace, timeoutMs }) {
    const url = safeBaseUrl();
    if (!url) {
      // Refuse to run rather than silently sending a local-only brief to a
      // non-loopback endpoint. This fails through the NORMAL command-execution +
      // failure-classification path (a real process, exit 1, clear stderr) rather
      // than throwing from buildCommand, which the dispatch layer has no contract
      // for handling.
      const message = `qwen: refusing non-loopback AGENT_COLLAB_QWEN_BASE_URL (${rawBaseUrl()}) — set AGENT_COLLAB_QWEN_ALLOW_REMOTE=on to override`;
      return {
        command: process.execPath,
        args: ["-e", `console.error(${JSON.stringify(message)}); process.exit(1);`]
      };
    }
    const seconds = Math.ceil((timeoutMs ?? 300000) / 1000);
    const args = ["--bare", "--approval-mode", "yolo"];
    // Don't pick a model — LM Studio serves one model at a time and /models lists
    // the full download catalog, not the active one, so we can't reliably
    // auto-select. Default: inherit qwen's own configured default
    // (model.name in ~/.qwen/settings.json). Override with AGENT_COLLAB_QWEN_MODEL.
    const model = process.env.AGENT_COLLAB_QWEN_MODEL;
    if (model) args.push("-m", model);
    args.push("--openai-base-url", url);
    args.push("--openai-api-key", apiKey());
    args.push("--auth-type", "openai");
    args.push("--exclude-tools", ...EXCLUDED_TOOLS);
    args.push("--allowed-tools", ...ALLOWED_TOOLS);
    if (workspace) args.push("--add-dir", workspace);
    args.push("--output-format", "json");
    args.push("--max-wall-time", `${seconds}s`);
    // `-p`/`--prompt` is marked deprecated in `qwen --help` ("Use the positional
    // prompt instead"), in favor of a bare trailing positional. Deliberately NOT
    // switched: `-p <brief>` was verified live (this session) to handle realistic
    // multi-paragraph prompts correctly; a bare positional risks yargs
    // misparsing `brief` as a flag if it happens to start with "-" (plausible —
    // composed briefs routinely start with a bullet point). Re-verify the
    // positional form's leading-dash behavior live (Step 0) before switching;
    // until then this is a forward-compat note, not a current bug — the flag
    // still works in the tested version (0.19.3).
    args.push("-p", brief);
    return { command: bin(), args };
  },
  // Local-model instruction-following on strict JSON is the weaker link here too
  // (same reasoning as agy's contract) — emphatic and example-anchored. Verified
  // live: plain "reply with ONLY this JSON shape" prompting worked cleanly on two
  // different local models (qwen3-coder-30b-a3b-instruct, google/gemma-4-26b-a4b-qat).
  outputContract(role) {
    if (role === "reviewer") {
      return (
        "\n\n---\nReturn ONLY a JSON object and NOTHING else — no prose before or after it, " +
        "no markdown headings, no commentary. Match this exact shape (replace the values):\n" +
        '{"verdict":"approve" | "needs-attention","summary":"<one line>",' +
        '"findings":[{"severity":"high","title":"...","body":"...","file":"path",' +
        '"line_start":1,"line_end":1,"confidence":0.9,"recommendation":"..."}],' +
        '"next_steps":["..."]}. Every actionable defect must be in findings; never hide defects in ' +
        'summary or next_steps. A needs-attention verdict requires at least one finding.'
      );
    }
    return (
      "\n\n---\nWrite ALL files you create or edit INTO your current working directory " +
      "(the workspace you were given via --add-dir). Do NOT write anywhere outside that " +
      "workspace.\nWhen finished, return ONLY a JSON object and NOTHING else — no prose " +
      "before or after it. Match this exact shape:\n" +
      '{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}'
    );
  },
  // --output-format json: a single JSON ARRAY of events (confirmed live — NOT
  // newline-delimited); the final {"type":"result","result":"…"} entry carries the
  // answer, same convention as claude.mjs uses for its stream-json events, just a
  // different container shape.
  parseOutput({ stdout }) {
    const text = stdout ?? "";
    try {
      const events = JSON.parse(text);
      if (Array.isArray(events)) {
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i];
          if (ev && ev.type === "result" && typeof ev.result === "string") {
            return { answerText: ev.result, structured: null };
          }
        }
      }
    } catch {
      // not a JSON array at all — fall through to the raw-text fallback below
    }
    return { answerText: text.trim(), structured: null };
  },
  probe() {
    const r = run(bin(), ["--version"]);
    if (r.error || r.status !== 0) {
      return { available: false, error: r.error?.message || r.stderr || "qwen CLI not found" };
    }
    const url = safeBaseUrl();
    if (!url) {
      return {
        available: false,
        error: `refusing non-loopback AGENT_COLLAB_QWEN_BASE_URL (${rawBaseUrl()}) — set AGENT_COLLAB_QWEN_ALLOW_REMOTE=on to override`
      };
    }
    // "binary present, local server not running" is THE realistic failure mode for
    // this harness specifically (none of the other three depend on a separately-
    // started local process) — bounded so a hung/unreachable endpoint can't stall
    // runSetup()/recommend for every OTHER harness too.
    const check = run("curl", ["-sf", "--max-time", "2", `${url}/models`]);
    if (check.status !== 0) {
      return {
        available: false,
        error: `qwen CLI found but local server unreachable at ${url} — start LM Studio`
      };
    }
    return { available: true, version: r.stdout.trim() };
  },
  unattendedProbe() {
    return { ok: true, detail: "uses --approval-mode yolo; requires a local LM Studio server" };
  }
});
