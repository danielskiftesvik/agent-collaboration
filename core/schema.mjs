// A tiny, dependency-free validator covering the JSON Schema subset our artifact
// contracts use: type, required, properties, additionalProperties:false, enum,
// minLength, minimum, maximum, items. Not a general-purpose validator.

function typeOk(type, value) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      return true;
  }
}

function walk(schema, value, path, errors) {
  if (schema.type && !typeOk(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}`);
    return; // further checks assume the type held
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }
  if (schema.type === "object" && typeOk("object", value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}.${key}: unexpected property`);
      }
    }
    for (const [key, subschema] of Object.entries(props)) {
      if (key in value) walk(subschema, value[key], `${path}.${key}`, errors);
    }
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors));
  }
}

export function validate(schema, value) {
  const errors = [];
  walk(schema, value, "$", errors);
  return { valid: errors.length === 0, errors };
}

/** Best-effort extraction of a JSON object from text that may wrap it in prose
 *  or a ```json fence (needed for harnesses like `agy` that print plain text). */
export function extractJson(text) {
  if (text == null) return null;
  const candidates = [];
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  candidates.push(String(text));
  const first = String(text).indexOf("{");
  const last = String(text).lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(String(text).slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      // try next candidate
    }
  }
  return null;
}

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const SEVERITY_SYNONYMS = {
  blocker: "critical",
  crit: "critical",
  fatal: "critical",
  major: "high",
  error: "high",
  warning: "medium",
  warn: "medium",
  moderate: "medium",
  minor: "low",
  info: "low",
  informational: "low",
  note: "low",
  nit: "low",
  suggestion: "low",
  style: "low"
};

function normalizeSeverity(s) {
  if (typeof s !== "string") return s;
  const k = s.trim().toLowerCase();
  if (SEVERITIES.has(k)) return k;
  return SEVERITY_SYNONYMS[k] ?? k; // leave a truly unknown word lowercased; validation will flag it
}

/**
 * Normalize a review artifact to what our schema expects, so a *complete, usable*
 * report from a model isn't false-failed over cosmetics. Mirrors the reference's
 * "normalize, don't reject" renderer:
 *   - lowercase/trim `verdict` and each finding's `severity` (codex emits "High")
 *   - map common severity synonyms (blocker→critical, warning→medium, nit→low)
 *   - coerce `next_steps`/`findings` to arrays (default [])
 * Because we reuse codex's generic `task` path (no `outputSchema` enforcement,
 * unlike the reference's native review subcommand), this client-side normalization
 * is our equivalent guardrail.
 */
export function normalizeReviewArtifact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out = { ...value };
  if (typeof out.verdict === "string") out.verdict = out.verdict.trim().toLowerCase();
  if (Array.isArray(out.findings)) {
    out.findings = out.findings.map((f) =>
      f && typeof f === "object" && !Array.isArray(f)
        ? { ...f, severity: normalizeSeverity(f.severity) }
        : f
    );
  }
  if (out.next_steps === undefined) out.next_steps = [];
  else if (!Array.isArray(out.next_steps)) out.next_steps = [out.next_steps].filter(Boolean);
  return out;
}

/** Extract a JSON object from raw worker output and validate it against a
 *  schema. Optionally pass a `normalize` fn to repair cosmetic mismatches (e.g.
 *  severity case) before validation. The basis of the dispatch layer's
 *  validate-then-repair retry loop. */
export function coerceArtifact(schema, rawText, normalize) {
  let value = extractJson(rawText);
  if (value == null) {
    return { ok: false, value: null, errors: ["no JSON object found in output"] };
  }
  if (typeof normalize === "function") value = normalize(value);
  const { valid, errors } = validate(schema, value);
  return { ok: valid, value, errors };
}
