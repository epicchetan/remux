# Agent Thread Runtime v1

Status: Accepted implementation spec
Accepted: 2026-08-10
Replaces: the Agent shadow/stateful/working-memory context experiments

## Outcome

The Agent runs one context architecture. The immutable journal retains exact
history, a versioned `thread.md` retains current collaborative state, each
completed user turn owns a bounded capsule, and provider reasoning remains
local to the active turn or work unit. Context is compiled at semantic
boundaries instead of growing until transcript compaction is required.

There are no product context modes, Pi compaction, legacy database migrations,
or compatibility readers. The pre-runtime prototype is retained only in Git
and benchmark evidence.

## Durable hierarchy

```text
project
└── conversation (user-visible thread)
    └── strand (edit/fork branch)
        ├── versioned thread.md
        └── turns
            ├── exact user and assistant messages
            ├── turn-local provider items and reasoning
            ├── optional bounded work units
            └── immutable turn capsule
```

The existing conversation/strand names remain the UI and protocol vocabulary;
they are respectively the thread and branch primitives in this design.

## Context layers

A fresh user turn receives, in stable order:

1. fixed system and tool contracts;
2. the active strand's current `thread.md` version;
3. a bounded tail of completed turn capsules;
4. a bounded tail of exact user/assistant dialogue pairs; and
5. the new exact user input.

Old tool traffic, work-unit scratch, and prior-turn reasoning are excluded.
All remain discoverable through journal search/open. Reading old evidence is
ephemeral; the model updates `thread.md` only when it should remain active
collaborative state.

Context is rebuilt only when a user turn starts, a work unit is entered or
returned, or an interrupted scope is recovered. Provider calls inside one
scope append to the same ordered frame for KV-cache reuse.

## Thread document

`thread.md` is a bounded Markdown briefing, not a transcript summary. It holds
the current objective, accepted decisions, constraints, implementation state,
important resources, open questions, and near-term direction. Versions are
immutable and updated with compare-and-swap. A historical fork inherits the
document version associated with its fork point.

The storage primitive permits project- and strand-scoped documents, but v1
automatically compiles only strand-scoped `thread.md`.

## Turn capsule

A completed turn capsule references the exact user input and assistant answer,
the thread-document versions before and after the turn, bounded work-unit
results, changes/validation evidence, unresolved issues, and the exact trace.
The initial implementation renders this deterministically from foreground
records. A later background Sol writer may enrich it through the same versioned
commit path without blocking the next turn.

Recent exact dialogue and older capsule tails have independent budgets. The
compiler evicts whole completed turns oldest-first; the journal never deletes
them.

## Provider reasoning

The exact Pi assistant message is stored as a private artifact, including
opaque `thinkingSignature` data used to replay OpenAI reasoning. An inspectable
projection removes opaque signatures and credentials. Current-turn reasoning
survives tool calls and restart. Parent reasoning is inherited by a child work
unit, child reasoning remains child-local, and prior-turn reasoning is omitted
from the next turn's normal frame.

## Work units

A work unit is a provider-context child of the current turn, not a separate
conversation. It inherits the parent through a durable response anchor, adds a
focused objective and selected evidence, and returns a bounded Markdown result.
The parent resumes from its original anchor plus that result; the child trace
and reasoning stay in the journal.

## Tool surface

The context surface is deliberately small:

- `journal.search` and `journal.open` retrieve exact cold history;
- `thread.read` and `thread.update` inspect or CAS-replace `thread.md`; and
- `work_unit.enter` and `work_unit.return` manage bounded child execution.

Normal coding continues through Pi read/bash/edit/write tools. The former
`context_update`, `memory`, primaries, pins, holds, and background working-memory
cache are removed.

## Storage and cutover

The schema contains the durable conversation core plus state documents,
document versions, turn capsules, context frames, inferences, provider items,
and content-addressed artifacts. Transcript/resource tables are rebuildable UI
projections rather than context authority.

Only the new schema identity is accepted. At cutover the development Agent data
root is moved aside and recreated; no old database is migrated or read.

## Acceptance

The runtime is accepted when:

1. create/send/history/restart/queue/edit/fork remain UI-compatible;
2. an actual provider frame is committed before every dispatch;
3. exact opaque provider reasoning survives an active-scope restart;
4. the next user turn omits prior tool traffic and reasoning;
5. thread state and capsule/dialogue tails stay within deterministic budgets;
6. a historical fork receives its historical thread document;
7. work-unit reasoning and tools do not leak into the parent frame;
8. no legacy context modes, migrations, shadow compiler, or Pi compaction remain;
9. full tests, build, real smoke, and the Ledger benchmark pass through the
   public runtime path.
