// Opt-in stop-time review gate. Pure decision so it is testable; the hook script
// wraps it with stdin/stdout plumbing. `stop_hook_active` is Claude Code's
// reentrancy guard — when set, the Stop hook is already re-running, so we MUST
// allow the stop or we would loop forever.
export function decideStop({ stopHookActive, config }) {
  if (stopHookActive) return { block: false };
  if (!config?.stopReviewGate) return { block: false };
  return {
    block: true,
    reason:
      "Stop-time review gate is enabled. Run a cross-harness review " +
      "(e.g. /agent-collab:review) before finishing, or disable the gate with " +
      "`agent-companion setup --gate off`."
  };
}
