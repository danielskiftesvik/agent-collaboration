# Machine orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the assign loop so a standing per-machine orchestrator turn reads the assign body, emits a parsed `done|refuse|rerouted` outcome (never PEER_ACK/`exit 0` → `done`), and Mini wait only succeeds on that first line bound to the assign id.

**Architecture:** Keep assign enqueue-only and presence consume in `peer-receive.mjs`. Add `core/peer-outcome.mjs` for parse + job-terminal handshake (`getJob`/`isTerminalStatus` from `state.mjs`, not `dispatch.mjs`). Orchestrator consume uses `buildOrchestratorPrompt` instead of `buildWakePrompt`. Cursor PEER_ACK stays wake-only and must reply `refuse: wake-only`.

**Tech Stack:** Node 20+ ESM, `node --test`, existing companion CLI. Work only in `.worktrees/peers-grok` on `feat/peers-grok`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-15-machine-orchestrator-design.md` (Cursor plan challenge `da99d5d5` folded here).
- Peer plane must not import `dispatch.mjs`. Job lookup is `getJob`/`isTerminalStatus` from `state.mjs` or a `status` subprocess.
- No `done` from PEER_ACK or bare exit 0.
- `--harness` on assign remains sender identity; worker hint is `--hint-harness` / `hintHarness`.
- Do not switch live 2017 presence to Grok in this plan.
- Tests drive shipped functions; `runWake` stubs must assert prompt/args, not only `status === 0`.
- TDD: failing test → implement → pass → commit per task.

## File map

| File | Responsibility |
|---|---|
| `core/peer-outcome.mjs` | `parseAssignOutcome`, `finalizeAssignOutcome`, `ASSIGN_OUTCOME_RE` |
| `core/peers.mjs` | `hintHarness` on send/inbox; exclude `main` / `from` from pick |
| `core/peers-serve.mjs` | Forward `hintHarness` on HTTP send |
| `core/peer-assign.mjs` | Pass `hintHarness`; `waitForReply` requires outcome line + assign id |
| `core/peer-receive.mjs` | `buildOrchestratorPrompt`; orchestrator consume; parse then one reply |
| `core/peer-inject-cursor.mjs` | Unchanged PEER_ACK wake; consume must not map it to `done` |
| `scripts/agent-companion.mjs` | `--hint-harness`; assign/wait wiring |
| `test/peer-handoff.test.mjs` | New tests listed in each task |
| `docs/specs/peers-fleet.md` | Consume is orchestrator-first; Cursor wake-only |

---

### Task 1: Outcome parser

**Files:**
- Create: `core/peer-outcome.mjs`
- Test: `test/peer-handoff.test.mjs`
- Modify: none of the consume path yet

**Interfaces:**
- Produces: `ASSIGN_OUTCOME_RE` = `/^assign\s+(\S+)\s+(done|refuse|rerouted)\b/m`
- Produces: `parseAssignOutcome(stdout, assignId) → { status, assignId, reason, harness, jobId, kind, body } | null`
- Produces: `finalizeAssignOutcome(parsed, { job } = {}) → { status, reason, harness, jobId, kind, text }`
- `job` is `{ id, status }` or `null`. Use `isTerminalStatus` from `core/state.mjs` (includes `cancelled`). Do not duplicate the terminal set.
- `done` without `jobId` is legal only if `kind === "ping"`. `done` with a `job:` line requires that job to exist and be terminal. `done` with neither `kind: ping` nor a terminal job → `refuse`.

- [ ] **Step 1: Write the failing tests**

Add to `test/peer-handoff.test.mjs`:

```javascript
import { parseAssignOutcome, finalizeAssignOutcome } from "../core/peer-outcome.mjs";

test("parseAssignOutcome binds id and rejects PEER_ACK-only stdout", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(parseAssignOutcome(`PEER_ACK ${id}\n`, id), null);
  assert.equal(parseAssignOutcome("ok\n", id), null);
  const p = parseAssignOutcome(
    `notes\nassign ${id} rerouted\nharness: cursor\nused cursor; grok down\n`,
    id
  );
  assert.equal(p.status, "rerouted");
  assert.equal(p.harness, "cursor");
  const done = parseAssignOutcome(
    `assign ${id} done\nharness: grok\njob: 11111111-2222-3333-4444-555555555555\nlooked at the test\n`,
    id
  );
  assert.equal(done.status, "done");
  assert.equal(done.jobId, "11111111-2222-3333-4444-555555555555");
  assert.equal(parseAssignOutcome(`assign other-id done\n`, id), null);
});

