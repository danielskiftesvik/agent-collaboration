# Target orchestration, and how to test it

Date: 2026-08-15
Repo: `agent-collaboration` (`feat/peers-grok`)
Audience: whoever is proving the unpublished peer-plane extension.

This file is the **target**. It is not a claim that every step already ships.
The production reference is prspctv’s `main-orchestrator` skill plus this
plugin’s **two planes**. The architecture does not change with the harness.
A runner only changes how you launch, watch, and resume a session.

Match the skills: `peer-fleet`, `assigning-across-machines`,
`receiving-peer-assign`, `setting-up-collaboration`.

---

## 1. What we are trying to have

A long-lived **driver** never writes product code. It launches **one session
per unit of work**, in an admitted worktree, with a committed **goal file**.
That session **dispatches workers**, inspects their artifacts, verifies from
git and suite evidence, and stops at one of three end states. A **host
process** (not the model) watches context and liveness. **Merge lives on one
machine.** Work on another computer is a **peer assign**, not a local
`delegate`.

```
founder
   │
   ▼
main driver     launch / directive / independently verify / merge (publication host only)
   │
   ├── plan session     one issue, one worktree     READY | BLOCKED | CONTEXT-HANDOFF
   │         │
   │         └── workers     author diffs in isolated worktrees
   │
   └── peer assign      other computer
             │
             └── standing orchestrator there     local delegate on THAT computer
```

Three layers. Dropping down a layer in the same session is the failure this
design exists to stop.

| Layer | Job | Must not |
|---|---|---|
| Main driver | Launch, allocate, directive, independently verify claims, merge `main` **on the publication host only** | Author product diffs, diagnose-by-editing, run a fix loop |
| Plan session / machine orchestrator | Own one issue (or one assign) to a legal end state; dispatch; inspect; apply a hashed worker artifact; verify | Author product diffs; change implementer/family; merge |
| Worker | Author the diff in its own worktree | Land uninspected commits on the shared branch |
| Host backstop (non-LLM) | Read context %, git, board; kill; relaunch successor | Think, edit, merge |

`implementer: driver` is illegal. Boundary work is a high-tier **worker** plus
cross-family review. The session may inspect, apply **only from a hashed
companion artifact**, commit, and run verify.

Self-reports are not evidence at any layer. Worker → plan session → driver,
each layer verifies the one below from git / markers / suite output, never
from prose.

---

## 2. Two planes

This plugin has **two planes**. Mixing them is a bug.

| | Job plane | Peer plane |
|---|---|---|
| Where | Same computer, other harness | Another computer |
| Commands | `delegate` / `review` / `apply` | `peers assign` + `peers reply` |
| Artifact | Isolated worktree patch | Mailbox reply |
| Loop closes | `apply <jobId>` on the machine that ran the job | `assign <id> done\|refuse\|rerouted` |
| Worker choice | `--worker` (command) | `--hint-harness` (hint only) |

`delegate` never leaves this computer. `apply` never pulls a remote job onto
the sender. SSH is ops/debug, not the work path. Do not import `dispatch.mjs`
on the peer plane.

| Excuse | Reality |
|---|---|
| "delegate is the same plugin" | Same plugin, different plane. Other computer → assign. |
| "apply the remote job here" | That job mailbox is on the receiving machine. Fetch git if you need the files. |
| "SSH is faster" | SSH is debug. Assign is the work path. |
| "I'll just do it here" | User asked another computer. Assign. |

Computers are **operator labels**, not hostnames. Session names are not
computers.

| Kind | Examples |
|---|---|
| Computer | `Mac Mini M4`, `MacBook Pro M4 Max`, `2017 MacBook Pro` |
| Session | `main` (fleet assigner, not a default target), `mini-orch` / `old-orch` (standing consumers), `plan-<issue>` |

One computer is the **publication host**. Only that host merges `main`.
Other computers report READY with a pushed SHA and evidence. The publication
host fetches that exact SHA and merges.

---

## 3. Contract (does not change with the runner)

