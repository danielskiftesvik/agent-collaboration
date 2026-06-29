// Antigravity CLI (`agy`, v1.x). Headless via `-p`, unattended via
// `--dangerously-skip-permissions`, scoped to a worktree via `--add-dir`, and
// bounded by `--print-timeout`. It prints plain TEXT (no JSON flag), so the
// dispatch layer extracts/validates JSON from the text for structured roles.
import fs from "node:fs";
import path from "node:path";
import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";

const bin = () => process.env.AGENT_COLLAB_AGY_BIN || "agy";

/** Pick the newest label in a model class from `agy models` output, preferring a
 *  higher thinking level. Returns null when the class isn't present. This is how
 *  "latest within class" works without pinning a version that goes stale. */
export function pickLatestModel(models, className) {
  const re = new RegExp(`\\b${className}\\b`, "i");
  const matching = models.filter((m) => re.test(m));
  if (!matching.length) return null;
  const version = (m) => {
    const v = m.match(/(\d+(?:\.\d+)?)/);
    return v ? parseFloat(v[1]) : 0;
  };
  const level = (m) => (/high/i.test(m) ? 2 : /medium/i.test(m) ? 1 : 0);
  const score = (m) => version(m) * 10 + level(m);
  return [...matching].sort((a, b) => score(b) - score(a))[0];
}

const _modelCache = new Map();
function listModels() {
  const b = bin();
  if (_modelCache.has(b)) return _modelCache.get(b);
  const r = run(b, ["models"]);
  const list =
    r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  _modelCache.set(b, list);
  return list;
}

/**
 * Resolve agy's model. `--model` DOES control the model — verified empirically —
 * provided you use the `agy models` LABEL format (e.g. "Gemini 3.5 Flash (High)")
 * AND place it before the positional prompt (the buildCommand ordering does).
 *
 * Default: pin the latest **Flash** label for speed (Flash reviews validated 3/3
 * with the strict template/contract). Pinning also makes runs deterministic — the
 * bare default is a *shared* setting a separate agy session can change.
 *
 * Overrides: AGENT_COLLAB_AGY_MODEL = an exact label (wins); or
 * AGENT_COLLAB_AGY_CLASS = "Pro" (or any class) to pin the latest in that class.
 */
function resolveModel() {
  if (process.env.AGENT_COLLAB_AGY_MODEL) return process.env.AGENT_COLLAB_AGY_MODEL;
  const klass = process.env.AGENT_COLLAB_AGY_CLASS || "Flash";
  return pickLatestModel(listModels(), klass) || null;
}

export default defineAdapter({
  name: "agy",
  supportsStructuredOutput: false,
  buildCommand({ role, brief, workspace, timeoutMs }) {
    const seconds = Math.ceil((timeoutMs ?? 300000) / 1000);
    // ORDER MATTERS: agy's flag parser leaks anything after the first non-flag
    // token into the prompt. So ALL flags first, then `-p <brief>` LAST (the
    // prompt is -p's value). Putting -p first corrupts the prompt AND silently
    // downgrades the model to Flash. Verified empirically.
    const args = ["--dangerously-skip-permissions"];

    // Pin the latest label in the configured class — Flash by default (see
    // resolveModel), before -p. Robust against the shared default being changed
    // externally; force a class with AGENT_COLLAB_AGY_CLASS=Pro or pin an exact
    // label with AGENT_COLLAB_AGY_MODEL.
    const model = resolveModel();
    if (model) args.push("--model", model);

    if (workspace) {
      args.push("--add-dir", workspace);
      args.push("--log-file", path.join(workspace, "agy-worker.jsonl"));
    }
    args.push("--print-timeout", `${seconds}s`);
    args.push("-p", brief);
    return { command: bin(), args };
  },
  // Gemini (esp. Flash) is weak at strict JSON-only output, so the contract is
  // emphatic and example-anchored: demand JSON only, forbid surrounding prose,
  // and show the exact shape to fill in.
  outputContract(role) {
    if (role === "reviewer") {
      return (
        "\n\n---\nReturn ONLY a JSON object and NOTHING else — no prose before or after it, " +
        "no markdown headings, no commentary. Do not edit any files; only review. " +
        "Match this exact shape (replace the values):\n" +
        '{"verdict":"approve" | "needs-attention","summary":"<one line>",' +
        '"findings":[{"severity":"high","title":"...","body":"...","file":"path",' +
        '"line_start":1,"line_end":1,"confidence":0.9,"recommendation":"..."}],' +
        '"next_steps":["..."]}'
      );
    }
    return (
      // agy has a built-in rule to AVOID writing project files to tmp/scratch
      // unless explicitly told — so tell it explicitly to write into the worktree
      // it was handed, else it falls back to ~/.gemini/.../scratch and the runtime
      // captures an empty patch (no-changes). (Self-reported by agy in review.)
      "\n\n---\nWrite ALL files you create or edit INTO your current working directory " +
      "(the workspace you were given via --add-dir). Do NOT write to /tmp, ~/.gemini, a " +
      "scratch directory, or anywhere outside that workspace — files written elsewhere are lost.\n" +
      "When finished, return ONLY a JSON object and NOTHING else — no prose before or after it. " +
      "Match this exact shape:\n" +
      '{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}'
    );
  },
  parseOutput({ stdout, workspace }) {
    if (workspace) {
      const logFile = path.join(workspace, "agy-worker.jsonl");
      if (fs.existsSync(logFile)) {
        try {
          const logContent = fs.readFileSync(logFile, "utf-8");
          // Extract the exact random UUID internal worktree path from agy's logs.
          // We look for ANY occurrence of the path (TargetFile, Cwd, AbsolutePath, etc).
          const match = logContent.match(/(\/[^"]+?\.gemini\/antigravity-cli\/worktrees\/[^\/]+\/[^\/]+\/)/);
          if (match) {
            const internalWorktree = match[1];
            const s = run("git", ["diff", "--name-status", "HEAD"], { cwd: internalWorktree });
            if (s.status === 0 && s.stdout) {
              const lines = s.stdout.trim().split(/\r?\n/).filter(Boolean);
              for (const line of lines) {
                const parts = line.split(/\s+/);
                if (parts.length >= 2) {
                  const status = parts[0];
                  const relPath = parts.slice(1).join(" "); // handles spaces if any (rough)
                  const src = path.join(internalWorktree, relPath);
                  const dst = path.join(workspace, relPath);
                  if (status.startsWith("D")) {
                    if (fs.existsSync(dst)) fs.unlinkSync(dst);
                  } else {
                    if (fs.existsSync(src)) {
                      fs.mkdirSync(path.dirname(dst), { recursive: true });
                      fs.copyFileSync(src, dst);
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          // Fall through to let the normal runtime handle empty-diff state
        }
      }
    }
    return { answerText: (stdout ?? "").trim(), structured: null };
  },
  probe() {
    const r = run(bin(), ["--version"]);
    if (r.error || r.status !== 0) {
      return { available: false, error: r.error?.message || r.stderr || "not found" };
    }
    return { available: true, version: r.stdout.trim() };
  },
  unattendedProbe() {
    // `--dangerously-skip-permissions` is the contract; trustedWorkspaces +
    // toolPermission=always-proceed in settings.json reinforce it.
    return { ok: true, detail: "uses --dangerously-skip-permissions" };
  }
});
