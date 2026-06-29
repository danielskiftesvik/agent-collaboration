// Underlying-model capability profiles + task routing.
//
// GROUNDED IN RESEARCH (mid-2026 frontier-model review; citations in
// skills/harness-prompting/references/model-strengths.md). Single source of truth
// for `recommend`. Two hard caveats are baked in:
//   1. HARNESS > MODEL noise — the agent harness/scaffolding swings coding
//      benchmarks 10-24 points on identical model weights, so these are
//      model+HARNESS tendencies and cross-vendor rankings only hold on
//      same-scaffold benchmarks.
//   2. Frontier models ship ~monthly and rankings decay fast — version-stamped as
//      of mid-2026. Edit this file as they evolve, and weigh task fit over vendor.
// Qualitative on purpose (no hardcoded percentages — they go stale in weeks).

export const MODEL_PROFILES = {
  claude: {
    harness: "claude",
    model: "Claude Opus 4.7+/Sonnet (Anthropic, mid-2026)",
    vendor: "Anthropic",
    strongerAt: [
      "general software engineering & careful refactoring (leads SWE-bench Verified + Terminal-Bench 2.0)",
      "long-horizon agentic terminal work",
      "instruction-following & scope discipline (less over-reach)",
      "implementation planning & clear explanation"
    ],
    weakerAt: [
      "the hardest contamination-resistant set (trails GPT-5.x on standardized SWE-bench Pro)",
      "raw speed/cost vs Gemini Flash"
    ]
  },
  codex: {
    harness: "codex",
    model: "GPT-5.x / Codex (OpenAI, GPT-5.4/5.5, mid-2026)",
    vendor: "OpenAI",
    strongerAt: [
      "hardest contamination-resistant debugging & reasoning (leads the standardized SWE-bench Pro)",
      "algorithmic problems & math",
      "subtle bug-finding & adversarial/critical analysis"
    ],
    weakerAt: [
      "trails the latest Claude on the near-saturated Verified / Terminal-Bench agentic sets",
      "sandbox friction when used as a driver"
    ]
  },
  agy: {
    harness: "agy",
    model: "Gemini 3.x (3.1 Pro / Flash, Google, mid-2026)",
    vendor: "Google",
    // We fixed the patch-harvesting bug using agy-worker.jsonl!
    // agy can now safely deliver patches via the runtime.
    canWrite: true,
    strongerAt: [
      "fast, reliable structured REVIEW (verified 2/2 planted-bug recall, 0 false positives)",
      "multimodal input (images, PDFs, screens)",
      "speed & low cost on the Flash tier for read/scan work"
    ],
    weakerAt: [
      "trails Claude/GPT-5.x on confirmed coding benchmarks (~7-8 pts behind on SWE-bench Verified)",
      "its often-cited 1M-token context *advantage* over rivals did NOT survive verification"
    ]
  }
};

// Task types that PRODUCE code (a worker writing a patch). A harness with
// canWrite:false is excluded from these by `recommend`.
export const WRITE_TASKS = new Set([
  "mechanical",
  "bulk-edit",
  "quick-fix",
  "refactor",
  "general-swe",
  "hard-bug",
  "architecture",
  "design-tradeoff"
]);

// task type -> preferred worker order (+ the rationale shown in a recommendation).
export const TASK_ROUTING = {
  "second-opinion": { workers: ["codex", "claude"], why: "independent second opinion from the other strong reasoner" },
  "adversarial-review": { workers: ["codex", "claude", "agy"], why: "adversarial review — default to a strong reasoner (structured-review routing is under-benchmarked)" },
  review: { workers: ["codex", "claude", "agy"], why: "code review — default to a strong reasoner (under-benchmarked)" },
  "hard-bug": { workers: ["codex", "claude"], why: "GPT-5.x leads the contamination-resistant SWE-bench Pro" },
  architecture: { workers: ["codex", "claude"], why: "deep reasoning (GPT-5.x leads the hardest standardized set)" },
  "design-tradeoff": { workers: ["codex", "claude"], why: "deep reasoning (GPT-5.x leads the hardest standardized set)" },
  refactor: { workers: ["claude", "codex"], why: "Claude leads SWE-bench Verified + Terminal-Bench 2.0" },
  plan: { workers: ["claude", "codex"], why: "Claude's planning + scope discipline" },
  "general-swe": { workers: ["claude", "codex"], why: "Claude leads SWE-bench Verified + Terminal-Bench 2.0" },
  mechanical: { workers: ["claude", "codex"], why: "fast mechanical edits — agy can't deliver patches through the runtime (reviewer-only)" },
  "bulk-edit": { workers: ["claude", "codex"], why: "high-throughput edits — agy can't write through the runtime (reviewer-only)" },
  "quick-fix": { workers: ["claude", "codex"], why: "quick fix — agy can't deliver patches through the runtime (reviewer-only)" },
  "large-context": { workers: ["agy", "codex"], why: "Gemini for big scans on cost; context-size advantage unconfirmed" },
  "broad-scan": { workers: ["agy", "codex"], why: "Gemini for big scans on cost; context-size advantage unconfirmed" }
};

export const DEFAULT_ROUTING = { workers: ["claude", "codex", "agy"], why: "general default" };

export const TASK_TYPES = Object.keys(TASK_ROUTING);
