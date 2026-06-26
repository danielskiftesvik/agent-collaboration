import agy from "./agy.mjs";
import claude from "./claude.mjs";
import codex from "./codex.mjs";

const REGISTRY = new Map([
  [agy.name, agy],
  [claude.name, claude],
  [codex.name, codex]
]);

export function getAdapter(name) {
  const adapter = REGISTRY.get(name);
  if (!adapter) throw new Error(`unknown adapter: ${name}`);
  return adapter;
}

export function listAdapters() {
  return [...REGISTRY.values()];
}
