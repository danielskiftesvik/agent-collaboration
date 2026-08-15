# Machine orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the assign loop so a standing per-machine orchestrator turn reads the assign body, emits a parsed `done|refuse|rerouted` outcome (never PEER_ACK/`exit 0` → `done`), and Mini wait only succeeds on that first line bound to the assign id.

**Architecture:** Keep assign enqueue-only and presence consume in `peer-receive.mjs`. Add `core/peer-outcome.mjs` for parse + job-terminal handshake (`getJob`/`isTerminalStatus` from `state.mjs`, not `dispatch.mjs`). Orchestrator consume uses `buildOrchestratorPrompt` instead of `buildWakePrompt`. Cursor PEER_ACK stays wake-only and must reply `refuse: wake-only`.

**Tech Stack:** Node 20+ ESM, `node --test`, existing companion CLI. Work only in `.worktrees/peers-grok` on `feat/peers-grok`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-15-machine-orchestrator-design.md` (`8755d8c` plus this plan).
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
- Produces: `parseAssignOutcome(stdout, assignId) → { status, assignId, reason, harness, jobId, body } | null`
- Produces: `finalizeAssignOutcome(parsed, { job } = {}) → { status, reason, harness, jobId, text }`
- `job` is `{ id, status }` or `null`. Terminal statuses are `completed`, `no-changes`, `failed`, `blocked`, `breach`, `conflicted` (same set as `isTerminalStatus` in `core/state.mjs`).

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
    parseAssignOutcome(`assign ${id} done\nharness: grok\nok\n`, id),
    { job: null }
  );
  assert.equal(ping.status, "done");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./test/_isolate-instances.mjs --test --test-name-pattern "parseAssignOutcome|finalizeAssignOutcome" test/peer-handoff.test.mjs`

Expected: FAIL `ERR_MODULE_NOT_FOUND` for `peer-outcome.mjs`.

- [ ] **Step 3: Write minimal implementation**

`core/peer-outcome.mjs`:

```javascript
export const ASSIGN_OUTCOME_RE = /^assign\s+(\S+)\s+(done|refuse|rerouted)\b/m;
const HARNESS_RE = /^harness:\s*(claude|codex|grok|cursor|opencode)\s*$/im;
const JOB_RE = /^job:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im;
const TERMINAL = new Set(["completed", "no-changes", "failed", "blocked", "breach", "conflicted"]);

export function parseAssignOutcome(stdout, assignId) {
  const text = String(stdout || "");
  const matches = [...text.matchAll(new RegExp(ASSIGN_OUTCOME_RE.source, "gm"))];
  const hit = [...matches].reverse().find((m) => m[1] === String(assignId));
  if (!hit) return null;
  const after = text.slice(hit.index + hit[0].length);
  const harness = after.match(HARNESS_RE)?.[1]?.toLowerCase() ?? null;
  const jobId = after.match(JOB_RE)?.[1] ?? null;
  const reason = after.split("\n").map((l) => l.trim()).find((l) => l && !/^harness:/i.test(l) && !/^job:/i.test(l)) || null;
  return { assignId: hit[1], status: hit[2], reason, harness, jobId, body: after.trim() };
}

export function finalizeAssignOutcome(parsed, { job = null } = {}) {
  if (!parsed) {
    return { status: "refuse", reason: "unparsed-outcome", harness: null, jobId: null, text: null };
  }
  if (parsed.status === "done" && parsed.jobId) {
    if (!job || job.id !== parsed.jobId || !TERMINAL.has(String(job.status))) {
      return {
        status: "refuse",
        reason: "job-not-terminal",
        harness: parsed.harness,
        jobId: parsed.jobId,
        text: `assign ${parsed.assignId} refuse: job-not-terminal`
      };
    }
  }
  const lines = [`assign ${parsed.assignId} ${parsed.status}`];
  if (parsed.harness) lines.push(`harness: ${parsed.harness}`);
  if (parsed.jobId) lines.push(`job: ${parsed.jobId}`);
  if (parsed.reason) lines.push(parsed.reason);
  return { status: parsed.status, reason: parsed.reason, harness: parsed.harness, jobId: parsed.jobId, text: lines.join("\n") };
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
- Produces: `pickMachine(rows, { computer, from } = {})` skips session name `main` and `from`

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

test("pickMachine skips session main even when it is idle", () => {
  isolateStateRoot();
  registerPeer({ name: "main", harness: "grok", computer: "Mac Mini M4", sessionId: "main" });
  registerPeer({ name: "mini-orch", harness: "grok", computer: "Mac Mini M4", sessionId: "orch" });
  heartbeatPeer({ name: "main", turnState: "idle" });
  heartbeatPeer({ name: "mini-orch", turnState: "idle" });
  const picked = pickMachine(listMachines(), { from: "main" });
  assert.equal(picked.session.name, "mini-orch");
  assert.notEqual(picked.session.name, "main");
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

In `pickMachine` / `canAssignMachine`:

```javascript
export function canAssignMachine(row, { from } = {}) {
  const name = row?.session?.name;
  if (!name) return false;
  if (name === "main") return false;
  if (from && name === from) return false;
  return Boolean(row?.available && row.activity !== "busy");
}