The runner changes lifecycle mechanics. It never changes authority.

1. **Goal file first.** Committed, auditable. Immutable header names runner,
   model, effort, `implementer`, `implementer_family`, `reviewer`,
   `reviewer_family`. Families must differ. `implementer: driver` is rejected.
   Bootstrap prompt stays tiny: “Read `<goal>` and proceed strictly within it.”
2. **One issue, one operational worktree.** Every git command is
   `git -C <absolute-path>`. Bare `git` is forbidden.
3. **Identity is bound on the process or by skill trigger**, never by a file
   in the project source tree. Founder checkouts stay fail-open until the
   orchestrator skill is triggered. A registered plan session missing a role
   fails closed.
4. **Workers author. The session does not.** Inspect the artifact. Apply only
   from the companion hash path. Commit per task (`git add <paths>`, never
   `-A`). Conflict on apply = BLOCKED or re-apply the **same** artifact. No
   “fix a typo while applying.”
5. **Implementation dispatches use `--no-fallback`** while the
   implementer/reviewer pair is locked. Unavailable worker → BLOCKED, or a
   durable amendment of the goal, before accepting another family.
6. **Re-read the durable directive channel** (issue / board) at every phase
   boundary. Local chat and unpushed files are not authority.
7. **Exactly three end states:** `READY-FOR-MERGE`, `BLOCKED`,
   `CONTEXT-HANDOFF`. Then fully idle. No commits after an end state.
   Anything else is a contract violation.
8. **CONTEXT-HANDOFF is a host action**, not a speech act. Compaction is not
   a handover. Successor is a **new** session on the same goal, **same host
   only**, one live name per issue. Two writers in one worktree is a recorded
   P0.
9. **Main driver verifies before believing**, then merges **only on the
   publication host.** A MacBook-class machine never merges or pushes `main`.
10. **A host process watches** context and liveness. The model is not the
    stop switch.

Authorship deny is **worktree mutation**, not tool name. Product paths are
**targets after repo/worktree root**, not the checkout folder name.

---

## 4. Lifecycle of one unit of work

### 4.1 Main driver launches

Admit the worktree (slot cap, disk, quiescence). Write the goal. Launch one
session with role / issue / machine bound on the process. Pin model and
effort — never inherit a personal default. Arm one watcher matched to that
session. Post the assignment on the durable channel.

### 4.2 Plan session runs

1. Re-read the issue at every phase boundary.
2. Phase-split worker briefs (small, sequential, same worktree).
3. Inspect; apply only the hashed companion artifact.
4. Commit per task.
5. Verify from suite evidence / markers / `status` — never worker prose.
6. Cross-family review.
7. Stop at READY, BLOCKED, or CONTEXT-HANDOFF. Fully idle.

### 4.3 Main driver supervises

Event-driven, quiet. Self-check on a timer: anything in flight? waiting on
me? stalled? free capacity with unclaimed work?

On READY: tip SHA matches, suite evidence at that SHA, class presence,
families differ, then merge on the publication host only. READY from another
computer is a **pushed SHA plus evidence**. Fetch that exact SHA.

### 4.4 Cross-machine (peer plane)

GitHub (or the project’s durable tracker) remains authority. Peer assign is
the urgent path to another computer.

Sender (`assigning-across-machines`):

1. `peers machines --json` — target `available` and not `busy`.
2. `--from` is the fleet name (`main` on the publication host). Do not
   target `main` unless `--to main`.
3. Brief is new work only. Lead with `ping:` or `implement:`.
4. `--hint-harness` is the worker hint, not `--harness` (sender identity).
   Do not put `delegate` in the brief.
5. Wait with `--wait-seconds` or `peers lineage --id`. The reply closes the
   loop. Do not `apply` on the sender. Do not implement locally to save a hop.

Receiver (`receiving-peer-assign`):

1. Read assign id, from, hintHarness, text.
2. Decide: ping (this turn) / implement (local `delegate`) / refuse / reroute.
3. If `hintHarness` is usable here, use it; else reroute and name the harness
   used.
