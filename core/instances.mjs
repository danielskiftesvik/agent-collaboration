// Named harness instance aliases — multiple identities of the same adapter
// (e.g. personal ~/.codex vs business ~/.codex-business via CODEX_HOME).
//
// User-level config (primary for machine-local homes/bins):
//   ~/.agent-collaboration/config.json
// Repo-level (optional defaults only preferred; instances allowed but user wins):
//   .agent-collab.json
//
//   {
//     "instances": {
//       "codex-business": {
//         "harness": "codex",
//         "env": { "CODEX_HOME": "~/.codex-business" }
//       },
//       "claude-local": {
//         "harness": "claude",
//         "bin": "/path/to/claude-local"
//       }
//     },
//     "defaults": {
//       "codex": "codex-business"
//     }
//   }
//
// Resolution returns an explicit triple — never overload the worker string:
//   { label, harness, instance, env, bin, hasOverlay }
// Consumers: harness → adapter/profiles/sandbox; label → job.worker / artifacts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listAdapters } from "../adapters/index.mjs";
import { PIN_FILE } from "./pins.mjs";

export function defaultUserConfigPath() {
  if (process.env.AGENT_COLLAB_INSTANCE_CONFIG) {
    return process.env.AGENT_COLLAB_INSTANCE_CONFIG;
  }
  return path.join(os.homedir() || os.tmpdir(), ".agent-collaboration", "config.json");
}

export const USER_CONFIG_FILE = defaultUserConfigPath();

/** Env keys instances may set. Anything else is rejected (no silent secret injection). */
export const INSTANCE_ENV_ALLOWLIST = new Set([
  "CODEX_HOME",
  "GROK_HOME",
  "DSH_HOME",
  "CLAUDE_CONFIG_DIR",
  "AGENT_COLLAB_CLAUDE_BIN",
  "AGENT_COLLAB_AGY_BIN",
  "AGENT_COLLAB_GROK_BIN",
  "AGENT_COLLAB_DSH_BIN",
  "AGENT_COLLAB_OPENCODE_BIN",
  "AGENT_COLLAB_QWEN_BIN",
  "AGENT_COLLAB_CURSOR_BIN",
  "AGENT_COLLAB_DSH_MODEL",
  "AGENT_COLLAB_CODEX_COMPANION",
  "AGENT_COLLAB_CODEX_HOME",
  "AGENT_COLLAB_QWEN_BASE_URL",
  "AGENT_COLLAB_QWEN_API_KEY",
  "AGENT_COLLAB_QWEN_MODEL"
]);

const BIN_ENV_BY_HARNESS = {
  claude: "AGENT_COLLAB_CLAUDE_BIN",
  agy: "AGENT_COLLAB_AGY_BIN",
  grok: "AGENT_COLLAB_GROK_BIN",
  dsh: "AGENT_COLLAB_DSH_BIN",
  opencode: "AGENT_COLLAB_OPENCODE_BIN",
  qwen: "AGENT_COLLAB_QWEN_BIN",
  cursor: "AGENT_COLLAB_CURSOR_BIN",
  codex: "AGENT_COLLAB_CODEX_COMPANION"
};

let cache = null;
let warnedBadUser = false;
let warnedBadRepo = false;

export function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function adapterNames() {
  return new Set(listAdapters().map((a) => a.name));
}

function findRepoConfig(startDir) {
  if (!startDir) return null;
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

function readJsonFile(file, warnFlag) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (warnFlag === "user" && !warnedBadUser) {
      warnedBadUser = true;
      process.stderr.write(`agent-collaboration: ignoring malformed ${file}: ${err.message}\n`);
    }
    if (warnFlag === "repo" && !warnedBadRepo) {
      warnedBadRepo = true;
      process.stderr.write(`agent-collaboration: ignoring malformed ${file}: ${err.message}\n`);
    }
    return null;
  }
}

/**
 * Merge user + repo instance config. User wins on key collision (machine-local
 * homes/bins must not be overridden by a teammate's checked-in paths).
 */
