import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveWorkerRef,
  withEnvOverlay,
  sandboxDirsFromOverlay,
  listConfiguredInstances,
  _clearInstanceCache,
  expandHome
} from "../core/instances.mjs";
import { decideRoute, resolveSandbox, runWithFallback } from "../core/dispatch.mjs";
import { getAdapter } from "../adapters/index.mjs";
import { generateMacSandboxProfile } from "../core/process.mjs";
import { runOk } from "../core/process.mjs";

function tmpDir(prefix = "ac-inst-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function withUserConfig(cfg, fn) {
  const dir = tmpDir("ac-ucfg-");
  const userFile = path.join(dir, "config.json");
  writeJson(userFile, cfg);
  const prev = process.env.AGENT_COLLAB_INSTANCE_CONFIG;
  process.env.AGENT_COLLAB_INSTANCE_CONFIG = userFile;
  _clearInstanceCache();
  try {
    return fn({ dir, userFile });
  } finally {
    if (prev === undefined) delete process.env.AGENT_COLLAB_INSTANCE_CONFIG;
    else process.env.AGENT_COLLAB_INSTANCE_CONFIG = prev;
    _clearInstanceCache();
  }
}

test("expandHome resolves ~", () => {
  assert.equal(expandHome("~/foo"), path.join(os.homedir(), "foo"));
});

test("built-in harness with no config is identity", () => {
  withUserConfig({}, () => {
    const ref = resolveWorkerRef("codex");
    assert.equal(ref.label, "codex");
    assert.equal(ref.harness, "codex");
    assert.equal(ref.instance, null);
    assert.equal(ref.hasOverlay, false);
  });
});

test("instance alias resolves env + bin overlay", () => {
  const dir = tmpDir();
  const home = path.join(dir, "codex-biz");
  const bin = path.join(dir, "claude-local");
  fs.writeFileSync(bin, "#!/bin/sh\necho ok\n");
  withUserConfig(
    {
      instances: {
        "codex-business": {
          harness: "codex",
          env: { CODEX_HOME: home }
        },
        "claude-local": {
          harness: "claude",
          bin
        }
      }
    },
    () => {
      const codex = resolveWorkerRef("codex-business");
      assert.equal(codex.label, "codex-business");
      assert.equal(codex.harness, "codex");
      assert.equal(codex.env.CODEX_HOME, home);
      assert.equal(codex.overlay.CODEX_HOME, home);
      assert.equal(codex.hasOverlay, true);

      const claude = resolveWorkerRef("claude-local");
      assert.equal(claude.harness, "claude");
      assert.equal(claude.bin, bin);
      assert.equal(claude.overlay.AGENT_COLLAB_CLAUDE_BIN, bin);
    }
  );
});

test("defaults.codex redirects bare codex to instance; missing default fails loud", () => {
  const dir = tmpDir();
  withUserConfig(
    {
      instances: {
        "codex-business": { harness: "codex", env: { CODEX_HOME: path.join(dir, "biz") } }
      },
      defaults: { codex: "codex-business" }
    },
    () => {
      const ref = resolveWorkerRef("codex");
      assert.equal(ref.label, "codex-business");
      assert.equal(ref.harness, "codex");
      assert.ok(ref.hasOverlay);
    }
  );

  withUserConfig({ defaults: { codex: "missing" } }, () => {
    assert.throws(() => resolveWorkerRef("codex"), /unknown instance "missing"/);
  });
});

test("disallowed env keys and harness name shadowing are rejected", () => {
  withUserConfig(
    {
      instances: {
        sneaky: { harness: "claude", env: { AWS_SECRET_ACCESS_KEY: "x" } }
      }
    },
    () => {
      assert.throws(() => resolveWorkerRef("sneaky"), /not allowlisted/);
    }
  );

  withUserConfig(
    {
      instances: {
        claude: { harness: "claude", bin: "/x" }
      }
    },
    () => {
      assert.throws(() => resolveWorkerRef("claude"), /cannot redefine|shadow/);
    }
  );
});

test("withEnvOverlay restores process.env after buildCommand", () => {
  const prev = process.env.AGENT_COLLAB_CLAUDE_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
  const bin = "/tmp/fake-claude-bin-for-test";
  const cmd = withEnvOverlay({ AGENT_COLLAB_CLAUDE_BIN: bin }, () =>
    getAdapter("claude").buildCommand({ role: "reviewer", brief: "x", workspace: "/w" })
  );
  assert.equal(cmd.command, bin);
  assert.equal(process.env.AGENT_COLLAB_CLAUDE_BIN, undefined);
  if (prev !== undefined) process.env.AGENT_COLLAB_CLAUDE_BIN = prev;
});

