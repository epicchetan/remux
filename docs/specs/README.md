# Specs

Specs capture design intent and implementation plans. They are useful for rationale, but they are not automatically current runtime documentation.

Historical specs preserve paths and command names from the implementation pass
they describe. The Rust runtime moved from `cli/` to `crates/remux/` on
2026-07-11; use the current architecture and guides for today's layout.

## Statuses

- `Active Spec`: still informs ongoing implementation or design.
- `R&D evidence`: experiments and measurements retained as design evidence;
  a linked active spec owns normative implementation decisions.
- `Implemented`: the pass landed; use it for rationale and verify details against code.
- `Archived`: historical phase plan, superseded by later implementation or architecture docs.

Every spec should start with:

```md
Status: ...
Last verified: YYYY-MM-DD
Canonical code: ...
```

The active Agent provider/runtime contract is
[agent-native-provider-runtime-v1.md](agent-native-provider-runtime-v1.md).
Its ordered turn, journal, recovery, and child-rediscovery amendment is
[agent-canonical-turn-journal-v2.md](agent-canonical-turn-journal-v2.md).
Its composer, usage, and native Compact amendment is
[agent-composer-control-plane-v2.md](agent-composer-control-plane-v2.md).
Its conversation identity, edit/fork lineage, native branch, and sidebar-tree
amendment is
[agent-conversation-lineage-and-sidebar-tree-v1.md](agent-conversation-lineage-and-sidebar-tree-v1.md).
Its command/queue admission, provider snapshot reconciliation, canonical
timeline, projection-revision, and client synchronization amendment is
[agent-state-authority-and-synchronization-v1.md](agent-state-authority-and-synchronization-v1.md).
Its current staged implementation agreement and progress record is
[agent-audit-remediation-pass-1.md](agent-audit-remediation-pass-1.md), with
finding dispositions and implementation statuses in
[agent-audit-2026-09-05-findings.md](agent-audit-2026-09-05-findings.md).

## Codex Specs

| Spec | Status | Notes |
| --- | --- | --- |
| [codex/assistant-narration.md](codex/assistant-narration.md) | Archived | Initial behavior and UI rationale; provider, RPC, cache, and readiness details are superseded by the implemented Narrate v5 spec. |
| [codex/assistant-narration-planning-optimization.md](codex/assistant-narration-planning-optimization.md) | Archived | Historical v3 planning and highlighting rationale, superseded by the server-owned-group v5 replacement spec. |
| [codex/assistant-math-rendering.md](codex/assistant-math-rendering.md) | Active Spec | Implementation and automated desktop/mobile validation landed; physical-phone validation remains. Covers display/inline KaTeX, Markdown-aware delimiters, snapshot-safe streaming, responsive safe display wrapping, exact measured geometry, literal fallback, narration, bounded caches, and t3code-informed mutable-tail discipline. |
| [codex/narration-onnx-synthesis.md](codex/narration-onnx-synthesis.md) | Archived | Historical finite-task and native Kokoro rationale, superseded by task-v6 streaming in the Narrate v5 spec. |
| [codex/thread-operation-queue.md](codex/thread-operation-queue.md) | Implemented | Hidden-when-empty process-memory queue for pending messages and compactions, with direct idle dispatch, steering, delete, and cancel-on-interrupt semantics. |
| [codex/server-authoritative-transcript-windows.md](codex/server-authoritative-transcript-windows.md) | Active Spec | Version 2 implementation landed: self-contained turn frames, grouped work/detail disclosure, incremental rollout indexing, native lifecycle resume, window sliding, safe-area ownership, and Version 1 compatibility. Physical iOS validation and the observation-release cleanup remain. |
| [codex/transcript-identity-reconciliation.md](codex/transcript-identity-reconciliation.md) | Active Spec | Canonical item identity model for persisted and live transcript items. |
| [codex/transcript-store-scroll.md](codex/transcript-store-scroll.md) | Implemented | Transcript resource/layout/viewport ownership and scroll model. |
| [codex/archive/app-server-facade-thread-history.md](codex/archive/app-server-facade-thread-history.md) | Archived | Historical thread-history read phase. |
| [codex/archive/client-transcript-read-api.md](codex/archive/client-transcript-read-api.md) | Archived | Historical client read API phase. |
| [codex/archive/current-thread-send-invalidation.md](codex/archive/current-thread-send-invalidation.md) | Archived | Historical send/invalidation phase. |
| [codex/archive/rust-transcript-server.md](codex/archive/rust-transcript-server.md) | Archived | Historical Rust transcript server phase. |

