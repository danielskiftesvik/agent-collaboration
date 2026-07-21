// Underlying-model capability profiles + task routing.
//
// GROUNDED IN RESEARCH (current frontier-model review; citations in
// skills/harness-prompting/references/model-strengths.md). Single source of truth
// for `recommend`. Two hard caveats are baked in:
//   1. HARNESS > MODEL noise — the agent harness/scaffolding swings coding
//      benchmarks 10-24 points on identical model weights, so these are
//      model+HARNESS tendencies and cross-vendor rankings only hold on
//      same-scaffold benchmarks.
//   2. Frontier models ship ~monthly and rankings decay fast — version-stamped as
//      of the current release. Edit this file as they evolve, and weigh task fit over vendor.
// Qualitative on purpose (no hardcoded percentages — they go stale in weeks).

export const MODEL_PROFILES = {
  claude: {
    harness: "claude",
    model: "Claude 5 / Opus 4.8 + Sonnet (Anthropic, current)",
    vendor: "Anthropic",
    strongerAt: [
      "general software engineering & careful refactoring",
      "long-horizon agentic terminal work",
      "instruction-following & scope discipline (less over-reach)",
      "implementation planning & clear explanation"
    ],
    weakerAt: [
      "some hardest adversarial reviews benefit from a second codex pass",
      "raw speed/cost vs Gemini Flash"
    ]
  },
  codex: {
    harness: "codex",
    model: "Codex / GPT-5.x (OpenAI, current)",
    vendor: "OpenAI",
    canWrite: true,
    idleMsOverride: 1800000,
    strongerAt: [
      "hardest contamination-resistant debugging & reasoning",
      "algorithmic problems & math",
      "subtle bug-finding & adversarial/critical analysis"
    ],
    weakerAt: [
      "slower and sometimes quieter than other write-workers on large patches",
      "sandbox friction when used as an implementer or driver"
    ]
  },
  agy: {
    harness: "agy",
    model: "Gemini 3.x Pro / Flash (Google, current)",
    vendor: "Google",
    // We fixed the patch-harvesting bug using agy-worker.jsonl!
    // agy can now safely deliver patches via the runtime.
    canWrite: true,
    strongerAt: [
      "fast, reliable structured REVIEW (verified 2/2 planted-bug recall, 0 false positives)",
      "fast mechanical/bulk/quick edits through the companion's patch-harvesting path",
      "multimodal input (images, PDFs, screens)",
      "speed & low cost on the Flash tier for read/scan work"
    ],
    weakerAt: [
      "weaker than Claude/codex on the deepest coding-reasoning reviews",
      "its often-cited 1M-token context *advantage* over rivals did NOT survive verification"
    ]
  },
  opencode: {
    harness: "opencode",
    model: "varies (user-configured provider/model — set via AGENT_COLLAB_OPENCODE_MODEL or --model)",
    vendor: "multi-provider (Anthropic, OpenAI, Google, DeepSeek, local, etc.)",
    canWrite: true,
    explicitOnly: true,
    cleanEnv: false,
    strongerAt: [
      "multi-provider flexibility — can route to any configured model",
      "works with any provider the user has configured in opencode",
      "ideal when you want to use a specific model not available through the other harnesses"
    ],
    weakerAt: [
      "model capability varies entirely by user config — not deterministic",
      "explicitOnly: true — never auto-selected; requires --worker opencode or a dedicated routing entry",
      "no thread-resume mechanism (buildRetryCommand); retry is always a full re-send that repeats side effects",
      "--auto permission model is broader than other harnesses' per-role permission scoping"
    ]
  },
  qwen: {
    harness: "qwen",
    model: "local (LM Studio, whatever's currently loaded — Qwen Code CLI as agent scaffold)",
    vendor: "local / self-hosted",
    canWrite: true,
    explicitOnly: true,
    cleanEnv: true,
    idleMsOverride: 1800000,
    strongerAt: [
      "keeps sensitive/local data off any cloud API entirely",
      "zero cost, zero rate limit, works offline",
      "independently-trained model family — useful diversity for a confidence-gate second opinion"
    ],
    weakerAt: [
      "meaningfully weaker reasoning/instruction-following than frontier cloud models at 9-30B local scale",
      "small context budget relative to cloud harnesses; slow; LM Studio serves one model at a time (concurrent jobs serialize)",
      "never auto-selected — always requires --worker qwen or an explicit local-only/plan-execution task"
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
  "design-tradeoff",
  "plan-execution"
]);

// task type -> preferred worker order (+ the rationale shown in a recommendation).
export const TASK_ROUTING = {
  "second-opinion": { workers: ["codex", "claude"], why: "independent second opinion from the other strong reasoner" },
  "adversarial-review": { workers: ["codex", "claude", "agy"], why: "adversarial review — default to a strong reasoner (structured-review routing is under-benchmarked)" },
  review: { workers: ["codex", "claude", "agy"], why: "code review — default to a strong reasoner (under-benchmarked)" },
  "hard-bug": { workers: ["claude", "codex", "agy"], why: "deep implementation debugging — Claude for disciplined edits, codex for hard reasoning, agy as fast fallback" },
  architecture: { workers: ["claude", "codex", "agy"], why: "implementation planning — Claude for scope discipline, codex for deep analysis, agy as fast fallback" },
  "design-tradeoff": { workers: ["claude", "codex", "agy"], why: "design work — Claude for scope discipline, codex for deep analysis, agy as fast fallback" },
  refactor: { workers: ["claude", "agy", "codex"], why: "Claude for careful implementation; agy as fast fallback; codex remains available for harder cases" },
  plan: { workers: ["claude", "codex"], why: "Claude's planning + scope discipline" },
  "general-swe": { workers: ["claude", "agy", "codex"], why: "Claude for implementation; agy as fast fallback; codex remains available for harder cases" },
  mechanical: { workers: ["agy", "claude", "codex"], why: "fast mechanical edits — agy first, with Claude/codex available as write-workers" },
  "bulk-edit": { workers: ["agy", "claude", "codex"], why: "high-throughput edits — agy speed/cost first, with Claude/codex available as write-workers" },
  "quick-fix": { workers: ["agy", "claude", "codex"], why: "quick fix — agy first, with Claude/codex available as write-workers" },
  "large-context": { workers: ["agy", "codex"], why: "Gemini for big scans on cost; context-size advantage unconfirmed" },
  "broad-scan": { workers: ["agy", "codex"], why: "Gemini for big scans on cost; context-size advantage unconfirmed" },
  visual: { workers: ["agy"], why: "Gemini is the multimodal/visual specialist" },
  multimodal: { workers: ["agy"], why: "Gemini is the multimodal/visual specialist" },
  "local-only": { workers: ["qwen"], strict: true, why: "task explicitly marked sensitive/local-only — never substitute a cloud harness" },
  "plan-execution": { workers: ["qwen"], strict: true, why: "brief is a pre-written implementation plan — a narrow enough job for a local model, and never substitute a cloud harness for an explicitly local-only route" }
};

export const DEFAULT_ROUTING = { workers: ["claude", "codex", "agy"], why: "general default" };

export const TASK_TYPES = Object.keys(TASK_ROUTING);