export function loadInstanceConfig({ workspace, userFile } = {}) {
  const resolvedUser = userFile || defaultUserConfigPath();
  const key = `${resolvedUser}::${workspace || ""}`;
  if (cache && cache.key === key) return cache.value;

  const user = readJsonFile(resolvedUser, "user") || {};
  const repoFile = findRepoConfig(workspace || process.cwd());
  const repo = readJsonFile(repoFile, "repo") || {};

  const instances = { ...(repo.instances || {}), ...(user.instances || {}) };
  const defaults = { ...(repo.defaults || {}), ...(user.defaults || {}) };

  const value = { instances, defaults, userFile: resolvedUser, repoFile };
  cache = { key, value };
  return value;
}

function validateInstanceEntry(name, entry, known) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`instance "${name}": expected an object with harness/env/bin`);
  }
  const harness = entry.harness;
  if (typeof harness !== "string" || !harness) {
    throw new Error(`instance "${name}": missing string "harness"`);
  }
  if (!known.has(harness)) {
    throw new Error(`instance "${name}": unknown harness "${harness}"`);
  }
  if (known.has(name) && name !== harness) {
    throw new Error(
      `instance "${name}": cannot shadow built-in harness name (use defaults.${name} → instance instead)`
    );
  }
  if (known.has(name) && name === harness) {
    throw new Error(
      `instance "${name}": cannot redefine a built-in harness; define a distinct alias and point defaults.${name} at it`
    );
  }
  if (entry.bin != null && typeof entry.bin !== "string") {
    throw new Error(`instance "${name}": "bin" must be a string`);
  }
  const env = entry.env || {};
  if (env && typeof env !== "object") {
    throw new Error(`instance "${name}": "env" must be an object`);
  }
  for (const k of Object.keys(env)) {
    if (!INSTANCE_ENV_ALLOWLIST.has(k)) {
      throw new Error(
        `instance "${name}": env key "${k}" is not allowlisted ` +
          `(allowed: ${[...INSTANCE_ENV_ALLOWLIST].join(", ")})`
      );
    }
    if (typeof env[k] !== "string") {
      throw new Error(`instance "${name}": env.${k} must be a string`);
    }
  }
  return {
    harness,
    bin: entry.bin ? expandHome(entry.bin) : null,
    env: Object.fromEntries(
      Object.entries(env).map(([k, v]) => [k, expandHome(v)])
    )
  };
}

function buildOverlayEnv({ harness, env, bin }) {
  const out = { ...(env || {}) };
  if (bin) {
    const key = BIN_ENV_BY_HARNESS[harness];
    if (key) out[key] = bin;
  }
  return out;
}

/**
 * Resolve a worker CLI name to a concrete identity.
 * @returns {{
 *   label: string,       // job.worker / artifact filenames (alias or harness)
 *   harness: string,     // adapter / MODEL_PROFILES / sandbox key
 *   instance: string|null,
 *   env: Record<string,string>,
 *   bin: string|null,
 *   overlay: Record<string,string>,
 *   hasOverlay: boolean
 * }}
 */
export function resolveWorkerRef(name, opts = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("worker name is required");
  }
  const known = adapterNames();
  const cfg = loadInstanceConfig(opts);
  const instances = cfg.instances || {};
  const defaults = cfg.defaults || {};

  // Explicit instance alias
  if (Object.prototype.hasOwnProperty.call(instances, name)) {
    const entry = validateInstanceEntry(name, instances[name], known);
    const overlay = buildOverlayEnv(entry);
    return {
      label: name,
      harness: entry.harness,
      instance: name,
      env: entry.env,
      bin: entry.bin,
      overlay,
      hasOverlay: Object.keys(overlay).length > 0
    };
  }

  // Built-in harness, maybe redirected by defaults
  if (known.has(name)) {
    const def = defaults[name];
    if (def) {
      if (!Object.prototype.hasOwnProperty.call(instances, def)) {
        throw new Error(
          `defaults.${name} points at unknown instance "${def}" ` +
            `(define instances.${def} in ${cfg.userFile || "user config"} or ${PIN_FILE})`
        );
      }
      const entry = validateInstanceEntry(def, instances[def], known);
      if (entry.harness !== name) {
        throw new Error(
          `defaults.${name} → instance "${def}" has harness "${entry.harness}", expected "${name}"`
        );
      }
      const overlay = buildOverlayEnv(entry);
      return {
        label: def,
        harness: name,
        instance: def,
        env: entry.env,
        bin: entry.bin,
        overlay,
        hasOverlay: Object.keys(overlay).length > 0
      };
    }
    return {
      label: name,
      harness: name,
      instance: null,
      env: {},
      bin: null,
      overlay: {},
      hasOverlay: false
    };
  }

  throw new Error(
    `unknown worker "${name}" (not a built-in harness or configured instance)`
  );
}

