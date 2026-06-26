// Derived from codex-plugin-cc (Apache-2.0, Copyright 2026 OpenAI): a tiny
// template engine — load a markdown prompt from prompts/ and substitute
// {{UPPER_CASE}} placeholders. Review-grade prompts are code-loaded templates;
// free-form task prompts are composed by the driver (see harness-prompting skill).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadTemplate(name) {
  return fs.readFileSync(path.join(PKG_ROOT, "prompts", `${name}.md`), "utf8");
}

export function interpolate(template, variables = {}) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : ""
  );
}

/** Convenience: load a template and interpolate in one step. */
export function buildFromTemplate(name, variables = {}) {
  return interpolate(loadTemplate(name), variables);
}