test("finalizeAssignOutcome refuses done when implement job is not terminal", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const parsed = parseAssignOutcome(
    `assign ${id} done\njob: 11111111-2222-3333-4444-555555555555\n`,
    id
  );
  const refused = finalizeAssignOutcome(parsed, { job: { id: parsed.jobId, status: "running" } });
  assert.equal(refused.status, "refuse");
  assert.match(refused.reason, /job-not-terminal|unparsed/);
  const ping = finalizeAssignOutcome(
    parseAssignOutcome(`assign ${id} done\nkind: ping\nharness: grok\nok\n`, id),
    { job: null }
  );
  assert.equal(ping.status, "done");
  const forged = finalizeAssignOutcome(
    parseAssignOutcome(`assign ${id} done\nharness: grok\nimplemented it\n`, id),
    { job: null }
  );
  assert.equal(forged.status, "refuse");
  const cancelled = finalizeAssignOutcome(
    parseAssignOutcome(`assign ${id} done\njob: 11111111-2222-3333-4444-555555555555\n`, id),
    { job: { id: "11111111-2222-3333-4444-555555555555", status: "cancelled" } }
  );
  assert.equal(cancelled.status, "done");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/_isolate-instances.mjs --test --test-name-pattern "parseAssignOutcome|finalizeAssignOutcome" test/peer-handoff.test.mjs`

Expected: FAIL `ERR_MODULE_NOT_FOUND` for `peer-outcome.mjs`.

- [ ] **Step 3: Write minimal implementation**

`core/peer-outcome.mjs`:

```javascript
import { isTerminalStatus } from "./state.mjs";

export const ASSIGN_OUTCOME_RE = /^assign\s+(\S+)\s+(done|refuse|rerouted)\b/m;
const HARNESS_RE = /^harness:\s*(claude|codex|grok|cursor|opencode)\s*$/im;
const JOB_RE = /^job:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im;
const KIND_RE = /^kind:\s*(ping|implement)\s*$/im;

export function parseAssignOutcome(stdout, assignId) {
  const text = String(stdout || "");
  const matches = [...text.matchAll(new RegExp(ASSIGN_OUTCOME_RE.source, "gm"))];
  const hit = [...matches].reverse().find((m) => m[1] === String(assignId));
  if (!hit) return null;
  const after = text.slice(hit.index + hit[0].length);
  const harness = after.match(HARNESS_RE)?.[1]?.toLowerCase() ?? null;
  const jobId = after.match(JOB_RE)?.[1] ?? null;
  const kind = after.match(KIND_RE)?.[1]?.toLowerCase() ?? null;
  const reason =
    after
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^harness:/i.test(l) && !/^job:/i.test(l) && !/^kind:/i.test(l)) || null;
  return { assignId: hit[1], status: hit[2], reason, harness, jobId, kind, body: after.trim() };
}