test("decideRoute: instance overlay is cross even when harness matches driver", () => {
  withUserConfig(
    {
      instances: {
        "codex-business": { harness: "codex", env: { CODEX_HOME: path.join(tmpDir(), "biz") } }
      }
    },
    () => {
      const route = decideRoute({ driver: "codex", worker: "codex-business" });
      assert.equal(route.mode, "cross");
      assert.equal(route.harness, "codex");

      const native = decideRoute({ driver: "codex", worker: "codex" });
      assert.equal(native.mode, "native");
    }
  );
});

test("resolveSandbox uses harness identity (codex is never sandboxed)", () => {
  assert.equal(resolveSandbox({ worker: "codex", config: { sandbox: true } }).sandbox, false);
});

test("sandbox profile allows extra instance home dirs", () => {
  const extra = path.join(os.homedir(), ".codex-business-test-dir");
  const profile = generateMacSandboxProfile("/ws", "/art", { extraHarnessDirs: [extra] });
  assert.match(profile, /codex-business-test-dir/);
});

test("sandboxDirsFromOverlay extracts CODEX_HOME", () => {
  const home = path.join(os.homedir(), ".codex-business");
  assert.deepEqual(sandboxDirsFromOverlay({ CODEX_HOME: "~/.codex-business" }), [
    path.resolve(home)
  ]);
});

test("listConfiguredInstances surfaces defaults", () => {
  withUserConfig(
    {
      instances: {
        "codex-business": { harness: "codex", env: { CODEX_HOME: "~/.codex-business" } }
      },
      defaults: { codex: "codex-business" }
    },
    () => {
      const list = listConfiguredInstances();
      assert.equal(list.length, 1);
      assert.deepEqual(list[0].defaultFor, ["codex"]);
    }
  );
});

test("runWithFallback on qwen alias does not append cloud harnesses", () => {
  const repo = tmpDir("ac-qwen-fb-");
  runOk("git", ["init", "-q", "-b", "main"], { cwd: repo });
  runOk("git", ["config", "user.email", "t@t"], { cwd: repo });
  runOk("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  runOk("git", ["add", "-A"], { cwd: repo });
  runOk("git", ["commit", "-q", "-m", "s"], { cwd: repo });

  const stub = path.join(repo, "fail.mjs");
  fs.writeFileSync(
    stub,
    "#!/usr/bin/env node\nif (process.argv.includes('--version')) { process.stdout.write('qwen 0.0.0\\n'); process.exit(0); }\nprocess.stderr.write('429 rate limit\\n'); process.exit(1);\n"
  );
  fs.chmodSync(stub, 0o755);
  // Keep the review surface unambiguous (no dirty checkout).
  runOk("git", ["add", "-A"], { cwd: repo });
  runOk("git", ["commit", "-q", "-m", "stub"], { cwd: repo });

  withUserConfig(
    {
      instances: {
        "qwen-local": { harness: "qwen", bin: stub }
      }
    },
    () => {
      const prevData = process.env.AGENT_COLLAB_DATA;
      process.env.AGENT_COLLAB_DATA = path.join(repo, "data");
      try {
        const res = runWithFallback(repo, {
          driver: "claude",
          worker: "qwen-local",
          role: "reviewer",
          brief: "review nothing",
          kind: "review",
          surface: "head",
          available: ["claude", "codex", "agy", "qwen"],
          maxAttempts: 1,
          fallbackKinds: new Set(["rate-limit"])
        });
        // exclusive explicitOnly: only qwen-local ran; no cloud fallback
        assert.equal(res.worker, "qwen-local");
        assert.equal(res.harness, "qwen");
        assert.equal(res.status, "failed");
        assert.equal(res.failureKind, "rate-limit");
        assert.equal(res.allWorkersLimited, true);
        assert.equal((res.fellBackFrom || []).length, 1);
        assert.equal(res.fellBackFrom[0].worker, "qwen-local");
      } finally {
        if (prevData === undefined) delete process.env.AGENT_COLLAB_DATA;
        else process.env.AGENT_COLLAB_DATA = prevData;
      }
    }
  );
});

test("claude-local instance buildCommand uses the instance bin", () => {
  const bin = path.join(tmpDir(), "my-claude");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  withUserConfig(
    {
      instances: {
        "claude-local": { harness: "claude", bin }
      }
    },
    () => {
      const ref = resolveWorkerRef("claude-local");
      const cmd = withEnvOverlay(ref.overlay, () =>
        getAdapter(ref.harness).buildCommand({ role: "reviewer", brief: "x", workspace: "/w" })
      );
      assert.equal(cmd.command, bin);
    }
  );
});
