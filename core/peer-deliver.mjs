// Harness router + inbox consumer. peers send never imports this for auto-wake.
import { tryReceive } from "./peer-receive.mjs";
import { getPeer, readInbox } from "./peers.mjs";

export function tryDeliver({ peer, message, runWake, resumeProbe, claimed } = {}) {
  return tryReceive({ peer, message, runWake, resumeProbe, claimed });
}

/**
 * Deliver unacked inbox messages. Does not hold the peers write lock across spawn
 * (readInbox is lock-free; ack happens inside tryDeliver after wake confirms).
 */
export function deliverInbox({ name, limit = 1, runWake, resumeProbe } = {}) {
  const peer = getPeer(name);
  if (!peer) throw new Error(`unknown peer: ${name}`);
  const messages = readInbox({ name });
  const max = Math.max(0, Number(limit) || 1);
  const results = [];
  for (const message of messages.slice(0, max)) {
    const live = getPeer(name) || peer;
    results.push({ messageId: message.id, ...tryDeliver({ peer: live, message, runWake, resumeProbe }) });
  }
  return { name, harness: peer.harness, results };
}
