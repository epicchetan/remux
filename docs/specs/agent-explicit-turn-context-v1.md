# Agent explicit turn context v1

Status: Archived
Last verified: 2026-08-17
Canonical code: `extensions/agent/{shared/protocol.ts,server/src/context/,server/src/storage/,server/src/providers/openai-codex/,viewer/src/composer/context/}`
Supersedes: `agent-thread-runtime-v2.md` and `agent-living-thread-canvas-v1.md`
Superseded by: `agent-native-provider-runtime-v1.md`. This document describes
the Pi-based experimental runtime that will be deleted at native Codex cutover.

## Outcome

Every user turn begins a fresh root provider lane with a durable, user-selected
context plan. The harness no longer maintains a model-authored `thread.md`,
automatically compacts conversation history, or rejects a request against a
local token budget.

The journal remains the exact source of truth. The context compiler is a
deterministic view over that journal with three inputs:

1. selected prior turns at either dialogue or full resolution;
2. the exact active root/work-unit scope; and
3. the fixed system prompt and active tool schemas supplied by the runtime.

The default plan includes the latest two completed turns as dialogue. The user
may turn any available prior turn off, retain dialogue, or upgrade it to full
parent trajectory for the next request. This is request state, not persistent
conversation memory: after a successful send, the composer returns to the
default plan.

## Vocabulary

- **Conversation:** the user-visible list of turns and durable History scope.
- **Turn:** one user request, its root execution scope, and one final response.
- **Dialogue:** the exact user message and final visible assistant response from
  a completed prior turn. Reasoning, tools, and internal work are omitted.
- **Full:** the prior turn's root provider trajectory: provider reasoning state,
  readable summaries, assistant items, tool calls, tool results, and final
  response. Child work-unit internals remain private to their own scopes; the
  folded work-unit result remains in the parent trajectory.
- **Active scope:** exact current-turn state. A work unit is a disposable
  continuation segment opened from the current root trajectory. Its detailed
  reasoning and tool activity stay inspectable but do not fold back into the
  root context.
- **History:** durable retrieval for exact activity that was not selected.

## Durable request contract

All send, queue, edit, and fork operations carry this snapshot:

```ts
type TurnContextPlan = {
  version: 1;
  automaticDialogueTurns: number;
  overrides: Array<{
    turnId: string;
    resolution: 'off' | 'dialogue' | 'full';
  }>;
};
```

`automaticDialogueTurns` is `2` in the viewer default. Overrides are explicit
against durable turn IDs. The accepted plan is canonical JSON in the `turns`
row and in the acceptance events, so queueing, retries, restart recovery, and
inspection cannot silently change what the user selected.

For edit/fork, the visible prefix is cloned into a new conversation and
override IDs are remapped to the corresponding cloned turns. Dialogue is exact
for the cloned visible exchange. Full resolution uses the complete root
trajectory durably available to that branch; provider-private continuity is
exact when the provider item is present and otherwise reconstructs from the
cloned readable reasoning, operations, and results.

## Resolution

At each provider boundary the compiler:

1. groups prior root messages by turn in chronological order;
2. identifies completed turns with both a user message and final assistant
   response as dialogue-eligible;
3. selects the latest `automaticDialogueTurns` eligible turns;
4. applies each explicit override;
5. projects dialogue turns to user plus final response;
6. retains every root logical/provider item for full turns;
7. appends the exact active scope; and
8. hashes and records the resulting ordered frame before dispatch.

Selection never truncates, summarizes, reorders, or evicts a requested turn.
An unavailable explicit turn fails before provider dispatch rather than being
silently ignored. The inspector records the requested plan, resolved turns,
origins, context layers, omissions, message hashes, dispatch payload, and
estimated tokens.

## Provider continuity

A root turn uses its root execution-scope ID as a fresh provider lane. Provider
calls inside that turn use continuation when their exact prefix extends the
lane; changed prefixes dispatch in full. Each work unit uses a separate
provider lane as the transport mechanism for a disposable continuation. It
folds only its typed terminal result and optional artifact pointers back into
the pending root tool call. Exact artifact contents remain in History and are
never injected automatically.

For GPT-5.6, selecting any prior full turn requests
`reasoning.context: "all_turns"`. Exact encrypted provider reasoning items are
stored privately and replayed; readable concise reasoning summaries remain in
the journal and UI. Dialogue resolution deliberately strips both the provider
item and readable reasoning/tool trace.

Pi compaction is disabled. The harness has no soft limit, hard limit, rollover,
or local context-admission rejection. The provider still owns its physical
model limit and may reject a request that genuinely exceeds it; adding remote
compaction is explicitly deferred.

## Viewer interaction

The layers button beside the composer opens a lightweight next-turn picker. It
uses the same server-authoritative transcript resource store as the virtualized
conversation, but the panel is outside the transcript measurement tree.

Each completed turn has three controls:

- **Off:** exclude the turn;
- **Dialogue:** include exact user/final-assistant continuity; or
- **Full:** include the parent reasoning and execution trajectory.

The latest two eligible turns show Dialogue without writing redundant
overrides. Older pages can be loaded in place. Draft persistence retains custom
selections per conversation and new-chat draft. A send snapshots the plan
before optimistic UI changes; queueing, edit, and fork use that same snapshot.
Successful dispatch resets only the next-turn plan, not the message draft on a
failed operation.

## Storage cutover

Schema `agent-state-v6` is a clean development cutover. It removes
`state_documents`, `document_versions`, Thread versions, context envelopes, and
their foreign keys. `turns.context_plan_json` replaces Thread version pointers.
Context frames retain the immutable manifest, ordered hashes, selected plan,
and provider-dispatch evidence. Work-unit scopes store one concise boundary;
terminal results may preserve exact file or History snapshots as pointer-only
artifacts.

There is no v4 compatibility reader or migration. The sole development data
root is recreated before live acceptance.

## Acceptance

The checkpoint is complete when:

1. no Thread RPC, model tool, storage table, viewer, or prompt instruction
   remains in the active Agent implementation;
2. default dialogue, explicit off/dialogue/full, and zero-default selection are
   deterministic and durable;
3. full selection replays exact stored provider reasoning state in a normal
   conversation and asks GPT-5.6 for all-turn reasoning continuity;
4. the viewer picker works on desktop/mobile without changing transcript
   virtualization, streaming, reconnect, edit/fork, queue, or draft behavior;
5. no harness context-pressure event or local context-limit rejection remains;
6. schema v6 starts from an empty data root and rejects incompatible state;
7. typecheck, server tests, viewer unit tests, full viewer tests, build, and the
   real-subscription clean acceptance pass; and
8. context manifests prove the first request has only its active turn, an
   explicit full follow-up contains the selected turn, and a later work unit
   retains independent child-lane continuation.

## Deferred

- Provider remote compaction or active-scope rollover.
- Automatic context selection, summarization, or a background memory agent.
- Bulk selection presets beyond the two-turn dialogue default.
- Promoting History reads into future requests without user selection.
- Project-wide shared memory or a model-maintained planning document.