export function finalizeAssignOutcome(parsed, { job = null } = {}) {
  if (!parsed) {
    return { status: "refuse", reason: "unparsed-outcome", harness: null, jobId: null, kind: null, text: null };
  }
  if (parsed.status === "done") {
    if (parsed.jobId) {
      if (!job || job.id !== parsed.jobId || !isTerminalStatus(job.status)) {
        return {
          status: "refuse",
          reason: "job-not-terminal",
          harness: parsed.harness,
          jobId: parsed.jobId,
          kind: parsed.kind,
          text: `assign ${parsed.assignId} refuse: job-not-terminal`
        };
      }
    } else if (parsed.kind !== "ping") {
      return {
        status: "refuse",
        reason: "done-needs-ping-or-job",
        harness: parsed.harness,
        jobId: null,
        kind: parsed.kind,
        text: `assign ${parsed.assignId} refuse: done-needs-ping-or-job`
      };
    }
  }
  const lines = [`assign ${parsed.assignId} ${parsed.status}`];
  if (parsed.kind) lines.push(`kind: ${parsed.kind}`);
  if (parsed.harness) lines.push(`harness: ${parsed.harness}`);
  if (parsed.jobId) lines.push(`job: ${parsed.jobId}`);
  if (parsed.reason) lines.push(parsed.reason);
  return {
    status: parsed.status,
    reason: parsed.reason,
    harness: parsed.harness,
    jobId: parsed.jobId,
    kind: parsed.kind,
    text: lines.join("\n")
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/peer-outcome.mjs test/peer-handoff.test.mjs
git commit -m "feat(peers): parse assign outcomes and refuse non-terminal jobs"
```

---

### Task 2: hintHarness on the wire + exclude main from pick

**Files:**
- Modify: `core/peers.mjs` (`sendMessage`, `publicMessage`, `canAssignMachine` / `pickMachine`)
- Modify: `core/peers-serve.mjs` (HTTP `/peers/send` body)
- Modify: `core/peer-assign.mjs` (`assignTask` pass-through)
- Modify: `scripts/agent-companion.mjs` (`VALUE_FLAGS`, assign call)
- Test: `test/peer-handoff.test.mjs`

**Interfaces:**
- Consumes: none from Task 1
- Produces: `sendMessage({ to, from, text, hintHarness, allowCrossMachine })` stores `hintHarness` on the record
- Produces: `publicMessage` includes `hintHarness: string | null`
- Produces: `assignTask({ …, hintHarness })` POSTs `{ to, from, text, hintHarness }`
- Produces: `pickMachine(rows, { computer, from, to } = {})` selects at **session** granularity: walk `row.sessions`, skip `main` and `from`, set `row.session` to the chosen session. If `to` is set, pick that session name even if it is `main`.
- Produces: `assignTask({ …, to })` — explicit session override. CLI `--to <session>`.

- [ ] **Step 1: Write the failing tests**

```javascript
test("sendMessage round-trips hintHarness", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok" });
  const sent = sendMessage({ to: "old-orch", from: "main", text: "look at CI", hintHarness: "grok" });
  assert.equal(sent.hintHarness, "grok");
  assert.equal(readInbox({ name: "old-orch" })[0].hintHarness, "grok");
});

test("pickMachine skips session main even when main is the primary heartbeat", () => {
  isolateStateRoot();
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "orch" });
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4", sessionId: "main" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  heartbeatPeer({ name: "main", turnState: "idle" });
  const picked = pickMachine(listMachines(), { from: "main", computer: "Mac Mini M4" });
  assert.equal(picked.session.name, "mini-orch");
});

test("pickMachine --to main is explicit override", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4", sessionId: "main" });
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "orch" });
  heartbeatPeer({ name: "main", turnState: "idle" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  assert.equal(pickMachine(listMachines(), { to: "main" }).session.name, "main");
});

