# Claude-bar checklist (official pages, 2026-08-14)

Source of truth — not hallway notes, not other agents’ reports:

- [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Remote Control](https://code.claude.com/docs/en/remote-control)
- [Channels](https://code.claude.com/docs/en/channels)
- [Agent teams](https://code.claude.com/docs/en/agent-teams.md)
- [Settings](https://code.claude.com/docs/en/settings) (`crossSessionInbound`, `isolatePeerMachines`)

This is the bar a driver uses to test the plugin peer plane. Claude↔Claude may keep
native tools; every other pair uses the plugin verbs. Agent teams and channels are
**not** this bar (see [Out of bar](#out-of-bar)).

## Discovery (named)

- [ ] **`ListAgents`**: Claude discovers reachable agents with the `ListAgents` tool.
      A driver never has to call it; Claude does. The plugin equivalent is a
      named list verb that returns sessions by the name they answer to.
- [ ] **`/list-agents`** (alias `/peers`): the human-visible roster. Each row
      has the name Claude addresses. The listing covers:
      - other **local** sessions on this machine that have bound an inbox socket
      - **cloud** sessions while Remote Control is connected (labeled `cloud`)
      - **Remote Control** sessions on other machines while this session is
        connected (labeled `Remote Control`; dropped connections show `offline`)
      - in-session **subagents**; agent-team teammates are **not** in this list
        (they use the team roster)
- [ ] **`@` mention of a live session** (v2.1.232+): type `@` plus at least one
      letter; typeahead suggests other live sessions on this machine. After a
      bare `@`, session rows do not appear. Cloud / Remote Control sessions
      appear in suggestions only after Claude has already listed or messaged
      beyond this machine. Duplicate names: Claude asks which one.

## Named plain-text send

- [ ] **`SendMessage`**: deliver a message to one agent **by name**. The same
      tool also messages subagents and agent-team teammates; this checklist is
      about **independent sessions**.
- [ ] Payload is **plain text only**. Not conversation history, not files, not
      structured agent-team protocol messages.

## Idle wake vs mid-turn delivery

- [x] **Idle (Cursor, pull)**: `peers deliver` starts a new `--mode ask`
      `--resume` turn when the receiver published `turnState: idle`. Not
      session-native (someone must call deliver). Claude stays native.
- [ ] **Idle (session-native)**: the receiving session itself starts a new
      turn with no external `deliver` poke.
- [ ] **Mid-turn**: the receiving Claude reads the message **between tool
      calls**. A **running tool is never interrupted**.
- [ ] Messages may be **Delivered**, **Held** (set aside until approved or a
      later mode/settings change allows them), or **Refused** (dropped).

## Reply address

- [ ] A delivered message carries the **sender’s name** and a **reply address**
      when the sender can be reached.
- [ ] **Absent on one-way cross-machine**: if this session is **not** connected
      to Remote Control when sending beyond this machine, the message still
      goes through **without a reply address**; the receiver cannot answer.
      Starting a new conversation with a session on another machine requires
      v2.1.225+ and a target that appears in the listing.

## Same-machine local inbox vs cross-machine

| Where the other session runs | How the message travels |
|---|---|
| On this machine | Per-session **Unix domain socket** + on-disk registration files. Never through Anthropic servers. Two sessions reach each other only when they can see the same files (a container vs the host cannot). |
| On another of your machines | Through **Anthropic servers**, arriving over that machine’s **Remote Control** connection. Shown under this session’s Remote Control name. |
| Claude Code on the web | Through **Anthropic servers**, straight to the cloud session. |

- [ ] Same-machine first: bind/register a local inbox; list only sessions that
      share the inbox visibility.
- [~] Cross-machine for Claude uses Remote Control. Plugin path: opt-in
      Tailscale `peers serve` (enqueue only). Pairing unfinished; file-path
      send still fail-closes. Reverse mini→MacBook unverified.
- [ ] `/status` shows `Peer address` as `uds:…`. Hooks/Bash see
      `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`.

## Security limits

- [ ] **Plain text only.**
- [ ] **Peer message is not user consent.** It cannot:
      - approve a pending permission prompt
      - change configuration (`CLAUDE.md`, permission settings, other config)
      - execute slash commands (`/compact` in the text arrives as text)
- [ ] **Permission prompts stay on the receiving session.** Acting on a
      message still fires that session’s own prompts/rules.
- [ ] **`crossSessionInbound`**: `accept` delivers; `hold` shows a notice and
      does not deliver; `refuse` drops. When unset, Claude decides from the
      two sessions’ permission-mode classes (bypass vs prompting).
- [ ] **`isolatePeerMachines`**: `true` (from **any** scope) requires explicit
      approval before `SendMessage` leaves this machine, even in
      `bypassPermissions`. A project file can turn this **on**, not off.

## Driver rule (plugin)

- [ ] Claude↔Claude that already fits native messaging **keeps using**
      `ListAgents` / `SendMessage` / `/list-agents` / `@`.
- [ ] Otherwise (other harness, or Claude talking to non-Claude) the driver
      uses the **plugin peer verbs**.
- [ ] Same-machine vs cross-machine in plugin docs must match this page’s
      UDS vs Remote Control split (local files/socket vs a plugin-owned
      off-machine path).

## Out of bar (do not confuse with this surface)

- **Agent teams** — experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).
  Lead + teammates, shared task list, team mailboxes under
  `~/.claude/teams/…`. One team per session. Not independent-session
  discovery.
- **Channels** — MCP plugins that **push external events** (Telegram, Discord,
  CI) into an already-open session. Not peer-to-peer session messaging.
- **Remote Control (steering)** — *you* drive a local session from phone/web.
  The same connection can *carry* cross-session messages, but Remote Control
  itself is not `SendMessage`.
