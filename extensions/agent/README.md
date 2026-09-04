# Remux Agent

Remux Agent is the mobile-first Remux client for native coding-agent runtimes.
It preserves the provider harness instead of rebuilding one:

- Codex runs through the installed `codex app-server` and the user's Codex
  subscription.
- Claude runs through the official Claude Agent SDK, the installed Claude Code
  executable, and the user's Claude subscription. Sessions use the native
  `claude_code` system-prompt preset and user/project/local settings.
- Same-provider subagents stay native to Codex or Claude Code.
- Explicit cross-provider delegation uses a small loopback-only Remux MCP
  service with execution-scoped, in-memory credentials.

The canonical architecture and acceptance gates are in
[`docs/specs/agent-native-provider-runtime-v1.md`](../../docs/specs/agent-native-provider-runtime-v1.md).

## Product boundary

Remux owns durable command receipts, the normalized display journal, bounded
resource projection, the chat UI, long-thread virtualizer, mobile safe areas,
WebView lifecycle recovery, attachments, and notifications. The provider owns
its system behavior, model context, compaction, coding tools, permission model,
tool loop, native history, and native subagents.

Normalized transcript events are display state only. Remux never feeds them
back to a model as replacement history. There is no Remux context compiler,
custom coding-tool loop, model-authored questionnaire, multiple-choice prompt,
or custom work-unit runtime.

## Conversations and history

A conversation is the stable chat identity and route. Editing a message creates
and atomically activates a new immutable strand inside that conversation; it
does not add a history row. Explicit Fork creates another conversation. Both
operations use the provider's native same-provider branch boundary, never a
replay of the visible transcript.

The journal orders each strand through explicit path ordinals and keeps native
branch cursors private to the server. Historical versions have bounded,
read-only transcript resources, while Make Current creates another native
restore strand instead of mutating history. Preparing or failed destinations
remain hidden, and head changes use a compare-and-swap revision so competing
edits fail closed.

The desktop sidebar and mobile history sheet render the same flat, fixed-row,
virtualized recent-chat list. Each row favors recognition: a meaningful title
or first-message fallback, the latest transcript activity, and the last model
proven by a dispatched turn. Fork/version lineage and archive metadata remain
durable internal state, but are intentionally omitted from the history UI.

The retired T3 Code capsule informed selected provider-contract and visual
decisions, but its source, extension, desktop workspace, event store, and
Git/file/terminal UI are not part of the Agent product.

## Providers and authentication

The production server registers two local provider instances:

| Instance | Native runtime | Authentication |
| --- | --- | --- |
| `codex-local` | `codex app-server` | Existing Codex subscription; device login is available through Agent |
| `claude-local` | Claude Agent SDK + installed `claude` | Existing Claude Code subscription; sign in on the Remux host with `claude auth login --claudeai` |

API-key fallback is intentionally disabled for Claude. Provider health and
capabilities appear in Agent's settings menu. Existing conversations remain
bound to their original provider instance, model, native session, and supported
configuration controls.

## Cross-provider delegation

Each open native session receives a distinct bearer credential for a random
`127.0.0.1` MCP endpoint. The server derives caller identity, conversation,
checkout, access ceiling, provider, generation, and federation depth from that
credential; the model cannot submit those fields.

The namespaced tools are:

- `remux_spawn_agent`
- `remux_send_message`
- `remux_wait_agent`
- `remux_interrupt_agent`
- `remux_close_agent`

Federation refuses same-provider delegation so Codex and Claude retain their
native collaboration behavior. Version 1 permits bounded parallel read-only
children and one foreground writer per checkout. Child transcripts are fetched
only when expanded in the viewer.

## Durable and mobile behavior

The browser is never the execution owner. Locking the phone, backgrounding the
app, destroying the WebView, losing the WebSocket, or recreating React must not
stop provider work or redispatch an accepted command. On foreground/reconnect,
the viewer rereads authoritative runtime, transcript, queue, and any expanded
child resources. Menus and sheets account for top, bottom, and keyboard safe
areas.

Native Agent data defaults to
`$XDG_DATA_HOME/remux/agent-native-v1` or
`~/.local/share/remux/agent-native-v1`. Override it with
`REMUX_AGENT_NATIVE_DATA_DIR`. This is a clean schema cut from the former
experimental Agent database.

## Local verification

```sh
npm --workspace @remux/agent run test:server
npm --workspace @remux/agent run test:unit
npm --workspace @remux/agent run test:viewer
npm --workspace @remux/agent run build
```

Set `REMUX_AGENT_FIXTURE=1` when running `server/dist/main.mjs` to use the
deterministic provider fixture without subscription traffic. Fixture success is
not a substitute for the live gates: run a signed-in Codex create/send/resume/
interrupt flow, a signed-in Claude create/send/resume/native-subagent flow, and
both directions of cross-provider delegation before declaring release parity.

The historical `extensions/codex` implementation remains the Codex behavioral,
rendering, performance, and lifecycle acceptance oracle during this cutover.
