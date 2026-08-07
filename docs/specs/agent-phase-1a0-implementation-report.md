Status: Active Spec
Last verified: 2026-08-07
Canonical code: Phase 1A.0 is owner-accepted in `extensions/agent/` and checkpointed at `8e96512f06ea354bd54f84f5e783161b786e1696`

# Agent Phase 1A.0 implementation report

## Decision state

Phase 1A.0a–1A.0d are complete. The owner completed the live
desktop/physical-phone comparison and explicitly accepted the checkpoint on
2026-08-07. Phase 1A.1 is separate and is not authorized by this report.

## Source identity

- Frozen Codex source and implementation base:
  `47703785ea70d43e24ac575baa6693017cc948c0`.
- Phase 1A.0 implementation checkpoint:
  `8e96512f06ea354bd54f84f5e783161b786e1696`.
- Selected later Codex fixes: none.
- `extensions/codex/` worktree changes: none.
- Agent protocol/projection: version `1`, projection
  `agent-turn-render-v1`.
- Pi: `0.84.0`, single `openai-codex` provider.

The implementation checkpoint is based on the frozen Codex source identity
above. The checkpoint hash records the Agent implementation; it does not
change the source-baseline identity used for the port.

## Implemented closure

The Agent server now owns bounded transcript sync, immutable turn frames,
grouped work resources, lazy detail reads, revisions, invalidations, and
terminal fencing. The viewer consumes only those Agent resources and ports the
relevant transcript measurement, virtualization, Markdown, code/table/file
rendering, disclosure, duration, copy, diff, and viewport behavior.

The old Phase 0 form/textarea shell is replaced by:

- a plain-text Lexical document and stable text-part identity;
- trimmed text-only send projection;
- one ephemeral draft workspace and directory picker;
- authoritative model/reasoning defaults, locked after conversation creation;
- first-send conversation creation with one client message identity;
- send, interrupt, sign-out, new-chat, reload, and previous/next actions;
- responsive transcript/composer slots, safe-area padding, and host-reported
  mobile keyboard lift; and
- lifecycle resume, bottom-vs-manual ownership, reconnect reads, and server-
  generation fencing.

No durable journal, history, epoch behavior, write/search/shell/process tool,
or later Agent interaction feature was added.

## Deliberate adaptations and deviations

1. The Agent directory picker uses only the approved bounded
   `remux/fs/readDirectory` call. Its search field filters the current bounded
   result locally; Codex recursive search, directory statistics, and related
   RPCs were not copied.
2. Historical `codex-*` presentation class names remain in the isolated Agent
   stylesheet where the scope explicitly allows them. There is no Codex source
   or protocol dependency.
3. The picker activation dedupe uses a null initial timestamp so the first
   tap immediately after render cannot be suppressed. Subsequent pointer/click
   duplicates retain the 350 ms fence.
4. Resume sync selects the tail only while the viewer owns bottom-follow mode;
   a manually positioned viewport preserves its window. This makes foreground
   catch-up and manual-scroll ownership explicit.
5. Live OAuth/model traffic is intentionally absent from deterministic tests.
   The owner completed the separate live desktop/physical-phone OAuth, read,
   stream, interrupt, reconnect, restart, light/dark, keyboard, and safe-area
   acceptance gate.

## Automated evidence

Recorded on 2026-08-07 from the frozen source commit:

| Command | Result |
| --- | --- |
| `npm --workspace @remux/agent run build` | Pass; server and viewer production bundles built. The existing large Shiki chunk warning remains non-blocking. |
| `npm run test:agent` | Pass; aggregate command runs server (13/13), unit (23/23), and viewer (43 pass, one mobile-only desktop skip) suites. |
| `npm --workspace @remux/agent run test:server` | Pass: 13/13. |
| `npm --workspace @remux/agent run test:unit` | Pass: 23/23. |
| `npm --workspace @remux/agent run test:viewer` | Pass: desktop/mobile parity matrix; 43 pass and one desktop skip for the mobile-only keyboard case. |
| `npm run typecheck` | Pass. |
| `npm run test:codex` | Pass: 354/354 on the unchanged baseline. One earlier full run had one timing-only narration-position failure; the exact case then passed in isolation and the complete rerun passed. |
| `git diff --check` | Pass. |

The Agent browser matrix covers authoritative fresh-chat defaults, exactly-once
first send, stale streaming response fencing, background/resume catch-up,
reconnect, server-generation reset, bounded/lazy work reads, Markdown and
width containment, long-window virtualization, sent-message stability,
manual-scroll ownership, previous/next navigation, directory selection,
model lock/new-chat reset, interruption/error recovery, multiline Enter,
mobile keyboard lift, painted config/action surfaces in dark and light themes,
portable v4 client-message identity without `crypto.randomUUID`, and the
excluded-control surface. The static audit also
rejects Codex/narration imports, App Server protocol, forbidden composer
directories, and excluded dependency/feature names.

## Owner acceptance record

Accepted on 2026-08-07. The owner reported the prepared live desktop and
physical-phone comparison complete after exercising the Phase 1A.0 shell and
runtime flows. No blocking parity finding or required deviation was reported.
This closes Phase 1A.0; it does not by itself authorize a later implementation
scope.
