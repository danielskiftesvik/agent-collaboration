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
    strongerAt: [
      "speed & low cost on the Flash tier (high-throughput mechanical work)",
      "multimodal input (images, PDFs, screens)",
      "large context windows for whole-repo / big-doc work"
    ],
    weakerAt: [
      "trails Claude/GPT-5.x on confirmed coding benchmarks (~7-8 pts behind on SWE-bench Verified; bottom of the standardized Pro cluster)",
      "strict JSON adherence on the Flash tier (verified in this project)",
      "its often-cited 1M-token context *advantage* over rivals did NOT survive verification"
    ]
  }
};

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
  mechanical: { workers: ["agy", "claude"], why: "Gemini Flash — fast/cheap (cost-based, not benchmark-confirmed)" },
  "bulk-edit": { workers: ["agy", "claude"], why: "Gemini Flash — high-throughput (cost-based, not benchmark-confirmed)" },
  "quick-fix": { workers: ["agy", "claude"], why: "Gemini Flash — fast turnaround (cost-based, not benchmark-confirmed)" },
  "large-context": { workers: ["agy", "codex"], why: "Gemini for big scans on cost; context-size advantage unconfirmed" },
  "broad-scan": { workers: ["agy", "codex"], why: "Gemini for big scans on cost; context-size advantage unconfirmed" }
};

export const DEFAULT_ROUTING = { workers: ["claude", "codex", "agy"], why: "general default" };

export const TASK_TYPES = Object.keys(TASK_ROUTING);
