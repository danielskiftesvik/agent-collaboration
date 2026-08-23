import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { apply, name, inject } from "../.dsh-plugin/index.js";

test("dsh plugin exports a Cordis apply hook that registers /ac", () => {
  assert.equal(name, "agent-collaboration");
  assert.deepEqual(inject, ["commands"]);
  const prevRoot = process.env.DSH_PLUGIN_ROOT;
  let registered;
  try {
    apply({
      commands: {
        register(def) {
          registered = def;
        }
      }
    });
    assert.equal(registered.name, "ac");
    assert.match(registered.description, /agent-collaboration/);
    assert.equal(typeof registered.handler, "function");
  } finally {
    if (prevRoot === undefined) delete process.env.DSH_PLUGIN_ROOT;
    else process.env.DSH_PLUGIN_ROOT = prevRoot;
  }
});

test("package.json declares dsh.bundle.patch for profile-plugin install", () => {
  const pkg = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
  );
  assert.equal(pkg.dsh?.bundle?.patch, "./.dsh-plugin/cordis.patch.yml");
  assert.equal(pkg.exports["./dsh-plugin"], "./.dsh-plugin/index.js");
});