test("pickMachine skips session main even when from is omitted", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4", sessionId: "main" });
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "orch" });
  heartbeatPeer({ name: "main", turnState: "idle" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  assert.equal(pickMachine(listMachines()).session.name, "mini-orch");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/_isolate-instances.mjs --test --test-name-pattern "hintHarness|skips session main" test/peer-handoff.test.mjs`

Expected: FAIL (`hintHarness` undefined; or pick returns `main` if lastSeen ranks it first).

- [ ] **Step 3: Write minimal implementation**

In `publicMessage`, add `hintHarness: record.hintHarness ?? null`.

In `sendMessage`, accept `hintHarness`, normalize with the same harness set (`claude|codex|grok|cursor|opencode` or null). Store on `msg`.

In HTTP `/peers/send`, pass `hintHarness: body.hintHarness` into `sendMessage`.

In `assignTask` remote and local paths, pass `hintHarness`.

Pick at **session** granularity. Do not drop a whole machine because `row.session` is `main`.

```javascript
function sessionEligible(session, { from, to } = {}) {
  const name = session?.name;
  if (!name) return false;
  if (to) return name === to;
  if (name === "main") return false;
  if (from && name === from) return false;
  return true;
}

export function canAssignMachine(row, opts = {}) {
  if (!row?.available || row.activity === "busy") return false;
  const sessions = row.sessions?.length ? row.sessions : row.session ? [row.session] : [];
  return sessions.some((s) => sessionEligible(s, opts));
}

export function pickMachine(rows = [], { computer, from, to } = {}) {
  const want = computer ? normalizeComputer(computer) : null;
  const pool = [];
  for (const row of rows) {
    if (want && row.computer !== want) continue;
    if (!row.available || row.activity === "busy") continue;
    const sessions = row.sessions?.length ? row.sessions : row.session ? [row.session] : [];
    const sess = sessions.find((s) => sessionEligible(s, { from, to }));
    if (!sess) continue;
    pool.push({ ...row, session: sess });
  }
  // existing idle-first / oldest lastSeen sort on pool
}
```

`assignTask` **must** call:

```javascript
const machine = pickMachine(rows, { computer: toComputer, from, to });
const target = to || machine.session.name;
```

Companion `peers pick` / `peers assign` / `peers eligible` pass `{ from: options.from, to: options.to }`.

CLI: add `hint-harness` and `to` (session name) to `VALUE_FLAGS` if `to` is not already a send flag (it is — reuse `--to` on assign as session override). `assignTask({ hintHarness: options["hint-harness"], to: options.to })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2 plus `node --import ./test/_isolate-instances.mjs --test test/peers.test.mjs test/peer-handoff.test.mjs`

Expected: PASS (existing pick tests still pick `*-orch` / idle workers, not `main`).

- [ ] **Step 5: Commit**

```bash
git add core/peers.mjs core/peers-serve.mjs core/peer-assign.mjs scripts/agent-companion.mjs test/peer-handoff.test.mjs
git commit -m "feat(peers): hintHarness on send and never pick main"
```

---

### Task 3: waitForReply requires the outcome line

**Files:**
- Modify: `core/peer-assign.mjs` (`waitForReply`)
- Test: `test/peer-handoff.test.mjs` (extend the existing `rememberRemoteInbox` / `waitForReply` test)

**Interfaces:**
- Consumes: `ASSIGN_OUTCOME_RE` / `parseAssignOutcome` from Task 1
- Produces: `waitForReply({ …, assignId })` — required for success; ignores other inbox text

- [ ] **Step 1: Write the failing test**

In the existing HTTP wait test (or a new one after it), after a valid send of `assign x done` (wrong shape / wrong id), assert wait does **not** accept it when `assignId` is set:

```javascript
test("waitForReply ignores text that is not assign <id> done|refuse|rerouted", async () => {
  isolateStateRoot();
  registerPeer({ name: "old-orch", harness: "cursor", computer: "2017 MacBook Pro", sessionId: "s" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const { server, url } = await listenPeersServer({ pair: "pair-secret" });
  try {
    const { peersHttp } = await import("../core/peers-serve.mjs");
    const sender = await peersHttp(url, {
      method: "POST",
      path: "/peers/register",
      token: "pair-secret",
      body: { name: "main", harness: "grok", sessionId: "main" }
    });
    sendMessage({ to: "main", from: "old-orch", text: "PEER_ACK nope", allowCrossMachine: true });
    await assert.rejects(
      () =>
        waitForReply({
          name: "main",
          url,
          token: sender.token,
          from: "old-orch",
          assignId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          timeoutMs: 400,
          pollMs: 100
        }),
      (err) => err.code === "PEER_REPLY_TIMEOUT"
    );
    sendMessage({
      to: "main",
      from: "old-orch",
      text: "assign aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee refuse: no-grok\n",
      allowCrossMachine: true
    });
    const reply = await waitForReply({
      name: "main",
      url,
      token: sender.token,
      from: "old-orch",
      assignId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      timeoutMs: 2000,
      pollMs: 100
    });
    assert.match(reply.text, /^assign aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee refuse/);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./test/_isolate-instances.mjs --test --test-name-pattern "waitForReply ignores" test/peer-handoff.test.mjs`

Expected: FAIL — current `waitForReply` returns the PEER_ACK message immediately.

- [ ] **Step 3: Write minimal implementation**

In `waitForReply`, add `assignId`. Import `parseAssignOutcome`. In the `find` callback:

```javascript
const hit = (box.messages || []).find((m) => {
  if (from && m.from !== from) return false;
  if (assignId && !parseAssignOutcome(m.text, assignId)) return false;
  if (!cutoff) return true;
  const ts = Date.parse(m.createdAt ?? "");
  return Number.isFinite(ts) ? ts >= cutoff - 1000 : true;
});
```

Companion `--wait-seconds` already has `result.message.id`; pass `assignId: result.message.id`.

Also change the existing `rememberRemoteInbox stores credentials used by waitForReply` test: it currently waits on `assign x done` with **no** `assignId`. After this task it must either pass `assignId` matching that text or send a correctly shaped `assign <uuid> done` + `kind: ping` line. Do not leave a wait test that succeeds on unbound `assign x done`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./test/_isolate-instances.mjs --test --test-name-pattern "waitForReply" test/peer-handoff.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/peer-assign.mjs scripts/agent-companion.mjs test/peer-handoff.test.mjs
git commit -m "feat(peers): bind waitForReply to assign outcome first line"
```

---

### Task 4: Orchestrator consume + no done from PEER_ACK

**Files:**
- Modify: `core/peer-receive.mjs` (`buildOrchestratorPrompt`, `tryReceive`, `handleAssignedWork`)
- Test: `test/peer-handoff.test.mjs`
- Modify: `docs/specs/peers-fleet.md` (consume is orchestrator-first; Cursor wake-only)

**Interfaces:**
- Consumes: `parseAssignOutcome`, `finalizeAssignOutcome` (Task 1); `message.hintHarness` (Task 2)
- Produces: `buildOrchestratorPrompt({ message })` string containing assign id, `from`, hint, `message.text`, and the words `ping`, `implement`, `hint`, `refuse`
- Produces: `tryReceive` for presence harness grok/claude/codex/opencode uses orchestrator prompt on argv, **not** `buildWakePrompt`
- Produces: `tryReceive` **returns `stdout`** (and `stderr`) on success and failure. Without this, `handleAssignedWork` always sees empty stdout → `unparsed-outcome`.
- Produces: `handleAssignedWork({ name, runWake, resumeProbe, refuse, cwd })`. `cwd` defaults to `process.cwd()`. Job lookup is `getJob(cwd, parsed.jobId)` only.
- Produces: reply text = `finalizeAssignOutcome(...)`. Cursor PEER_ACK → `refuse: wake-only` unless a valid outcome block is also present.

- [ ] **Step 1: Write the failing tests**

```javascript
test("orchestrator consume prompt is not PEER_ACK-only and includes assign body", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok", computer: "2017 MacBook Pro", sessionId: "sess-g" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const msg = sendMessage({
    to: "old-orch",
    from: "main",
    text: "look at the red test",
    hintHarness: "grok"
  });
  let prompt = "";
  const out = handleAssignedWork({
    name: "old-orch",
    runWake: ({ args }) => {
      prompt = args.join("\n");
      return { status: 0, stdout: `assign ${msg.id} done\nkind: ping\nharness: grok\nlooked\n` };
    }
  });
  assert.match(prompt, /look at the red test/);
  assert.match(prompt, /implement|ping/i);
  assert.doesNotMatch(prompt, /^PEER_ACK /m);
  assert.match(out.reply.text, new RegExp(`^assign ${msg.id} done`, "m"));
});

