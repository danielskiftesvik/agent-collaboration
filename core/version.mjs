// Single source of truth for the running version: package.json. Surfaced by the
// CLI (`version`, and in `setup`/`doctor`) so you can confirm which build your
// agents are actually running. Keep manifests in sync with `npm run bump <x.y.z>`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached;

export function version() {
  if (cached) return cached;
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
    cached = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