export function eligibleMachines(rows = [], opts = {}) {
  return rows.filter((row) => canAssignMachine(row, opts));
}

export function pickMachine(rows = [], { computer, from } = {}) {
  const want = computer ? normalizeComputer(computer) : null;
  const pool = eligibleMachines(rows, { from }).filter((r) => !want || r.computer === want);
  // existing sort unchanged
}
```

Update every `eligibleMachines`/`pickMachine` caller in `peer-assign.mjs` and companion assign/pick to pass `{ from: options.from }`.

CLI: add `hint-harness` to `VALUE_FLAGS`; `assignTask({ hintHarness: options["hint-harness"] })`.

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
- Produces: `handleAssignedWork` reply text = `finalizeAssignOutcome(...)`. Cursor `delivered` from PEER_ACK → `refuse: wake-only` unless parsed outcome exists

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
  handleAssignedWork({
    name: "old-orch",
    runWake: ({ args }) => {
      prompt = args.join("\n");
      return { status: 0, stdout: `assign ${msg.id} done\nharness: grok\nlooked\n` };
    }
  });
  assert.match(prompt, /look at the red test/);
  assert.match(prompt, /implement|ping/i);
  assert.doesNotMatch(prompt, /^PEER_ACK /m);
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

`handleAssignedWork` after `tryReceive`:

```javascript
const stdout = result.stdout || result.wakeStdout || "";
let parsed = parseAssignOutcome(stdout, message.id);
if (!parsed && result.reason === "acked-after-PEER_ACK") {
  parsed = { assignId: message.id, status: "refuse", reason: "wake-only", harness: "cursor", jobId: null, body: "" };
}
if (!parsed) {
  parsed = null;
}
let job = null;
if (parsed?.jobId) {
  job = getJob(process.cwd(), parsed.jobId);
}
const outcome = finalizeAssignOutcome(parsed, { job });
const replyText = outcome.text || `assign ${message.id} refuse: ${outcome.reason}`;
```

Check `getJob` signature: `getJob(cwd, id)` uses workspace state. For tests, `appendJob` a terminal job when asserting implement-done. Import `getJob` from `state.mjs` only.

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

## Spec coverage

| Spec requirement | Task |
|---|---|
| Orchestrator turn + policy prompt | 4 |
| No done from PEER_ACK / exit 0 | 1, 4 |
| One enqueue from parsed outcome | 4 |
| hintHarness wire + CLI | 2 |
| wait binds `assign <id> …` | 3 |
| Exclude `main` from pick | 2 |
| done + job id must be terminal | 1, 4 |
| Tests that fail on PEER_ACK-only | 4 |
| No dispatch import | 5 |
| Do not switch 2017 presence in this slice | (docs in 4; no ops task) |

## Placeholder scan

None: no TBD, no “add tests later”, signatures named above.

## Type consistency

- `hintHarness` on send, public message, assignTask, HTTP body.
- `parseAssignOutcome` / `finalizeAssignOutcome` shapes used in Tasks 1, 3, 4.
- `waitForReply({ assignId })` set in Task 3 and companion.
