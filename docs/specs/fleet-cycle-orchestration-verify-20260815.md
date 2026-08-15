# Fleet cycle: orchestration-spec verify

Date: 2026-08-15
Branch: `feat/peers-grok` (`b8ffec2` + session-live lsof tighten)
Computers: Mac Mini M4 (publication host), 2017 MacBook Pro (awake), M4 Max asleep
Mini doctor ready: agy, claude, codex, cursor, grok, opencode
Do not merge `main`.

## 6.0 Automated

`node --import ./test/_isolate-instances.mjs --test test/peers.test.mjs test/peers-serve.test.mjs test/peer-handoff.test.mjs test/peer-fleet-skills.test.mjs test/orchestration-workflow.test.mjs`

Pass. (There is no separate `test/peer-outcome*.mjs`; parse lives in `peer-handoff`.)

## Planes / job plane

| ID | Result | Evidence |
|---|---|---|
| A1 | pass | `test/orchestration-workflow.test.mjs` skills forbid delegate-to-other-Mac |
| A2 | pass | `applyResult` unknown job → `applied:false`; sender tree unchanged |
| A3 | pass | `cross-machine send fails closed` in `test/peers.test.mjs` |
| A4 | pass | slash `/compact` `isConsent:false` |
| J1 | pass | real `runWithFallback` + stub worker writes `src/` only in artifact |
| J2 / J6 | pass | `applyResult` lands file; git status `?? src/` (unstaged) |
| J3 | skip | same-family review is a prspctv goal-file gate |
| J4 | skip | capability exists (`review --worker`); not re-run live this cycle |
| J5 | pass | `fallback:false` stays on failed agy, does not complete as claude |
| O1–O10 | skip | app-repo orchestrator skill / hooks (spec) |

## Cross-machine / consume

| ID | Result | Evidence |
|---|---|---|
| P1 | pass | live `peers machines --json`: Mini + 2017 available/idle/grok; M4 Max unreachable |
| P2 | pass | M4 Max not picked |
| P3 | pass | tests: pick skips `main` |
| P4 | pass | assign `e04370a7` Mini→mini-orch `done` `kind: ping` `harness: grok` `roster label Mac Mini M4` |
| P5 | pass* | assign `f6eda618` `done` `kind: implement` `harness: grok` `job: 1f7cbad8` (lineage terminal). Job record `conflicted`. Sender checkout was not the job worktree. |
| P6 | pass | parse + handleAssignedWork reroute tests |
| P7 | pass | earlier live Cursor `refuse: wake-only`; tests |
| P8 | pass | stub-mini consume `010481f8` `refuse: unparsed-outcome`; idle after |
| P9 | pass | assignTask skip-busy tests |
| P10 | skip this cycle | reverse ping proven earlier; not re-run |
| P11 | skip | policy; 2017 cannot push origin |
| P12 | pass | A2 |
| P13–P15 | skip | optional three-machine |
| C1 | skip | no cited `%` used as kill switch |
| C2–C3 | skip | spec honesty: watcher not in this plugin |
| C4 | pass | A4 |
| C8 / F3 | pass | `resumeProbe` → `refuse: session-live`, no `--single`. Live probe uses `lsof` on session files, not leftover locks. |
| F1 / F2 | skip | not injected this cycle |
| F4 | pass | adapters never `--last` when session id is set (codex only if missing) |

## Workflow through the plugin

1. Dedicated consume session (`grok --single` once) → presence `--session-id`.
2. `peers assign --from main --to-computer "Mac Mini M4"`.
3. Presence consume → outcome block → `peers reply`.
4. Sender wait returns. No sender `apply` of the remote job.

Standing TUI on that same session is `refuse: session-live` (do not `--single` over it).

2017 `old-orch` still runs the pre-`session-live` binary until that checkout pulls this branch.
