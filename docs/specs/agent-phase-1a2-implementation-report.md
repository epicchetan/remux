Status: Archived
Last verified: 2026-08-08
Superseded by: `agent-native-provider-runtime-v1.md`. Retained as historical
transcript, scale, lifecycle, and performance evidence.
Canonical code: Phase 1A.2a–1A.2d implementation, automated closeout, clean-state live validation, and owner desktop/physical-phone acceptance are complete in `extensions/agent/`

# Agent Phase 1A.2 implementation report

## Decision state

Phase 1A.2 now has an authoritative, bounded transcript path from SQLite to the
ported Agent viewer, plus automated recovery, fault, and scale evidence. It
does not change provider input: Pi still receives the exact Phase 1A.1 full
logical replay. The owner accepted this checkpoint on 2026-08-08. Phase 1A.3
shadow context compilation is the next planning boundary.

## Source and version identity

- Pi: exact `0.84.0`, with the existing required Agent-owned provider
  preflight seam and only `openai-codex` exposed by the adapter.
- Agent journal: SQLite schema `agent-journal-v2`, `PRAGMA user_version = 2`,
  with an exact fail-closed v1-to-v2 migration.
- Durable projection digest: `agent-projection-v1`.
- Transcript protocol/projection: version `2` / `agent-turn-render-v2`.
- Provider replay: unchanged `agent-full-replay-v1`.
- `extensions/codex/` source changes: none.

The implementation is published by the combined durable-transcript closeout
commit that includes this report.

## Implemented closure

### Durable transcript and large content

Conversation creation and message send now have distinct caller-stable
operation and client-message UUIDs with exact replay/conflict semantics. Cold
tail, around, and range reads select at most 40 turns in SQLite before
materializing their transcript items. Every batch, invalidation, render frame,
work group, and detail is fenced by committed journal basis, projection
revision, and server generation.

Assistant/reasoning transcript rows retain compact append metadata while exact
aggregates live in immutable artifacts. Ordinary visible text is capped at 48
KiB per body and oversized content remains visible through a hash/byte-length
descriptor and bounded UTF-8 range reads. Work cursors bind projection version,
group revision, and offset, preventing mixed-revision pagination.

### Viewer lifecycle and parity

The Agent viewer retains the established Codex-derived transcript renderer,
Markdown blocks, work disclosure, virtualizer, scroll ownership, composer, and
responsive shell. Agent-owned stores now reject old-generation responses and
invalidations, atomically clear protocol caches on generation replacement,
preserve the rendered window and disclosures while refreshing, and load an
`around` window before focusing an unloaded turn. Projection, frame, work, and
focus failures remain visible with bounded retry or retrieval controls.

No new Codex source was copied in the hardening slice. Applicable behavior was
adapted into Agent-owned fixtures from the stable Codex route, transcript
layout, virtualization, lifecycle, work disclosure, and responsive containment
tests. Narration, queue/steer, edit/fork, mentions, attachments, App Server
protocol, and other explicit product exclusions remain absent.

### Terminal, startup, and fault hardening

One durable terminal event now carries the exact status, typed provider/runtime/
storage error category, and rounded monotonic duration. Live and cold frames
are byte-identical at the same basis, and restart interruption remains
distinguishable from a user interrupt.

Startup adds `PRAGMA quick_check` and validates every referenced artifact's
safe path, regular-file type, and declared length without hashing the entire
corpus. The first content use in a server generation verifies the full SHA-256
and caches that immutable hash. The explicit `storage:scrub` maintenance
command force-verifies all references and reports orphans; it is not a model
tool, automatic startup task, or garbage collector. Integrity failures use a
typed, redacted durable-corruption fault.

Conversation mutation and logout share one serialized command lane. Interrupt
remains immediate and idempotent. The deterministic matrix covers duplicate
and conflicting sends, send versus logout, interrupt versus terminal, close
versus hydration, SQLite busy, artifact staging and corruption, crash
boundaries, stale generation/page responses, and notification loss followed by
authoritative convergence.

## Deliberate adaptations and deviations

1. **Metadata-fast startup.** Startup validates SQLite and artifact metadata;
   full corpus hashing moved to first use plus the explicit scrub. This keeps
   corruption fail-closed at every content boundary without making readiness
   proportional to stored bytes.
2. **One durable terminal event.** Terminal status, error category, and duration
   stay in the existing consolidated `turn.terminal` event instead of adding a
   second presentation-only event stream.
