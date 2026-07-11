// Repo-level standing model pins — one tracked file that EVERY driver harness reads.
//
// File: `.agent-collab.json` at the repo/workspace root:
//
//   {
//     "workers": {
//       "codex":  { "reviewer": { "model": "gpt-5.6-terra", "effort": "high" } },
//       "agy":    { "reviewer": { "model": "Gemini 3.5 Flash (High)" } },
//       "claude": { "worker":   { "model": "sonnet" } }
//     }
//   }
//
// WHY this exists: a "reviewer instrument" pin must (a) survive interactive
// sessions rewriting harness base configs — the codex TUI persists the last-used
// model back to ~/.codex/config.toml, so base config is drift, not doctrine;
// (b) be version-controlled alongside the repo's conventions; and (c) apply
// identically no matter which harness drives the dispatch (claude, codex, agy
// shells). A tracked repo file is the only surface with all three properties.
//
// PRECEDENCE (enforced by the adapters): explicit env vars — the per-dispatch
// escalation lever — always WIN over the file; the file wins over adapter
// defaults / harness base config. Roles are the runtime's: "reviewer" | "worker".
//
// Worker workspaces are worktree checkouts of the repo, so the tracked file is
// present inside them; we also fall back to process.cwd() (the driver's checkout).

import fs from "node:fs";
import path from "node:path";

export const PIN_FILE = ".agent-collab.json";

const cache = new Map();
let warnedBad = false;

function findPinFile(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12 && dir; i++) {
    const candidate = path.join(dir, PIN_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readPins(startDir) {
  if (!startDir) return null;
  if (cache.has(startDir)) return cache.get(startDir);
  const file = findPinFile(startDir);
  let pins = null;
  if (file) {
    try {
      pins = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      // A malformed file silently unpinning the review instrument would be a
      // calibration bypass — warn loudly once, then behave as unpinned.
      if (!warnedBad) {
        warnedBad = true;
        process.stderr.write(
          `agent-collaboration: ignoring malformed ${file}: ${err.message}\n`
        );
      }
    }
  }
  cache.set(startDir, pins);
  return pins;
}

const warnedProfiles = new Set();

/**
 * Resolve a standing pin for worker+role, optionally escalated through a named
 * profile (`pins.profiles.<name>.<worker>` — e.g. a "deep" profile pinning
 * codex to the frontier model for boundary reviews). Within the file, a
 * requested profile wins over the role pin; env vars (handled by the adapters)
 * win over both. A requested-but-missing profile WARNS and falls back to the
 * role pin — a silent fall-through would run an un-escalated review without
 * anyone noticing.
 * @returns {{model: string|null, effort: string|null}}
 */
export function resolvePin(worker, role, workspace, profile) {
  for (const start of [workspace, process.cwd()]) {
    const pins = readPins(start);
    if (!pins) continue;
    // First file found wins entirely (workspace worktree and driver cwd are
    // normally checkouts of the same repo — identical file either way).
    let p = pins?.workers?.[worker]?.[role];
    if (profile) {
      const prof = pins?.profiles?.[profile]?.[worker];
      if (prof) {
        p = prof;
      } else {
        const key = `${profile}:${worker}`;
        if (!warnedProfiles.has(key)) {
          warnedProfiles.add(key);
          process.stderr.write(
            `agent-collaboration: profile "${profile}" has no entry for worker "${worker}" in ${PIN_FILE} — using the standing ${role} pin instead\n`
          );
        }
      }
    }
    return {
      model: (p && typeof p.model === "string" && p.model) || null,
      effort: (p && typeof p.effort === "string" && p.effort) || null
    };
  }
  return { model: null, effort: null };
}

/** Test hook — pins are cached per start dir for the process lifetime. */
export function _clearPinCache() {
  cache.clear();
  warnedBad = false;
  warnedProfiles.clear();
}