## Narrate Specs

| Spec | Status | Notes |
| --- | --- | --- |
| [narrate-viewer-playback.md](narrate-viewer-playback.md) | Active Spec | Narrate Markdown viewer integration: authoritative logical Markdown blocks and DOM offsets, document-scoped playback states and controls, sentence/word/structural paint, seeking/follow behavior, revision fencing, and realistic verification. |
| [narration-client-package.md](narration-client-package.md) | Implemented | The generic transport, lifecycle, browser audio, cue resolution, strict decoding, and controller now live in `@remux/narration-client`; Codex is the sole v1 dogfood consumer and Narrate-viewer playback remains explicitly deferred. |
| [narrate-structural-transcripts.md](narrate-structural-transcripts.md) | Implemented | v5 text-only structural projection: Sol authors plain transcripts for code/table/diagram blocks, then every generated word flows through the shared Misaki baseline and pronunciation review. |
| [narrate-pronunciation-audit.md](narrate-pronunciation-audit.md) | Implemented | v4 post-transcript review: one complete projected speech document, contextual Misaki baseline, raw unresolved-phone evidence, explicit Kokoro lexical vocabulary, and sparse Sol corrections before synthesis. |
| [narrate-batch-alignment.md](narrate-batch-alignment.md) | Implemented | Current exact-source word/sentence alignment, NLP-aware acoustic planning, Kokoro duration projection, final-WAV artifact, and Codex-owned playback/highlighting contract. |
| [narrate-local-g2p-sparse-patches.md](narrate-local-g2p-sparse-patches.md) | Archived | Historical v6 whole-document sparse-patch pipeline, superseded by batch alignment and bounded full-word pronunciation review. |
| [narrate-streaming-g2p.md](narrate-streaming-g2p.md) | Archived | Historical v5 complete model-generated token/phoneme contract, superseded by the local-G2P sparse-patch v6 implementation. |
| [narrate-streaming-g2p-contract-rd.md](narrate-streaming-g2p-contract-rd.md) | R&D evidence | Real-thread contract/model benchmark that found the v4 cardinality failure, then live sparse-contract fragility, and motivated server-owned token structure, explicit risk metadata, and removal of repair turns. |
| [narrate-streaming-g2p-rd.md](narrate-streaming-g2p-rd.md) | R&D evidence | Earlier model/contract/latency experiments supporting whole-document streaming and showing that complete per-token phonemes are viable; later contract conclusions are normative in the v5 spec. |
| [narrate-baseline-patch-rd.md](narrate-baseline-patch-rd.md) | R&D evidence | Follow-up experiment where local G2P owns every phoneme and alignment while Sol returns only id-addressed spoken-text patches and required summaries; implemented in v6 with native Misaki. |
| [narrate-service.md](narrate-service.md) | Archived | Historical service extraction and temporary Codex compatibility proxy, superseded by the direct v5 hard cut. |

## Terminal Specs