3. **Disposable completed-frame cache.** The byte-weighted cache remains only a
   repeat-read optimization. Correctness and bounded selection do not depend on
   it, and generation replacement may discard it freely.
4. **Checkpoint measurement includes synchronous publication.** The scale
   probe measures 100 checkpoints at the production 50 ms coalescing cadence,
   including the SQLite commit, live projector update, and its synchronous
   invalidation callback. Transport delivery and provider time are
   intentionally outside the metric.
5. **No automatic artifact cleanup.** Scrub reports unreferenced installed
   objects but preserves them. Retention and garbage collection remain outside
   Phase 1A.2.

## Automated evidence

Recorded on 2026-08-08 using temporary data roots and Remux-managed research
workloads.

| Check | Result |
| --- | --- |
| Repository typecheck | Pass. |
| Agent server tests | Pass: 87/87. |
| Agent unit tests | Pass: 25/25. |
| Agent viewer tests | Pass: 66 with two intentional project skips. |
| Agent production build | Pass. |
| Unchanged Codex baseline | Pass: 354/354. One earlier combined run hit the existing desktop narration auto-follow timing threshold; the exact test and then the full suite passed unchanged on retry. |
| Real subscription replay | Pass in snapshot mode on `gpt-5.3-codex-spark`, high reasoning: one completed full request, 47,802 estimated input tokens, `REMUX_REPLAY_OK`, 2.380 seconds. |
| Clean-state live acceptance | Pass through the running Remux/Agent RPC path: empty schema, credential/model readiness, two real provider turns, supervised Agent restart, changed PID/server generation, durable cold transcript, and nonce recovery from the pre-restart user turn. The post-restart request was a fresh full provider request. |
| Production-viewer live acceptance | Pass against the real two-turn journal at 1280×900 and 390×844. History, transcript, composer, and both assistant sentinels rendered; document and transcript horizontal overflow were both zero. This browser bridge exercises the production viewer bundle and live Remux RPC path, not the native phone shell. |
| Live artifact scrub | Pass: two referenced artifacts and 2,895 bytes verified with no orphans. |
| `git diff --check` | Pass. |

The opt-in `test:hardening` corpus contains 250 completed turns, one
restart-recovered turn, one active tail, 1,000 work rows, 33 referenced
artifacts, and 73,400,333 artifact bytes. Thirty unselected turns each own a
distinct 2 MiB artifact, one selected assistant owns 2 MiB, and one tool result
owns 8 MiB. Removing an old unselected artifact does not affect cold tail or
middle-history reads; exact disclosure remains capped by the 8 MiB response
ceiling.

| Reference-box probe | Gate | Measured p95 |
| --- | ---: | ---: |
| 250-turn cold tail | <= 100 ms | 0.76 ms |
| 250-turn cold around | <= 100 ms | 0.75 ms |
| Durable checkpoint through invalidation publication | <= 25 ms | 17.92 ms |
| Startup through resource readiness | <= 1,500 ms | 84.23 ms |

The explicit scrub verified all 73,400,333 referenced bytes in 43.38 ms and
reported no orphans.

### Clean-state acceptance record

The prior local Agent data root was stopped and atomically moved to
`agent-archive-before-clean-acceptance-20260808` rather than edited in place.
It contains the former three conversations and eight turns. Agent then started
with a newly created schema and retained its external Codex subscription
credential.

The reusable `test:live:clean` command requires an empty journal. It created
one conversation on `gpt-5.3-codex-spark` at high reasoning, committed a first
sentinel turn, restarted only the Agent extension, observed a different PID and
server generation, cold-read the first completed turn, and sent a second turn
that recovered a nonce present only in the pre-restart user message. The final
journal contains one conversation, two completed turns, two completed
inferences, no running turn, and one visible history entry.

The companion `test:live:viewer` command rendered that production conversation
through an authenticated browser host bridge at desktop and mobile dimensions.
It verifies live history/transcript recovery and containment without pretending
to replace native WebView, safe-area, keyboard, touch, or physical-device
acceptance.

## Owner acceptance record

The owner explicitly accepted Phase 1A.2 in chat on 2026-08-08 after the
automated gates, clean-state real-provider/restart run, production desktop and
mobile browser acceptance, and physical-phone review. Exit gate 10 is closed
as an owner decision; it is not inferred from automated evidence.
