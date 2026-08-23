import agy from "./agy.mjs";
import claude from "./claude.mjs";
import codex from "./codex.mjs";
import cursor from "./cursor.mjs";
import dsh from "./dsh.mjs";
import grok from "./grok.mjs";
import opencode from "./opencode.mjs";
import qwen from "./qwen.mjs";

const REGISTRY = new Map([
  [agy.name, agy],
  [claude.name, claude],
  [codex.name, codex],
  [cursor.name, cursor],
  [dsh.name, dsh],
  [grok.name, grok],
  [opencode.name, opencode],
  [qwen.name, qwen]
]);

export function getAdapter(name) {
  const adapter = REGISTRY.get(name);
  if (!adapter) throw new Error(`unknown adapter: ${name}`);
  return adapter;
}

export function listAdapters() {
  return [...REGISTRY.values()];
}