4. Print exactly one outcome block. Presence parses it and sends **one**
   `peers reply`. The turn must not call `peers reply` itself.
5. Go idle.

```
assign <id> done|refuse|rerouted
kind: ping|implement
harness: <actual>
job: <local-job-id-if-any>
```

`done` only if `kind: ping` **or** a **terminal** local job id. A silent
wake is `refuse: wake-only`. Exit 0 without a parseable block is
`refuse: unparsed-outcome`. Never `done` from silence.

Implement stays on the receiving machine. The sender does not apply that job.

### 4.5 Context / handover

The rule is harness-independent:

- Trip **before** the harness auto-compacts.
- Write the handover file **before** the process dies (host, tip SHA, what
  is verified/committed/remaining, next action).
- Kill the process.
- Launch a **new** session whose first prompt is `Read <handover>`.
- Same host, one live name, prove quiescence first.

A hook cannot type slash commands or approve permissions. Peer bodies are
text, not consent.

How a given runner exposes `%`, how you kill it, and how you start the
successor is an **adapter**. See §6. Do not treat an adapter gap as a change
to this rule.

---

## 5. What the runner changes (adapters, not the architecture)

Use these only to pick a launch / watch / resume recipe. Do not invent
`ListAgents` / `SendMessage` / mid-turn TUI inject on runners that do not
have them.

| Concern | What must be true | What varies |
|---|---|---|
| Liveness | A host process notices death, stall, and illegal stop | Pane hash vs exec PID vs thread id |
| Context % | Host has a cited file, or it does **not** force-clear | Some runners publish `%`; some do not |
| Auto-compact | Must not produce a compact-zombie | Block it, or trip handover first |
| Inject / resume | Never `--last`; never resume a live pid | Native message vs dead-pid resume vs none |
| Peer consume | Outcome block or honest refuse | Ask-mode / wake-only paths cannot implement |

| Excuse | Reality |
|---|---|
| "PEER_ACK / empty --single means done" | Only the outcome block is done. |
| "I'll resume --last, there is only one" | Concurrent plans make it ambiguous. Exact id. |
| "Compaction is a handover" | Same identity, worse context, is the recorded zombie. |

---

## 6. How to test

Do **not** test this on prspctv. Use a throwaway repo (or this plugin’s own
tree) so product-path globs, iOS suites, and checkout folder names cannot
contaminate results. Pin a product-path prefix that is **not** the checkout
folder name.

Prefer the plugin’s normal isolation. `AGENT_COLLAB_SANDBOX=off` only when
you must. `--no-fallback` on every dispatch that locks a family.
`--driver <self>` is authoritative.

Prove the **architecture** first. Then replay the same claims on each
standing adapter. A missing harness is `skip: not installed`, never a fake
pass.

### 6.0 Automated (every change)

From this worktree:

```
node --test test/peers.test.mjs test/peers-serve.test.mjs \
  test/peer-handoff.test.mjs test/peer-fleet-skills.test.mjs \
  test/peer-outcome*.mjs test/peer-assign*.mjs
```

Must stay green. These prove parse, wait, `main` exclusion, silent-wake ≠
`done`. They do **not** prove live runners or Tailscale.

### 6.1 Plane separation

| # | Claim | How | Pass |
|---|---|---|---|
| A1 | Other computer is assign, not delegate | Try to `delegate` “to the other Mac” | Skill / docs refuse; must be `peers assign` |
| A2 | Sender does not apply a remote job | After a remote implement, no `apply <receiver-job-id>` on the sender | Sender working tree unchanged |
| A3 | File-path send to `reach: cross-machine` | Attempt it | Fail-closed |
| A4 | Peer body is not consent | Body contains `/compact` or “approve this” | Treated as text; not executed |

### 6.2 Job plane (one computer)