| Spec | Status | Notes |
| --- | --- | --- |
| [terminal/phase-1.md](terminal/phase-1.md) | Active Spec | Phase 1 mobile-first terminal extension design. |
| [terminal/phase-2-validation.md](terminal/phase-2-validation.md) | Active Spec | Validation harness and hardening plan for terminal reliability. |
| [terminal/phase-3-local-tmux.md](terminal/phase-3-local-tmux.md) | Active Spec | Local tmux detection, session/window/pane context, and mobile tmux controls. |
| [terminal/phase-4-input-latency-and-resync.md](terminal/phase-4-input-latency-and-resync.md) | Active Spec | Input latency and background-resync plan: control/data plane split, reconnect replay, fire-and-forget input, fanout gating. |

## Platform Specs

| Spec | Status | Notes |
| --- | --- | --- |
| [html-file-preview-v1.md](html-file-preview-v1.md) | Implemented — iOS Expo preview published | Interactive self-contained HTML in existing file tabs, with Preview/Source and companion links. iOS update published and served bundle verified; no server restart needed. Android enabled in source; device acceptance remains unperformed. |
| [multi-provider-agent-workspace-extension.md](multi-provider-agent-workspace-extension.md) | Archived prototype | Historical full-capsule T3 Code integration. Its provider analysis, gateway, and mobile findings remain evidence; its source and extension were removed when Agent became the product path. |
| [agent-native-provider-runtime-v1.md](agent-native-provider-runtime-v1.md) | Active Spec — implementation landed; live/phone acceptance pending | Canonical Agent replacement: native Codex/Claude harness adapters, light durable coordinator, server-authoritative virtualized UI, chat-only interaction, native same-provider subagents, and scoped MCP cross-provider federation. |
| [agent-canonical-turn-journal-v2.md](agent-canonical-turn-journal-v2.md) | Active Spec — implementation landed; physical-phone acceptance pending | Ordered provider-neutral turns and assistant passes, native reasoning boundaries, lazy exact-diff artifacts, stable block identity, scope-correct usage/compaction/child events, restart-safe reconciliation, legacy migration, and bounded federated-child rediscovery. |
| [agent-composer-control-plane-v2.md](agent-composer-control-plane-v2.md) | Implemented in working tree — audit amendments verified locally; live/device acceptance pending | Composer control plane with provider-scoped selection, server-side preferences, capability gating, normalized context/plan usage, and provider-native Compact. The remediation spec tracks verification evidence and remaining acceptance. |
| [agent-conversation-lineage-and-sidebar-tree-v1.md](agent-conversation-lineage-and-sidebar-tree-v1.md) | Active Spec — implementation landed; live provider/physical-phone acceptance pending | Stable chats with immutable edit strands, explicit-fork child conversations, native Codex/Claude context branching, deterministic strand paths, historical transcript reads, and a virtualized mobile-safe sidebar tree. |
| [agent-runtime-management-v1.md](agent-runtime-management-v1.md) | Active Spec — daemon transport, local ownership, and runtime status UI implemented; shared host management pending | Host-owned harness installations and lifecycle, one persistent Codex daemon, per-session Claude processes, provider-neutral controller leases, safe upgrades, and Codex-extension fallback coexistence. |
| [agent-transcript-ui-controller-v1.md](agent-transcript-ui-controller-v1.md) | Active Spec — implementation pending | Cleanup of the working Agent transcript around one authoritative snapshot, pure disclosure/geometry/viewport policy, and a single DOM driver while preserving virtualizer and UI parity. |
| [agent-state-authority-and-synchronization-v1.md](agent-state-authority-and-synchronization-v1.md) | Active Spec — queue and Codex compaction authority slices implemented; projection-fence and module-extraction passes remain | Strict separation of commands, queue entries, provider observations, canonical timeline facts, and projections; coverage-aware history reconciliation; branch-stable control identity; projection revisions; typed invalidations; and one client synchronization controller. Remediation pass 1 owns current sequencing and focused extraction. |
| [agent-audit-2026-09-05-findings.md](agent-audit-2026-09-05-findings.md) | Audit record — 84 original findings, 8 incident follow-ups, 1 implementation finding; implementation tracked | Preserves all original finding IDs; planned coverage is separate from implementation status and evidence. Adds Claude context/compaction, timestamp/history-sync, Codex child-projection, and transcript error-geometry incidents, plus the reproduced Claude configuration return-switch finding, for 93 tracked rows. |
| [agent-audit-remediation-pass-1.md](agent-audit-remediation-pass-1.md) | Active Spec — S2a2 and H2/H4 deployed; remaining slices tracked | S2a2 steer/manual Compact and host watcher/publication fixes deployed from bounded Sol lanes; per-slice commits/pushes, batch builds/deployment, primary review, and explicit remaining/deferred scope. |
| [agent-new-chat-recovery.md](agent-new-chat-recovery.md) | Implemented — live recovery verified | Recover creation, first-message and ordinary-send results after reconnect/reload; preserve draft edits and stable request identities, and release only confirmed rejected sends. |
| [agent-subagent-lifecycle.md](agent-subagent-lifecycle.md) | Implemented — deployed with live acceptance | Durable agent/assignment identity, restart reconciliation, conversation/child Stop, evidence-based phantom repair and a composer icon activity color. Broader audit remains paused. |
| [agent-command-delivery-s2a.md](agent-command-delivery-s2a.md) | Reviewed contract — root delivery closure deployed; later adoption pending | Shared durable delivery attempts, exact native acceptance evidence, bounded staging and atomic admission; remediation pass 1 owns serial Sol assignments and verification status. |
| [agent-runtime-and-epoch-context.md](agent-runtime-and-epoch-context.md) | Archived | Original single-provider harness and phased epoch plan. Provider/auth/UI foundations remain historical rationale; current provider/runtime behavior is governed by `agent-native-provider-runtime-v1.md`. |
| [agent-durable-epoch-core.md](agent-durable-epoch-core.md) | Archived | Historical durable-journal, shadow-compiler, and rollover plan. The journal survived; epoch and shadow-context semantics did not. |
| [agent-turns-and-work-units.md](agent-turns-and-work-units.md) | Archived | Historical custom work-unit design, superseded by provider-native children and MCP-federated cross-provider executions. |
| [agent-background-working-memory-v1.md](agent-background-working-memory-v1.md) | R&D evidence | Historical background working-memory experiment; not part of the current runtime. |
| [agent-bounded-work-units-v2.md](agent-bounded-work-units-v2.md) | Implemented experiment | Foreground-authored bounded child scopes, exact range evidence, early checkpoint budgets, and E0 results: context pressure fell sharply without compaction, but runtime/quality missed Codex and sticky whole-file state polluted the handoff layer, so it is not the default. |
| [agent-thread-runtime-v1.md](agent-thread-runtime-v1.md) | Archived | Historical versioned-Thread and turn-capsule checkpoint. |
| [agent-thread-runtime-v2.md](agent-thread-runtime-v2.md) | Archived | Historical exact-dialogue/living-Thread checkpoint, superseded by explicit per-turn context. |
| [agent-living-thread-canvas-v1.md](agent-living-thread-canvas-v1.md) | Archived | Historical model-authored Thread canvas, removed from the runtime. |
| [agent-explicit-turn-context-v1.md](agent-explicit-turn-context-v1.md) | Archived | Historical Pi provider-lane and explicit context compiler, to be deleted at native Codex cutover. |
| [agent-inference-trace-and-resilient-streaming.md](agent-inference-trace-and-resilient-streaming.md) | Archived | Historical custom inference/work-unit runtime. Its server-authoritative transcript and mobile recovery evidence is retained by the native-provider spec. |
| [agent-ledger-benchmark-corpus.md](agent-ledger-benchmark-corpus.md) | R&D evidence + Adaptive v2 | Detailed Ledger/Remux transcript corpus plus sanitized production-path fixtures, the adaptive owner-driven controller, frozen reference validation, and measured Codex/Agent runs. |
| [agent-ui-parity-and-phased-delivery.md](agent-ui-parity-and-phased-delivery.md) | Archived | Historical UI port plan. The current viewer/virtualizer remains the retained foundation under the native-provider runtime spec. |
| [agent-phase-1a0-ui-port-scope.md](agent-phase-1a0-ui-port-scope.md) | Archived | Historical UI-port checkpoint; accepted viewer behavior is retained by the native-provider runtime. |
| [agent-phase-1a0-implementation-report.md](agent-phase-1a0-implementation-report.md) | Archived | Historical Phase 1A.0 source/deviation/test and owner-acceptance record. |
| [agent-phase-1a1-durable-history-scope.md](agent-phase-1a1-durable-history-scope.md) | Archived | Historical Pi-era durable conversation scope; journal, artifact, idempotency, and recovery findings inform the replacement. |
| [agent-phase-1a1-implementation-report.md](agent-phase-1a1-implementation-report.md) | Archived | Historical Phase 1A.1 durability and owner-acceptance record. |
| [agent-phase-1a2-transcript-hardening-scope.md](agent-phase-1a2-transcript-hardening-scope.md) | Archived | Historical transcript-hardening scope; bounded resources, scale, lifecycle, and fault findings are retained. |
| [agent-phase-1a2-implementation-report.md](agent-phase-1a2-implementation-report.md) | Archived | Historical Phase 1A.2 transcript, scale, lifecycle, and performance record. |
| [viewer-kit.md](viewer-kit.md) | Active Spec | `@remux/viewer-kit` SDK Phase 1: host bridge, bootstrap, UI primitives, and the shared design-token contract. Satellites migrated; lifecycle deferred. |
| [viewer-kit-phase-2.md](viewer-kit-phase-2.md) | Active Spec | Phase 2 frame depth: dual-substrate theme system, codex color onboarding, and the component library. Chat primitives + lifecycle out of scope. |
| [viewer-kit-phase-3.md](viewer-kit-phase-3.md) | Active Spec | Theme-readiness & ownership: classify every theme-sensitive color as kit role / viewer extension / engine palette and tokenize the dark side. Substrate-neutral; Tailwind convergence is an optional Phase 4. Prerequisite for light mode. |
| [viewer-kit-light-mode.md](viewer-kit-light-mode.md) | Active Spec | App-wide system-tied light mode: host-driven theme signal (kit-optional extension contract), RN shell + files/settings cleanup on generated native tokens, semantic-tier remap, engine light palettes (xterm/CodeMirror/Shiki/Mermaid). |
| [light-mode-polish.md](light-mode-polish.md) | Active Spec | Light-mode cleanup: codex composer buttons, terminal active-key legibility, terminal launcher icon. Roots to two bug-classes (accent-foreground off an accent fill; hardcoded-black elevation) + one non-self-contained icon asset. |
| [files-tab.md](files-tab.md) | Active Spec | Files tab overhaul: freshness model (tab re-entry + expanded-descendant refresh with an explicit concurrency/failure contract), `remux/fs/didChange` push invalidation (3-layer detection: served-dir watchers + `.git` watchers + git-status poller; fs-core invalidate/subscribe API; shared `isPathWithin` contract), SF Symbol icon redesign with PNG fallback. |
| [tab-identity-and-routing.md](tab-identity-and-routing.md) | Active Spec | Tab identity = resource key (no alias history); single `openResource` choke point with reuse dispositions; `host/navigate` intent delivery on reuse; codex host-bridge migration to viewer-kit (P2); RPC origin attribution to fix the codex draft→thread notification race; key-based tray dismissal so arriving at a resource clears its notifications. |
| [rpc-concurrency-and-mobile-resilience.md](rpc-concurrency-and-mobile-resilience.md) | Active Spec | P0/P1 transport hardening: non-blocking WebSocket/extension protocol readers, exhaustive typed RPC policies, bounded ordered lanes, mobile liveness and make-before-break reconnect, Codex retry safety, and sequenced Terminal input/replay recovery. |
| [resource-governance-and-l0-5.md](resource-governance-and-l0-5.md) | Active Spec | Remux-first scheduling, equal extension isolation, trusted child workloads, L0.5 phone recovery, semantic cancellable RPCs, persistent Codex containment, and safe connection generations are in-tree and active on the reference host; the broader soak/phone matrix and optional extension splits remain. |
| [weak-connectivity-viewers-and-commands.md](weak-connectivity-viewers-and-commands.md) | Active Spec | Bounded weak-link pass: immutable revisioned viewer caching, last-known catalog bootstrap, reconnect-durable idempotent commands, replaceable transcript queries, and de-inlined Codex transcript media. |
| [cli-rust-port.md](cli-rust-port.md) | Active Spec | CLI audit (EPIPE crash root cause, restart-policy and orphan-process defects) + Rust port roadmap: four-layer supervision (systemd/supervisor/crash containment/process hygiene), extension lifecycle state machine, per-extension logs, resource monitoring. |
| [cli-rust-port-pass-1.md](cli-rust-port-pass-1.md) | Implemented | Pass 1 implementation spec: full Rust replacement of the Node CLI in one pass — L1 crash-restart supervisor, L2 extension state machine with crash budget, EOF→SIGTERM→SIGKILL stop with confirmed reap, per-extension logs RPC, journal rotation, chaos test suite, cutover. Punts L0/systemd, full L3, resource monitoring (pass 2). Landed as the `cli/` Rust crate. |
| [cli-rust-port-pass-2.md](cli-rust-port-pass-2.md) | Implemented | Pass 2 implementation spec: L0 systemd user service, worker hang watchdog, full L3 process hygiene (pgroups + PDEATHSIG + boot orphan sweep), manifest `build` phase (no `cargo run` in production), `/proc` resource monitoring + `remux/system/resources*` RPCs, failed-state push notifications, and the app Settings ops UI (live badges, log tail, System section). Punts auth token and CLI subcommands to pass 3. |
| [cli-rust-port-pass-3b-cli.md](cli-rust-port-pass-3b-cli.md) | Active Spec | Pass 3b (final): `remux` on PATH via `~/.local/bin` symlink (rebuild-transparent), root discovery so every subcommand works from any cwd, systemd-first `start|stop|restart`, `status` (new authenticated `GET /api/status` + binary-staleness check), file-based `logs -f`, 12-check `doctor`, idempotent `install` (embedded unit, node/npm symlinks — fixes the unit-PATH deploy blocker), role-keyed resource sampling so watch sidecars hit the memory ceiling. |
| [cli-rust-port-pass-3-auth.md](cli-rust-port-pass-3-auth.md) | Implemented | Pass 3a: shared bearer token on `/ws` + HTTP — token file (`.remux/auth-token`, 0600) + `remux token` subcommand, one axum middleware (health exempt, constant-time compare), cookie hand-off for WebView subresources, app token setting + header plumbing, app-before-runtime rollout. TLS/public exposure rejected; tailnet stays the transport layer. |
| [extension-operations-and-logs.md](extension-operations-and-logs.md) | Implemented — Pending Live Validation | Three-component Codex operations model: independently controlled Extension Server, persistent Codex App Server daemon, and Viewer; stage/apply actions, restart reconciliation, and component-scoped logs with severity separated from stdout/stderr. |
| [view-build-watch.md](view-build-watch.md) | Active Spec | Manifest `build` phase extended to views + managed `watch` sidecar: supervisors for view-only extensions (editor/markdown), build sequencing with watch-owned dist rule, run-state v2 (role-keyed), watch RPCs + status facets, app Settings watch controls + `watch` log stream, all-extension rollout. Rejects HMR/dev-server proxying; serving stays static-from-disk. |