/** Temporarily apply overlay env around a synchronous adapter call (buildCommand/probe). */
export function withEnvOverlay(overlay, fn) {
  const env = overlay || {};
  const keys = Object.keys(env);
  const prev = Object.create(null);
  for (const k of keys) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k)
      ? process.env[k]
      : undefined;
    if (env[k] == null) delete process.env[k];
    else process.env[k] = String(env[k]);
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

/** Paths from overlay that should be writable in the OS sandbox (auth/session homes). */
export function sandboxDirsFromOverlay(overlay = {}) {
  const dirs = [];
  for (const [k, v] of Object.entries(overlay)) {
    if (!v || typeof v !== "string") continue;
    if (
      k === "CODEX_HOME" ||
      k === "CLAUDE_CONFIG_DIR" ||
      k.endsWith("_HOME") ||
      k.endsWith("_DIR")
    ) {
      dirs.push(path.resolve(expandHome(v)));
    }
  }
  return dirs;
}

/**
 * Durable seat snapshot for job records (#754 / prspctv).
 * Instance overlay wins; ambient AGENT_COLLAB_* / harness HOME fills gaps so
 * bare `--worker codex` under CODEX_HOME=~/.codex-business is still auditable.
 */
export function snapshotWorkerRef(ref, { ambientEnv = process.env } = {}) {
  if (!ref || typeof ref !== "object") {
    throw new Error("snapshotWorkerRef requires a resolved worker ref");
  }
  const env = { ...(ref.env || {}) };
  const overlay = { ...(ref.overlay || {}) };

  const captureHome = (key, ambientKeys) => {
    const raw =
      overlay[key] ||
      env[key] ||
      ambientKeys.map((k) => ambientEnv?.[k]).find((v) => v != null && v !== "");
    if (!raw) return;
    const expanded = path.resolve(expandHome(String(raw)));
    env[key] = expanded;
    overlay[key] = expanded;
  };

  if (ref.harness === "codex") {
    captureHome("CODEX_HOME", ["AGENT_COLLAB_CODEX_HOME", "CODEX_HOME"]);
  } else if (ref.harness === "claude") {
    captureHome("CLAUDE_CONFIG_DIR", ["AGENT_COLLAB_CLAUDE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"]);
  } else if (ref.harness === "grok") {
    captureHome("GROK_HOME", ["AGENT_COLLAB_GROK_HOME", "GROK_HOME"]);
  }

  return {
    label: ref.label,
    harness: ref.harness,
    instance: ref.instance ?? null,
    env,
    bin: ref.bin ?? null,
    overlay,
    hasOverlay: Object.keys(overlay).length > 0
  };
}

/** Allowlisted env keys safe to expose on result/status seat summaries. */
export const SEAT_ENV_KEYS = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"];

export function seatEnvFromWorkerRef(workerRef) {
  const src = workerRef?.env || workerRef?.overlay || {};
  const out = {};
  for (const k of SEAT_ENV_KEYS) {
    if (src[k]) out[k] = src[k];
  }
  return out;
}

/** List configured instances for setup/doctor (does not probe). */
export function listConfiguredInstances(opts = {}) {
  const cfg = loadInstanceConfig(opts);
  const known = adapterNames();
  const out = [];
  for (const [name, raw] of Object.entries(cfg.instances || {})) {
    try {
      const entry = validateInstanceEntry(name, raw, known);
      out.push({
        name,
        harness: entry.harness,
        bin: entry.bin,
        env: entry.env,
        defaultFor: Object.entries(cfg.defaults || {})
          .filter(([, v]) => v === name)
          .map(([k]) => k)
      });
    } catch (err) {
      out.push({ name, error: err.message });
    }
  }
  return out;
}

/** Test hook. */
export function _clearInstanceCache() {
  cache = null;
  warnedBadUser = false;
  warnedBadRepo = false;
}