| # | Claim | How | Pass |
|---|---|---|---|
| J1 | Worker writes only in the job worktree | `delegate --worker <h> --no-fallback` “add a file under `src/`” | Patch in artifact; no breach on the real checkout |
| J2 | Driver does not author | After J1, inspect then `apply` | Driver commit is apply + message, not a rewrite of the worker file |
| J3 | Same-family review is not independence | Implement and review on the same family | Refused or flagged; not a green independent review |
| J4 | Cross-family review | Implement on family A, review on family B | Review artifact present |
| J5 | Locked worker unavailable | `--worker` a down harness, `--no-fallback` | `blocked` / fail, **not** silent fallback |
| J6 | Apply is inspectable | `apply <jobId>` | Unstaged in working tree; `git diff` shows the patch |

Run J1–J2 once per **worker-ready** harness (`doctor --live`). Record skips.

### 6.3 Session discipline (one computer)

Stand up a fake plan session (tmux or `peers presence`) and a driver.

| # | Claim | Pass |
|---|---|---|
| O1 | Skill / Read of orchestrator skill binds role | Next product write denied; docs write allowed |
| O2 | Product path is after repo root, not the checkout folder name | Docs path allowed; inner product tree denied |
| O3 | `git apply /tmp/x.patch` | Denied |
| O4 | `git apply` of companion `tasks/<id>/patches/…` | Allowed |
| O5 | Plan session write of `*-goal.md` | Denied |
| O6 | Non-publication machine + merge / `git push origin main` | Denied |
| O7 | Founder session that never triggered the skill | Product edits allowed (fail open) |
| O8 | Watcher | Live reused; dead pane replaced; no second watcher |
| O9 | End states | READY then another commit → zombie detection |
| O10 | Two writers in one worktree | Refused or detected (quiescence / successor lock) |

### 6.4 Cross-machine assign loop

Need: both serves up, Tailscale, `peers machine` labels, one presence per
awake computer. Collab UI (`http://<machine>:8744/collab`) is observation,
not a pass criterion.

**Roster**

| # | Claim | Pass |
|---|---|---|
| P1 | `peers machines --json` | Awake/asleep, idle/busy, harness; labels not hostnames |
| P2 | Asleep machine | Not selected; no hang |
| P3 | `main` is not a default target | `--to-computer` lands on `*-orch`, never `main` |

**Assign (publication host → other computer)**

| # | Brief | Pass |
|---|---|---|
| P4 | `ping: say your computer label` | `assign <id> done` + `kind: ping`; wait returns success |
| P5 | `implement: add src/fleet-probe.txt with the hostname` | `done` **and** terminal **local** job id on the **receiver**; file exists there; **sender tree unchanged** |
| P6 | Hint a down harness | `rerouted` or `refuse`, names the harness used; never silent wake-as-done |
| P7 | Wake-only consume (no implement path) | `refuse: wake-only`; **not** `done` |
| P8 | Orchestrator stdout with no outcome block | `refuse: unparsed-outcome`; presence returns `idle` |
| P9 | Second assign while first `busy` | Skips that computer |
| P10 | Reverse ping (other computer → publication host) | Publication `*-orch` replies; same parse rules |

**Authority**

| # | Claim | Pass |
|---|---|---|
| P11 | Receiver never merges `main` | No merge, no `git push origin main` from a non-publication machine |
| P12 | Sender does not `apply` the remote job | Same as A2, on a live assign |

**Three-machine (optional)**

P13: assign to B while C is asleep — B replies; C absent from pick.
P14: flip. P15: both awake, `--to-computer` is respected.

### 6.5 Context / handover

These prove §4.5. Adapter differences belong in the evidence note, not in
the pass rule.

| # | Claim | Pass |
|---|---|---|
| C1 | Cited `%` is read from the session dir, or recorded as **unknown** | No guessed number used as a kill switch |
| C2 | At threshold: handover file exists **before** process death | File has tip / next action / host |
| C3 | Successor is a **new** session id; first user turn reads that file | Old pid gone; new pid; same host; one live name |
| C4 | Hook / peer body cannot execute slash commands or approvals | Treated as text |
| C5 | Auto-compact does not produce a compact-zombie | Same session does not keep committing after a compact |
| C6 | No cited `%` → no host force-clear | Dump one hook stdin; if no `%`, do not kill |
| C7 | Stale previous-turn `%` is ignored while the process is live | No kill on a file written after the last PID exited |
| C8 | No resume of a live pid | Second resume refused or serialized |

