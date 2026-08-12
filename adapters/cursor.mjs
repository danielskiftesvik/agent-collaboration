// Cursor Agent CLI as a worker/reviewer. Headless `-p` with
// `--output-format stream-json` (NDJSON heartbeat, same family as claude).
// Reviewers run read-only via `--mode ask`; workers edit via `--force`.
//
// BINARY RESOLUTION (critical on machines that also have Grok Build): the
// official Cursor installer symlinks `~/.local/bin/agent` → cursor-agent, but
// Grok also ships as `agent` (`~/.grok/bin/agent`, often linked from
// ~/.local/bin/agent). Never fall back to bare `agent` — that is Grok on this
// machine. Prefer AGENT_COLLAB_CURSOR_BIN, then ~/.cursor/bin/agent (the
// companion-safe install location), then newest
// ~/.local/share/cursor-agent/versions/*/cursor-agent, then `cursor-agent`.
//
// Confirmed flags (Cursor Agent 2026.08.11-e8db854): -p/--print, --force/--yolo,
// --mode ask|plan, --trust, --workspace, --output-format text|json|stream-json,
// --model, --sandbox enabled|disabled. Do NOT pass Cursor's --worktree — the
// companion already isolates in its own git worktree; nesting would confuse
// patch harvest and breach detection.
//
// Auth: CURSOR_API_KEY / --api-key, or a prior `agent login`. unattendedProbe
// fails closed when status reports not logged in and no key is present.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";
import { resolvePin } from "../core/pins.mjs";

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Newest installed cursor-agent under ~/.local/share/cursor-agent/versions. */
function newestVersionedBinary() {
  const base = path.join(os.homedir(), ".local/share/cursor-agent", "versions");
  if (!fs.existsSync(base)) return null;
  let best = null;
  for (const name of fs.readdirSync(base)) {
    if (name.startsWith(".")) continue;
    const candidate = path.join(base, name, "cursor-agent");
    if (!isExecutable(candidate)) continue;
    if (!best || name > best.name) best = { name, candidate };
  }
  return best?.candidate ?? null;
}

export function resolveCursorBin(env = process.env) {
  if (env.AGENT_COLLAB_CURSOR_BIN) return env.AGENT_COLLAB_CURSOR_BIN;
  const preferred = path.join(os.homedir(), ".cursor", "bin", "agent");
  if (isExecutable(preferred)) return preferred;
  const versioned = newestVersionedBinary();
  if (versioned) return versioned;
  // Legacy secondary name from the official installer — safe even when bare
  // `agent` is Grok.
  return "cursor-agent";
}

const bin = () => resolveCursorBin();

// Env wins (per-dispatch lever) > role-scoped MODEL_REVIEW > repo pin > default.
const model = (role, workspace, profile) =>
  process.env.AGENT_COLLAB_CURSOR_MODEL ||
  (role === "reviewer" ? process.env.AGENT_COLLAB_CURSOR_MODEL_REVIEW : null) ||
  resolvePin("cursor", role, workspace, profile).model ||
  "composer-2.5";

function authEnv() {
  const env = {};
  if (process.env.CURSOR_API_KEY) env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
  if (process.env.CURSOR_AUTH_TOKEN) env.CURSOR_AUTH_TOKEN = process.env.CURSOR_AUTH_TOKEN;
  return env;
}

export default defineAdapter({
  name: "cursor",
  supportsStructuredOutput: false,
  buildCommand({ role, brief, workspace, profile }) {
    // STREAM NDJSON so the idle watchdog sees progress (plain --output-format
    // json is silent until exit — same reason claude uses stream-json).
    const args = [
      "-p", brief,
      "--output-format", "stream-json",
      "--trust",
      "--model", model(role, workspace, profile)
    ];
    if (role === "reviewer") {
      // ask = Q&A / read-only. Do not pass --force.
      args.push("--mode", "ask");
    } else {
      // Workers must actually edit files in the companion worktree.
      args.push("--force");
    }
    if (workspace) args.push("--workspace", workspace);
    // Companion owns isolation; disable Cursor's nested sandbox so it doesn't
    // fight the worktree / optional companion OS sandbox.
    args.push("--sandbox", "disabled");
    return { command: bin(), args, env: authEnv() };
  },
  outputContract(role) {
    if (role === "reviewer") {
      return (
        "\n\n<output_contract>\nReturn ONLY a JSON object of the form:\n" +
        '{"verdict":"approve"|"needs-attention","summary":string,' +
        '"findings":[{"severity":"critical"|"high"|"medium"|"low","title":string,"body":string,' +
        '"file":string,"line_start":int,"line_end":int,"confidence":0..1,"recommendation":string}],' +
        '"next_steps":[string]}\nPut the highest-severity findings first. Every actionable defect must be a finding; ' +
        'never hide defects in summary or next_steps. A needs-attention verdict requires at least one finding. ' +
        "No prose outside the JSON.\n</output_contract>"
      );
    }
    return (
      "\n\n<output_contract>\nWhen done, return ONLY a JSON object of the form:\n" +
      '{"status":"completed"|"failed"|"blocked","summary":string,"changed":boolean}\n</output_contract>'
    );
  },
  parseOutput({ stdout }) {
    const text = stdout ?? "";
    const tryParse = (s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };
    // stream-json: NDJSON; final {"type":"result","result":"…"} carries the answer
    // (same convention as claude / Cursor's --output-format json envelope).
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const ev = tryParse(lines[i]);
      if (ev && ev.type === "result" && typeof ev.result === "string") {
        return {
          answerText: ev.result,
          structured: null,
          telemetry: {
            sessionId: ev.session_id ?? null,
            durationMs: ev.duration_ms ?? null,
            durationApiMs: ev.duration_api_ms ?? null,
            requestId: ev.request_id ?? null,
            isError: ev.is_error ?? false
          }
        };
      }
    }
    const whole = tryParse(text) || tryParse(lines[lines.length - 1] ?? "");
    if (whole && typeof whole.result === "string") {
      return {
        answerText: whole.result,
        structured: null,
        telemetry: {
          sessionId: whole.session_id ?? null,
          durationMs: whole.duration_ms ?? null
        }
      };
    }
    return { answerText: text.trim(), structured: null };
  },
  probe() {
    const b = bin();
    const r = run(b, ["--version"]);
    if (r.error || r.status !== 0) {
      return { available: false, error: r.error?.message || r.stderr || `not found (${b})` };
    }
    return { available: true, version: (r.stdout || r.stderr || "").trim() || b };
  },
  unattendedProbe() {
    if (process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN) {
      return { ok: true, detail: "CURSOR_API_KEY / CURSOR_AUTH_TOKEN present" };
    }
    const r = run(bin(), ["status"], { env: { ...process.env, ...authEnv() } });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    if (/not logged in|authentication required/i.test(out) || r.status !== 0) {
      return {
        ok: false,
        detail:
          "Cursor Agent CLI not authenticated for unattended use — run `~/.cursor/bin/agent login` " +
          "or set CURSOR_API_KEY (never use bare `agent`; that may be Grok Build)"
      };
    }
    return { ok: true, detail: "agent status reports logged in" };
  },
  resolveModel({ role, workspace, profile }) {
    return model(role, workspace, profile);
  },
  progressDirs() {
    const home = process.env.HOME || os.homedir();
    return [
      path.join(home, ".cursor", "projects"),
      path.join(home, ".cursor", "chats"),
      path.join(home, ".local", "share", "cursor-agent")
    ];
  }
});