test("implement done requires terminal job via handleAssignedWork cwd", async () => {
  isolateStateRoot();
  const repo = makeRepo();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok", sessionId: "s", computer: "2017 MacBook Pro" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const msg = sendMessage({ to: "old-orch", from: "main", text: "implement the fix" });
  const { appendJob } = await import("../core/state.mjs");
  const job = appendJob(repo, { id: "11111111-2222-3333-4444-555555555555", status: "completed" });
  const out = handleAssignedWork({
    name: "old-orch",
    cwd: repo,
    runWake: () => ({
      status: 0,
      stdout: `assign ${msg.id} done\nkind: implement\njob: ${job.id}\nharness: grok\nfixed\n`
    })
  });
  assert.match(out.reply.text, new RegExp(`^assign ${msg.id} done`));
  assert.match(out.reply.text, /job: 11111111-2222-3333-4444-555555555555/);
});

test("PEER_ACK-only cursor consume does not enqueue assign done", async () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "cursor", computer: "2017 MacBook Pro", sessionId: "sess-c" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const msg = sendMessage({ to: "old-orch", from: "main", text: "run the plate" });
  const out = handleAssignedWork({
    name: "old-orch",
    resumeProbe: () => false,
    runWake: () => ({ status: 0, stdout: `PEER_ACK ${msg.id}\n` })
  });
  assert.equal(out.consumed, true);
  assert.match(out.reply.text, /^assign \S+ refuse: wake-only/m);
  assert.doesNotMatch(out.reply.text, /^assign \S+ done/m);
});

