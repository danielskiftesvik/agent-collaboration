// Underlying-model capability profiles + task routing.
//
// These are GENERAL TENDENCIES as of early 2026, encoded as editable data — they
// are the single source of truth for `recommend` and the model-strengths docs.
// Update as models evolve, and weigh task fit over vendor. Profiles lean on
// durable traits (context size, speed tiers, model lineage) and what this project
// verified empirically (e.g. Gemini Flash's weak strict-JSON adherence).

export const MODEL_PROFILES = {
  claude: {
    harness: "claude",
    model: "Claude (Opus/Sonnet)",
    vendor: "Anthropic",
    strongerAt: [
      "sustained multi-step agentic coding",
      "instruction-following & scope discipline (less over-reach)",
      "refactoring and code taste",
      "implementation planning",
      "clear explanation"
    ],
    weakerAt: ["raw speed/cost vs Gemini Flash", "max context size vs Gemini"]
  },
  codex: {
    harness: "codex",
    model: "GPT-5.x (Codex)",
    vendor: "OpenAI",
    strongerAt: [
      "hard reasoning & algorithmic problems",
      "math",
      "finding subtle bugs",
      "adversarial / critical review",
      "strict structured output (schema-enforceable)"
    ],
    weakerAt: [
      "less hand-holding-careful than Claude over long edit sessions",
      "sandbox friction when used as a driver"
    ]
  },
  agy: {
    harness: "agy",
    model: "Gemini 3.x (Flash/Pro)",
    vendor: "Google",
    strongerAt: [
      "very large context window (whole-repo / big-doc ingestion)",
      "multimodal input (images, PDFs, screens)",
      "speed & low cost on the Flash tier",
      "broad scans over a large surface",
      "Google Cloud tasks"
    ],
    weakerAt: [
      "strict JSON/format adherence on the Flash tier",
      "more variable on precise contracts than Claude/GPT"
    ]
  }
};

// task type -> preferred worker order (+ the rationale shown in a recommendation).
export const TASK_ROUTING = {
  "second-opinion": { workers: ["codex", "claude"], why: "independent second opinion from the other strong reasoner" },
  "adversarial-review": { workers: ["codex", "claude", "agy"], why: "adversarial review — deep reasoning + reliable structured findings" },
  review: { workers: ["codex", "claude", "agy"], why: "structured code review" },
  "hard-bug": { workers: ["codex", "claude"], why: "deep reasoning to find a subtle root cause" },
  architecture: { workers: ["codex", "claude"], why: "design reasoning and tradeoff analysis" },
  "design-tradeoff": { workers: ["codex", "claude"], why: "design reasoning and tradeoff analysis" },
  refactor: { workers: ["claude", "codex"], why: "careful, scope-disciplined refactoring" },
  plan: { workers: ["claude", "codex"], why: "implementation planning" },
  "general-swe": { workers: ["claude", "codex"], why: "general software engineering" },
  mechanical: { workers: ["agy", "claude"], why: "fast, low-cost mechanical edits (Gemini Flash)" },
  "bulk-edit": { workers: ["agy", "claude"], why: "high-throughput bulk edits (Gemini Flash)" },
  "quick-fix": { workers: ["agy", "claude"], why: "fast turnaround (Gemini Flash)" },
  "large-context": { workers: ["agy", "codex"], why: "large context window for whole-repo / big-doc ingestion (Gemini)" },
  "broad-scan": { workers: ["agy", "codex"], why: "broad scan over a large surface (Gemini context window)" }
};

export const DEFAULT_ROUTING = { workers: ["claude", "codex", "agy"], why: "general default" };

export const TASK_TYPES = Object.keys(TASK_ROUTING);
