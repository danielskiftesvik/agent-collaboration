// Same-shape peer reply for every harness: peer-session text to the main name, not consent.
// Assign stays enqueue-only; this is the machine-side answer, not delegate.
import { sendMessage } from "./peers.mjs";

export function replyToAssign({ from, to, text } = {}) {
  if (!from) throw new Error("reply: from is required");
  if (!to) throw new Error("reply: to is required");
  const body = text == null ? "" : String(text);
  if (!body) throw new Error("reply: a text payload is required");
  return sendMessage({ to, from, text: body });
}