test("hint ignored replies rerouted with harness used", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok", sessionId: "s", computer: "2017 MacBook Pro" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  const msg = sendMessage({
    to: "old-orch",
    from: "main",
    text: "look at CI",
    hintHarness: "grok"
  });
  const out = handleAssignedWork({
    name: "old-orch",
    runWake: () => ({
      status: 0,
      stdout: `assign ${msg.id} rerouted\nharness: cursor\nused cursor; grok down\n`
    })
  });
  assert.match(out.reply.text, new RegExp(`^assign ${msg.id} rerouted`));
  assert.match(out.reply.text, /harness: cursor/);
});

test("exit 0 without outcome is refuse unparsed-outcome", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok" });
  registerPeer({ name: "old-orch", harness: "grok", sessionId: "s", computer: "2017 MacBook Pro" });
  heartbeatPeer({ name: "old-orch", turnState: "idle" });
  sendMessage({ to: "old-orch", from: "main", text: "hi" });
  const out = handleAssignedWork({
    name: "old-orch",
    runWake: () => ({ status: 0, stdout: "ok\n" })
  });
  assert.match(out.reply.text, /refuse: unparsed-outcome/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/_isolate-instances.mjs --test --test-name-pattern "orchestrator consume|PEER_ACK-only cursor|unparsed-outcome" test/peer-handoff.test.mjs`

Expected: FAIL — current code replies `assign <id> done` on PEER_ACK and on grok exit 0.

- [ ] **Step 3: Write minimal implementation**

Add `buildOrchestratorPrompt({ message })` in `peer-receive.mjs`. It must include `message.id`, `message.from`, `message.hintHarness`, `message.text`, and policy words `ping` / `implement` / `hint` / `refuse`. Do not import `dispatch.mjs`.

`tryReceive`: if harness is `grok|codex|opencode|claude` (claude still no fake inject: if no native socket, do **not** spawn; return `native_required` and let `handleAssignedWork` refuse). If spawning grok/codex/opencode, set `prompt: buildOrchestratorPrompt({ message })` in `buildIdleResume`.

**Required:** every `tryReceive` return value that ran `runWake` must include `stdout: String(result?.stdout || "")` (and `stderr` if present), including `acked-after-resume` and `wake-failed` / `acked-after-PEER_ACK`.

`handleAssignedWork({ name, runWake, resumeProbe, refuse, cwd })` after `tryReceive`:

```javascript
const stdout = result.stdout || "";
let parsed = parseAssignOutcome(stdout, message.id);
if (!parsed && /PEER_ACK/.test(stdout)) {
  parsed = { assignId: message.id, status: "refuse", reason: "wake-only", harness: "cursor", jobId: null, kind: null, body: "" };
}
let job = null;
if (parsed?.jobId) {
  job = getJob(cwd || process.cwd(), parsed.jobId);
}
const outcome = finalizeAssignOutcome(parsed, { job });
const replyText = outcome.text || `assign ${message.id} refuse: ${outcome.reason}`;
```

Import `getJob` from `state.mjs` only. Pass `cwd` from tests that `appendJob` into `makeRepo()`.

Update existing `handleAssignedWork` tests that stub `runWake: () => ({ status: 0, stdout: "ok" })` so they expect `refuse: unparsed-outcome` **or** return a valid `assign <id> done` + `kind: ping` block. Update the companion consume CLI test that stubs grok exit 0 and only asserts `consumed` so it either returns a valid outcome block or expects `refuse: unparsed-outcome`. Do not leave stubs that encode the old false-done contract.

Cursor path: if `tryReceive` returns `delivered: true` with reason `acked-after-PEER_ACK`, map to wake-only refuse as above. Do not change Cursor argv (still `--mode ask --trust`).

If `tryReceive` already acked and stdout has a valid outcome (orchestrator), use it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./test/_isolate-instances.mjs --test --test-concurrency=1 test/peer-handoff.test.mjs test/peer-inject-cursor.test.mjs`

Expected: PASS. Existing “deliverInbox uses tryDeliver” still expects Cursor `delivered: true` after PEER_ACK — that is **deliver**, not `handleAssignedWork`. Do not break `deliverInbox`. Only `handleAssignedWork` changes reply mapping.

- [ ] **Step 5: Update fleet doc + commit**

In `docs/specs/peers-fleet.md`, state: default consume is orchestrator prompt; Cursor PEER_ACK is wake-only and cannot yield `assign done`. Do not instruct operators to switch 2017 to Grok until this commit is on the machine.

```bash
git add core/peer-receive.mjs test/peer-handoff.test.mjs docs/specs/peers-fleet.md
git commit -m "feat(peers): orchestrator consume and refuse PEER_ACK-as-done"
```

---

### Task 5: Companion wiring + structural guards

**Files:**
- Modify: `scripts/agent-companion.mjs` (usage strings already need `--hint-harness` from Task 2)
- Test: existing structural tests in `test/peer-handoff.test.mjs` (“stay off the job-plane dispatcher”)

**Interfaces:**
- Consumes: all previous
- Produces: `peer-receive.mjs` / `peer-outcome.mjs` / `peer-assign.mjs` still do not import `dispatch.mjs`

- [ ] **Step 1: Write / extend the structural test**

```javascript
test("assign, receive, presence, outcome, and reply stay off the job-plane dispatcher", () => {
  for (const src of [ASSIGN_SRC, RECEIVE_SRC, PRESENCE_SRC, REPLY_SRC, DELIVER_SRC, OUTCOME_SRC]) {
    const text = fs.readFileSync(src, "utf8");
    assert.doesNotMatch(text, /dispatch\.mjs/);
  }
});
```

Add `OUTCOME_SRC` next to the other `fileURLToPath` constants.

- [ ] **Step 2: Run it**

Run: `node --import ./test/_isolate-instances.mjs --test --test-name-pattern "stay off the job-plane" test/peer-handoff.test.mjs`

Expected: PASS if Task 4 imported `state.mjs` only. FAIL if someone imported `dispatch.mjs`.

- [ ] **Step 3: Run the full peer suite**

Run: `node --import ./test/_isolate-instances.mjs --test --test-concurrency=1 test/peer-handoff.test.mjs test/peers.test.mjs test/peer-inject-cursor.test.mjs test/peers-serve.test.mjs`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/agent-companion.mjs test/peer-handoff.test.mjs
git commit -m "test(peers): keep orchestrator consume off dispatch.mjs"
```

---

## Decisions after Cursor plan challenge (`da99d5d5`)

Accepted and folded: propagate `tryReceive` stdout; pick at session granularity; `--to <session>` override; `isTerminalStatus` (includes `cancelled`); `handleAssignedWork({ cwd })` for `getJob`; require `kind: ping` for job-less `done`; tighten legacy wait/consume stubs; explicit `pickMachine(rows, { from, to })` in assign/pick/eligible.

Rejected as extra scope: presence LaunchAgent cwd injection; HTTP `POST /peers/assign`; Mini forcing a session without `--to`.

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| Orchestrator turn + policy prompt | 4 |
| No done from PEER_ACK / exit 0 | 1, 4 |
| One enqueue from parsed outcome | 4 |
| hintHarness wire + CLI | 2 |
| wait binds `assign <id> …` | 3 |
| Exclude `main` from pick (session-level; `--to` override) | 2 |
| tryReceive returns stdout; handleAssignedWork cwd for getJob | 4 |
| done + job id must be terminal | 1, 4 |
| Tests that fail on PEER_ACK-only | 4 |
| Hint ignored → parsed `rerouted` | 4 |
| No dispatch import | 5 |
| Do not switch 2017 presence in this slice | (docs in 4; no ops task) |

## Placeholder scan

None: no TBD, no “add tests later”, signatures named above.

## Type consistency

- `hintHarness` on send, public message, assignTask, HTTP body.
- `parseAssignOutcome` / `finalizeAssignOutcome` shapes used in Tasks 1, 3, 4.
- `waitForReply({ assignId })` set in Task 3 and companion.