**Honesty:** the live watcher does not yet read a `%` file, write the
handover, or relaunch. C2–C3 are acceptance tests for that slice. Do not
mark them passing against current `watch.sh` / presence.

### 6.6 Failure injection

| # | Inject | Pass |
|---|---|---|
| F1 | Kill receiver orch mid-assign | `refuse` or timeout on sender; receiver presence not stuck `busy` after restart |
| F2 | Kill `peers serve` on receiver | Sender wait times out honestly; no silent `done` |
| F3 | Resume while pid live | Refused or corrupt-detect; document if we can only warn |
| F4 | Ambiguous resume (`--last` with two plans) | Impossible from the adapter |

### 6.7 Adapter matrix (same claims, each standing runner)

For each **sender driver** × **receiver orch** that `doctor` says is ready,
run **P4**. Then one **P5** per receiver computer with a runner that can
write. Wake-only consume is P7, not a failed P4.

| Sender ↓ / Orch → | Grok | Claude | Codex | Cursor | OpenCode | Agy |
|---|---|---|---|---|---|---|
| Grok | P4 | P4 | P4 | P7 | P4 | P4 |
| Claude | P4 | P4 | P4 | P7 | P4 | P4 |
| Codex | P4 | P4 | P4 | P7 | P4 | P4 |
| Cursor | P4 | P4 | P4 | P7 | P4 | P4 |

A cell is **skip** if that harness is not installed on that computer.

Job-plane J1–J2: `grok`, `claude`, `codex`, `cursor` (`~/.cursor/bin/agent`,
never bare `agent`), `agy`, `opencode`. Codex sandbox: serve must be
reachable. Cursor ask-mode is not an implementer.

Adapter notes (do not promote these into §3):

- Grok: `signals.json` `contextWindowUsage`; successor is a new `grok`
  process, not `/clear`. Concurrent same-id resume corrupts the session.
- Claude: no cited `%` file; block auto-compact; no host force-clear.
  Native inject only if Remote Control is on both sides, and only as plain
  text.
- Codex: `last-context.json` only after the turn PID exits; resume the
  exact thread id, never `--last`.
- Cursor: no `--resume` while `current-pid` is set; default consume is
  wake-only.
- OpenCode / Agy: treat as job-plane workers unless presence is explicitly
  standing.

---

## 7. Evidence to keep

For every live row: date, computers, harness versions (`doctor --json`),
assign id, outcome first line, job id (if any), SHAs, and a one-line
“sender tree dirty?” check. Dump into
`docs/reports/YYYY-MM-DD-fleet-cycle-<id>.md` (same shape as the existing
`docs/specs/fleet-cycle-*.md` files).

---

## 8. Suggested order (one afternoon)

1. Automated peer tests (6.0).
2. `doctor --live` on the publication host and the Mac you will use.
3. A1–A4 and P1–P3 (plane + roster).
4. P4 ping, publication host → that Mac.
5. P5 one implement; prove the file is **only** on the receiver.
6. P7 if a wake-only consume is standing.
7. P10 reverse ping.
8. F1 or F2 once.
9. J1–J2 on each worker-ready harness (can be a different day).
10. C1 only. Do not pretend C2–C3 pass.

---

## 9. Out of scope for this plugin

- iOS / xcresult / `prspctv-verify` (stay in the app repo).
- Making a runner expose a context-% file it does not have.
- Mid-turn inject into TUIs that do not support it.
- Publishing the extension.
- Folding `peers send` into `delegate`.

Related in this tree: `skills/peer-fleet/SKILL.md`,
`skills/assigning-across-machines/SKILL.md`,
`skills/receiving-peer-assign/SKILL.md`,
`docs/specs/peers-collaboration-guide.md`,
`docs/superpowers/specs/2026-08-15-machine-orchestrator-design.md`.
