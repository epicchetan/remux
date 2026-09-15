Status: Active Spec — approved 2026-09-15; implemented in working tree 2026-09-15 (observed guard, trigger list, min-version capability gate ≥ 2.1.258, steer-downgrade reason)
Last verified: 2026-09-15 (Claude Code 2.1.258, Agent SDK 0.3.258, MCP SDK 1.30.0)
Canonical code: `extensions/agent/server/src/federation/`,
`extensions/agent/server/src/providers/claude/claude-adapter.ts`,
`extensions/agent/server/src/native-runtime/{native-coordinator,native-journal,native-projector}.ts`,
`extensions/agent/shared/native-agent-protocol.ts`, and
`extensions/agent/viewer/src/{composer,transcript}/`

# Non-blocking federation and automatic continuation

## Outcome and scope

A Claude parent (Fable) orchestrates; a federated Codex child (Astra) implements.
Today a foreground `remux_spawn_agent` blocks the parent's native loop for the
whole child run. The parent cannot answer the user, a user message becomes an
unconfirmed steer, and the child's result can miss the parent entirely (the
2026-09-14 incident: Astra finished at 23:27, the parent never saw it, the user
ended the turn at 00:49).

After this pass:

- A federation wait never holds a Claude parent turn open for more than a few
  seconds. The parent turn ends, the child keeps running, the user can keep
  talking, and when the child finishes the conversation continues on its own,
  exactly like Claude Code's native subagent completions.
- The transcript shows that continuation as a compact notice, not a fake user
  message.
- Send is one click again. The Send button has no menu. Explicit queueing lives
  in the existing composer configuration menu; delivery explanations live in
  the inline status footer.
- The uncommitted delivery-recovery layers (abandon, evidence handler, process
  check) stay as the safety net for the rare lost-delivery case.

Codex parents keep today's blocking foreground semantics; Codex's MCP client has
no backgrounding. Everything below that is Claude-specific says so.

This spec amends the Send delivery menu section of
[conversational input](agent-conversation-input-and-background-work.md) and the
foreground-scheduling text of Lane 2 in
[native provider runtime](agent-native-provider-runtime-v1.md). Writer
exclusivity, depth and count limits, credential scoping, and child durability
are unchanged.

## Mechanism (verified)

Claude Code 2.1.258 moves any MCP tool call that is still running after a
threshold into a background task of type `mcp_task`. The model receives a
tool result saying the call "was moved to the background as task <id>", the turn
ends normally, and when the call resolves Claude Code injects a task
notification carrying the tool's result text and starts an autonomous turn.
This is the same path native `Agent` completions use. It requires:

- `CLAUDE_AUTO_BACKGROUND_TASKS=1` in the session environment. Non-interactive
  (SDK) sessions return threshold 0 without it.
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=<ms>` to set the threshold. Without it the
  default is 120 s behind a remote flag.
- `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND` unset.

The probe `extensions/agent/tests/live/federation-background-probe.mjs` runs a
loopback Streamable HTTP server shaped like the federation bridge (stateless
per-request `McpServer`, SSE progress) with a gated blocking tool and a 5 s
threshold. Observed on 2026-09-15: `task_started` (`task_type: mcp_task`) at
5 s, tool result "still running after 5s … moved to the background", turn ended
with "WAITING", a user message answered in between, and after host release a
`task_notification` (`status: completed`, `tool_use_id` of the original call)
followed by an autonomous turn whose `result` had no `user_message_uuid` and
whose text contained the child's final answer.

Not usable instead: `query.backgroundTasks(toolUseId)` returns `false` for MCP
calls, and MCP-protocol Tasks (`taskSupport`) are not augmented by Claude Code's
client today (a `required` tool fails with `-32601`). Keep neither.

The backgrounded call does not survive the Claude process exiting. The
coordinator covers that case (below). Nothing else in Claude Code needs to
change; Codex is untouched.

## Design

### Claude session environment and federation server

`subscriptionEnvironment` in `claude-adapter.ts` sets
`CLAUDE_AUTO_BACKGROUND_TASKS=1` and
`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` to a new constant
`CLAUDE_MCP_AUTO_BACKGROUND_MS = 10_000` in `federation/constants.ts`, and
deletes any inherited `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND`. Ten seconds
keeps `list`/`close`/`interrupt` and short children synchronous and bounds the
blocked window a user can hit.

`RemuxFederationServer` keeps `waitWithProgress` (progress every 15 s, 4 h
ceiling) for `spawn` foreground, `send_message`, and `wait`. No protocol
change. The tool descriptions for Claude callers say: "If the wait exceeds
about 10 seconds, Claude Code moves this call to the background and notifies
you with the result when the child finishes. End your turn or keep working; do
not poll with `remux_wait_agent` in a loop." Descriptions for Codex callers
keep today's wording. `federationToolDescriptions(scope)` already receives the
caller's provider.

The server records in-flight long calls per caller execution:
`coordinator.noteFederationCall(callerExecutionId, callId, startedAt)` on entry
and release on return or on the request signal aborting. This is in-memory only.

### Coordinator

`foregroundFederationBusy(conversation)` is observed state, not a clock
(revised 2026-09-15): Claude parent, parent turn active, and the session's
`blockedOnForegroundFederation()` true, i.e. a root `mcp__remux-federation__*`
tool owned by the active turn that has neither returned its tool result nor
been marked `backgrounded` by the `mcp_task` `task_started` observation. The
coordinator wakes queued delivery when it persists that backgrounding or
completion event, so there is no timer and no `+ 5_000` window. Remux never
calls `backgroundTasks()` for MCP tools (the SDK does not support it); it
observes Claude Code doing so. Codex parents never set this guard. An explicit
`delivery: 'steer'` that cannot be honoured is queued with
`reason: 'federation-wait' | 'steer-unavailable'` on the send result, shown in
the composer inline status while the message is queued.

Child lifetime is already independent of the root turn (children are durable
and discoverable later). `spawnFederatedAgent` and `activeContext` keep
requiring an active caller turn at call time. `finalizeFederatedExecution`
keeps appending `child.summary`/`child.completed` to the spawning root turn so
the child's row in that turn's work section completes in place.

Lost-watcher fallback: if a federated child reaches a terminal state and no
`executionWaiters` entry exists for it, the parent is a Claude conversation,
and the child was spawned foreground or later waited on, the coordinator
enqueues a pending root message for the parent conversation with
`origin: 'federation-notification'`, `deliveryIntent: 'auto'`, text
`Federated child <executionId> (<providerInstanceId>) <completed|failed|interrupted>: <summary or final preview>`
and the parent conversation's captured settings. Normal dispatch delivers it as
active input when the parent is busy and as a new root turn when idle. A live
waiter means Claude Code's own watcher will notify, so nothing is enqueued.
`remux_wait_agent` on a terminal child still returns immediately.

### Turn origin and transcript

Root turns gain `origin: 'user' | 'native-followup' | 'federation-notification'`
(schema 20: nullable column on turns, default `'user'` for existing rows;
optional field on the protocol 11 turn frame). The Claude adapter, on
`task_notification` for a task whose `tool_use_id` names a
`mcp__remux-federation__*` call, remembers `{ taskId, toolUseId, summary,
status }` in an ordered queue; the next `observeNativeTurn` drains it and
emits `turn.started` with `origin: 'native'`, `triggers: TurnTrigger[]` (arrival
order, at most 16 per turn, overflow carried to the next autonomous turn) and
`trigger` equal to `triggers[0]` for older readers. A child execution id comes
only from identity: the tool input (`remux_send_message`/`remux_wait_agent`) or
the structured result JSON (`remux_spawn_agent`, also carried verbatim in the
notification summary). There is no timestamp attribution; a trigger whose id
could not be recovered stays unattributed and the notice says so generically.
`ensureNativeProviderTurn` stores the origin and the trigger list (schema 21:
`triggers_json` on turns, queued messages, and appended inputs, backfilled from
the single `trigger_json`) instead of the literal "Background follow-up" user
message; native subagent completions become `native-followup` with
`trigger.kind: 'native-child'` and complete the child row in its owning turn
even when the notification arrives during a later turn.

The projector emits a `notice` turn-input item for non-user origins. The viewer
renders it as a single-line divider in the transcript
("Continued after Astra finished" / "Continued after Astra and Sol finished" /
"Continued after subagent finished", with the elapsed time since the child
started), never as a user bubble. History,
branch, and fork views treat it as read-only.

The `mcp_task` `task_started` for a federation call is not a child: the
adapter keeps suppressing it as a background tool task (current
`backgroundToolByTask` path) but marks the linked tool row `backgrounded` so
the spawn call shows "waiting in background" until the notification arrives.

### Composer

`SendButton.tsx` becomes a plain button: click sends with `delivery: 'auto'`,
no popover, no chevron, no `ArrowDown` menu. Remove the bespoke send-menu CSS
(`.remux-composer-send-*`). The coordinator already routes auto delivery to
active input when eligible and to the queue otherwise; the composer no longer
predicts eligibility.

`ConfigButton.tsx` gains a `ConfigRow` "Delivery" following the existing
icon + label + chevron convention, shown only while the conversation has an
active turn or pending queue. Options: "Reply now" (auto, default) and "Queue
for next turn". The choice applies to the next send and resets to auto after
it. Explicit queue continues to submit `delivery: 'queue'`.

`deliveryChoice.ts` shrinks to the footer explanation: it returns the reason
string currently shown in the menu (hold, recovering, compaction barrier,
earlier queued work, settings mismatch, provider lacks active input) and the
inline status footer shows it while typing during an active turn. No
`menu`/`currentAllowed` fields remain.

## Implementation sequence and exit criteria

| Slice | Changes | Exit evidence |
| --- | --- | --- |
| 1. Backgrounding lever | Env flags and constant; federation descriptions per provider; `blockedOnForegroundFederation()` observed guard (2026-09-15: replaced the in-flight call registry and clock window). | Adapter unit test asserts env; coordinator tests: guard true while the federation tool is open, false after `task_started` (backgrounded) or tool result, queued input dispatched on that observation, never for Codex. Probe re-run passes. |
| 2. Origin and notices | Schema 20 turn origin + trigger; adapter notification→trigger correlation; projector notice item; viewer divider. | Projector/view-model tests: federation and native follow-ups render as notices; existing turns default to `user`; no "Background follow-up" bubble anywhere. |
| 3. Lost-watcher fallback | Waiter-aware enqueue in `finalizeFederatedExecution`; idempotent per child. | Coordinator test: terminal child with no waiter enqueues one origin-tagged message; with a waiter enqueues nothing; restart between spawn and completion yields exactly one continuation. |
| 4. Composer | Plain Send; Delivery config row; footer reasons; CSS removal; update `tests/viewer-send-menu.spec.ts` into a delivery-row spec. | Playwright: one-click send during an active turn, delivery row visible only when relevant, reason text in footer, keyboard reachability. |
| 5. Live acceptance | Extend `tests/live/conversation-input-acceptance.mjs` pattern: real adapter + coordinator + federation server, gated child, user message during the wait, release, autonomous continuation with `origin` trigger recorded. | Log shows parent idle during child run, user turn completed, one continuation turn, child row completed in the spawning turn. |

Checks before reporting: `npm run typecheck`, `npm run test:agent`, viewer
build, extension server rebuild and restart through the extension restart RPC.
Run builds and tests under
`remux workload exec --workload research --operation <name> -- <cmd>`.
Do not restart the Remux runtime from inside a Remux session. Protocol stays 11;
new frame fields are optional.

## Grounding

- Claude Code 2.1.258 binary: `CLAUDE_AUTO_BACKGROUND_TASKS`,
  `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND`,
  `tengu_mcp_auto_background` default 120000 ms, `mcp_task` registry type,
  `buildMcpTaskNotification`, "does not survive exiting this session".
- Probe run 2026-09-15 (`federation-background-probe.mjs`, sonnet, 5 s
  threshold): backgrounded at 5 s, chat during wait, notification and
  autonomous `FINAL` turn after release, total 20 s.
- Earlier negative probes the same day: `backgroundTasks()` false for an
  in-process SDK MCP tool; MCP Tasks `required` tool rejected with `-32601`.
- Incident 2026-09-14 reconstructed from the production journal
  (`agent-native-v1/agent.sqlite3`): foreground Astra spawn blocked the parent,
  user steer unconfirmed after 30 s, child completed 23:27:43, turn ended
  manually 00:49:58.
