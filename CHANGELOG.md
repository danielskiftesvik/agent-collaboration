# Changelog

## 0.5.2 - 2026-07-07

- Keep healthy quiet codex reviews alive by watching `.codex` log/session activity and giving codex a wider idle budget.
- Treat unparsed reviewer prose as a completed report, normalize verdict synonyms, and ignore extra top-level review keys.
- Downgrade concurrent/exempt real-checkout edits to `breachWarning` while preserving hard breaches for unsafe worker escapes.
- Mark codex reviewer-only for implementation routing; add visual/multimodal routing to agy.
- Refresh stale background jobs on status reads, harden state locking, add live fallback doctor coverage, and return apply paths/stat.
- Update collaborative-investigation guidance to gate on agreement/no unresolved high-severity objection instead of a numeric threshold.
