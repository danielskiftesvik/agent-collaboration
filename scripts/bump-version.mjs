#!/usr/bin/env node
// Bump the version across ALL manifests in one shot so they never drift.
// Usage: node scripts/bump-version.mjs <x.y.z>   (or: npm run bump <x.y.z>)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2];

if (!/^\d+\.\d+\.\d+([.-].+)?$/.test(next ?? "")) {
  process.stderr.write("usage: node scripts/bump-version.mjs <x.y.z>\n");
  process.exit(1);
}

const files = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json" // has two "version" fields (marketplace + plugin entry)
];

for (const f of files) {
  const p = path.join(root, f);
  const before = fs.readFileSync(p, "utf8");
  const after = before.replace(/("version"\s*:\s*")\d+\.\d+\.\d+([.-][^"]*)?(")/g, `$1${next}$3`);
  fs.writeFileSync(p, after);
  process.stdout.write(`  ${after === before ? "unchanged" : "bumped  "} ${f} -> ${next}\n`);
}
process.stdout.write(`\nversion is now ${next} — commit, then reinstall/reload the plugin in your harness.\n`);
