#!/usr/bin/env node

// Targeted teardown for the app-server broker spawned by codex-plugin-cc's
// codex-companion. Agent-collaboration scopes CLAUDE_PLUGIN_DATA per job, so the
// broker state loaded here cannot belong to another Codex session or repository.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function parseArgs(tokens) {
  const out = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i]?.replace(/^--/, "");
    if (key) out[key] = tokens[i + 1];
  }
  return out;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const companion = args.companion;
  const workspace = args.workspace;
  const pluginData = args["plugin-data"];
  if (!companion || !workspace || !pluginData) {
    throw new Error("usage: cleanup-codex-broker --companion <path> --workspace <path> --plugin-data <path>");
  }

  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  const libDir = path.join(path.dirname(companion), "lib");
  const lifecyclePath = path.join(libDir, "broker-lifecycle.mjs");
  const processPath = path.join(libDir, "process.mjs");
  if (!fs.existsSync(lifecyclePath) || !fs.existsSync(processPath)) {
    emit({ cleaned: false, reason: "broker lifecycle helpers unavailable" });
    return;
  }

  const lifecycle = await import(pathToFileURL(lifecyclePath).href);
  const processHelpers = await import(pathToFileURL(processPath).href);
  const session = lifecycle.loadBrokerSession(workspace);
  if (!session) {
    emit({ cleaned: false, reason: "no scoped broker session" });
    return;
  }

  let gracefulShutdown = !session.endpoint;
  if (session.endpoint) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve(lifecycle.sendBrokerShutdown(session.endpoint))
          .then(() => { gracefulShutdown = true; })
          .catch(() => {}),
        new Promise((resolve) => { timer = setTimeout(resolve, 750); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  lifecycle.teardownBrokerSession({
    endpoint: session.endpoint ?? null,
    pidFile: session.pidFile ?? null,
    logFile: session.logFile ?? null,
    sessionDir: session.sessionDir ?? null,
    pid: session.pid ?? null,
    killProcess: processHelpers.terminateProcessTree
  });
  lifecycle.clearBrokerSession(workspace);
  emit({ cleaned: true, pid: session.pid ?? null, gracefulShutdown });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
