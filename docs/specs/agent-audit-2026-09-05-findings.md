Status: Audit record — 84 original findings, 6 incident follow-ups, 1 implementation finding; implementation tracked
Last verified: 2026-09-05
Canonical code: `extensions/agent/`, `crates/remux/`, `app/src/`
Remediation: [agent-audit-remediation-pass-1.md](agent-audit-remediation-pass-1.md)

# Agent audit 2026-09-05 — findings register

Nine independent read-only reviews (GPT-5.6-Sol, xhigh) covered the four
commits that made native Agent the product path, one slice each, followed by
spot checks and a verification pass over the remediation spec. This file is
the original 84-row list; I1–I6 below add incidents from the subsequent
conversation, and A13 records a reproduced implementation-stage finding.
Every row retains its finding ID and a planned disposition.
Pass references identify coverage, not completed fixes. The remediation spec's
S0–S7 table determines delivery order and its slice records hold review evidence.
Original line numbers are as of `bdd6825` and will drift.

Severity and confidence in original rows are the audit's assessments: P1 bug,
P2 spec drift or bounded bug, P3 nit. Plausible rows require reproduction before
prescribing a fix. Revalidate all other rows against the current tree at slice
entry; shared uncommitted changes may already address part of a finding.
Overlapping rows (for example J3/A1 and J8/A6) can share one fix and test.

Implementation status is separate: `planned` means not yet accepted by the
primary implementation review; `in progress` means a bounded slice is active;
`implemented` means code exists but acceptance is pending; `verified locally`
requires primary review and recorded test evidence; `verified live` requires
the relevant loaded-runtime check. Existing decisions retain `decision` status
while their documentation corrections remain scheduled. Deferred rows remain
open with a reason and revisit condition. No original row is newly certified
fixed by this documentation revision.

Test state at audit time: `npm run test:server` 181 of 182 with a Node 24
process abort in `codex-runtime-host.test.ts`; `npm run test:unit` pass;
`cargo test -p remux` pass.

Subsequent incident work passed 196 server tests, targeted desktop/mobile
browser checks, TypeScript checking, and builds. This is the prior run recorded
in remediation S0, not a new audit run. The socket-close cleanup remains worth
testing, but the earlier Node abort's attribution to that leak is unproven.

## Coordinator, schema, protocol

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| C1 | P1 | `native-coordinator.ts:2771`, `native-journal.ts:1377`, `:1464` | Pre-accept rejection or restart during dispatch marks the queue head `delivery_unknown`; claim refuses it; nothing reconciles; lane blocks forever. | Pass A | planned; revalidate at slice entry |
| C2 | P1 | `native-coordinator.ts:878`, `:1977`, `provider-adapter.ts:81` | Stop records adapter acceptance only; no durable interrupt-requested state, no `Stopping` projection, no watchdog. | Pass B | planned; revalidate at slice entry |
| C3 | P1 | `native-journal.ts:368`, `native-coordinator.ts:3826` | Concurrent commands with one command ID both execute; reproduced `UNIQUE constraint failed` on compaction. | Pass B | C3a verified locally, 234/234 server; restart/delivery remainder in S2 |
| C4 | P1 | `codex-event-mapper.ts:864`, `native-journal.ts:3193` | Late native-child completion attaches to the current root turn while the execution row keeps the original. | Pass C | planned; revalidate at slice entry |
| C5 | P2 | `native-coordinator.ts:1641`, `native-journal.ts:1262` | Edit/fork inserts the canonical destination turn before provider acceptance. | Pass B | planned; revalidate at slice entry |
| C6 | P2 | `schema.ts:91`, `:915` | v7 migration cannot add table-level foreign keys, so a v6-migrated DB differs from fresh. | Pass C (scoped constraint repair) | planned; revalidate at slice entry |
| C7 | P2 | `native-agent-server.ts:167`, `native-agent-protocol.ts:546` | No projection fence or typed changes; invalidations are broad keys plus journal sequence. | Pass E | planned; revalidate at slice entry |

## Journal, projector, artifacts

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| J1 | P1 | `native-projector.ts:681`, `native-agent-protocol.ts:981`, `native-artifacts.ts:120` | Passes keep full final text; a valid large final exceeds the 8 MiB resource ceiling; artifact 20 MiB cap not enforced. | Pass C | planned; revalidate at slice entry |
| J2 | P1 | `native-journal.ts:1745` | Snapshot reconciliation deletes uncovered live passes; empty complete domain inexpressible. | Pass C | planned; revalidate at slice entry |
| J3 | P1 | `codex-event-mapper.ts:1371`, `native-agent-journal.test.ts:876` | Block identity hashes mutable native item and session IDs; test codifies the change. | Pass C | planned; revalidate at slice entry |
| J4 | P1 | `native-output.ts:9` | Output sealing picks the highest ordinal, not the authoritative revision. | Pass C | planned; revalidate at slice entry |
| J5 | P1 | `schema.ts:819`, `native-projector.ts:843` | v11 repair records ambiguous duplicate compactions and leaves them visible. | Pass C | planned; revalidate at slice entry |
| J6 | P1 | `viewer/src/ipc/resourceInvalidations.ts:84` | Protocol-version mismatch becomes an empty invalidation instead of restart-required. | Pass E | planned; revalidate at slice entry |
| J7 | P2 | `native-journal.ts:2411` | Window reads load the whole active-strand path and return full `turnOrder`; several per-turn queries per window. | Deferred (perf; see remediation Out of scope) | deferred |
| J8 | P2 | `codex-event-mapper.ts:662` | Display bounds validated, not fitted; long command titles drop the start event. | Pass D | verified locally; full-envelope fitting, primary server 222/222 |
| J9 | P2 | `native-agent-journal.test.ts:951` | Acceptance suite lacks the boundary cases above and migrates synthetic partial schemas. | Passes A–E tests | planned; revalidate at slice entry |

## Provider adapters

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| A1 | P1 | `codex-event-mapper.ts:1080` | Ordinary Codex item subjects change across live, `thread/read`, resume, fork. | Pass C | planned; revalidate at slice entry |
| A2 | P1 | `codex-adapter.ts:826`, `:1073` | Edit-before fork sends `beforeTurnId`; absent in pinned v0.144.0 reference, present in installed 0.153.2. Unversioned assumption. | Pass B (verify supported fork semantics) | planned; revalidate at slice entry |
| A3 | P1 | `claude-adapter.ts:1009` | Finalized subagent assistant frames with `parent_tool_use_id` project into the root turn. | Pass C | planned; revalidate at slice entry |
| A4 | P1 | `claude-adapter.ts:1020` | Content-block ordinals reset per frame; same-kind blocks collapse. | Pass C | planned; revalidate at slice entry |
| A5 | P1 | `claude-adapter.ts:824`, `codex-event-mapper.ts:864` | Child ownership lost once the root turn ends; Claude drops post-result `task_notification`. | Pass C | planned; revalidate at slice entry |
| A6 | P1 | `codex-event-mapper.ts:662`, `claude-adapter.ts:939`, `:1318` | Oversized titles, reasoning revisions, and error messages drop whole events; `turn.completed` can fail validation. | Pass D | verified locally; v6 fitting/legacy compatibility, primary server 222/222 |
| A7 | P1 | `claude-adapter.ts:792` | `compact_result: 'failed'` ignored; manual compaction runs forever. | Pass B | partially verified in S1; error surfaced, but S2 source review requires correlated manual evidence before release; untagged failure is ambiguous |
| A8 | P1 | `claude-adapter.ts:544` | Resume fails the interrupted turn before the SDK init handshake. | Pass B | planned; revalidate at slice entry |
| A9 | P1 | `claude-adapter.ts:794` | `init.apiKeySource` ignored; `apiKeyHelper` and env keys pass. | Pass B | verified locally; open/init/fork gates and cleanup reviewed, SDK metadata limitations documented, 218/218 server tests |
| A10 | P2 | `claude-adapter.ts:1785` | Declares `usage.context: 'provider'` and read-and-push but emits only a derived estimate. | Pass B (reassess against I1 measurement) | verified locally; derived context declaration, implemented account read/push retained; selected Claude native-auto policy corrected |
| A11 | P2 | `provider-runtime.ts:9`, `:439` | Provider contract v4 undocumented; snapshot coverage is only `completeKinds`. | Pass C, Pass H | planned; revalidate at slice entry |
| A12 | P2 | `codex-event-mapper.test.ts:30`, `claude-adapter.test.ts:390` | Parity matrices uncovered: rewritten IDs, late children, real per-block frames, compact failure, apiKeySource. | Passes B–D tests | planned; revalidate at slice entry |
| A13 | P1 | Current working tree `claude-adapter.ts:649` (implementation finding, not original audit) | Per-turn model/effort changes compare to immutable opening settings; A→B→A skips the return to A and leaves native configuration at B. | S2 provider preparation prerequisite | verified locally; idempotent setters, null effort reset and failed preparation regression; primary 248/248 server; live pending |

## Runtime management

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| R1 | P1 | `codex-runtime-host.ts:286`, `codex-runtime-host.test.ts:100` | `closeSocket` races close against a 2 s delay and cancels neither; leaks a timer per close; audit observed a Node 24 abort, causal attribution unproven. | Pass A | verified locally; primary review, timer reproduction and 212/212 server integration |
| R2 | P1 | `native-coordinator.ts:2466`, `codex-adapter.ts:380` | Passive history hydration acquires ownership and resumes the native Codex thread. | Pass F | planned; revalidate at slice entry |
| R3 | P2 (plausible) | `native-coordinator.ts:3115`, `:3130`, `codex-adapter.ts:866` | Transport failure releases the lease before replacement reconciliation. | Pass F | planned; revalidate at slice entry |
| R4 | P2 | `SettingsOverview.tsx:232`, `:180`, `ws.rs:1149` | Runtime jobs treated as complete on admission; failures discarded. | Pass G | planned; revalidate at slice entry |
| R5 | P2 | `agentRuntimeApi.ts:44`, `SettingsOverview.tsx:213` | "Check runtimes" rereads cached status; no re-probe. | Pass G | planned; revalidate at slice entry |
| R6 | P2 | `codex-adapter.ts:150` | Daemon-managed executable published as the resolved configured executable. | Pass G | planned; revalidate at slice entry |
| R7 | P2 | `codex-runtime-host.test.ts:75` | No concurrent acquisition, restart reuse, daemon death mid-turn, or lease-window tests. | Pass B, Pass F tests | planned; revalidate at slice entry |

## Federation

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| F1 | P1 | `mcp-server.ts:343`, `native-artifacts.ts:180`, `schema.ts:492` | Attachment references not authorized against the caller; artifacts carry no ownership. | Pass F | verified locally; scoped grants, v12→v13 copied migration, 230/230 server; live pending |
| F2 | P1 | `native-coordinator.ts:551`, `native-journal.ts:2460` | Checkout key is raw `cwd`; aliases defeat one-writer-per-checkout. | Pass F | verified locally; real checkout keys, schema v14 reservations, exact release/descendant fencing; 246/246 server and copied-data preservation; live pending |
| F3 | P1 | `mcp-server.ts:487`, `native-coordinator.ts:1757`, `:3653` | Nested spawn resolves the root turn, not the caller's active turn. | Pass F | planned; revalidate at slice entry |
| F4 | P1 | `native-coordinator.ts:1854` | Spawn acceptance recorded after `startTurn`; lost response becomes durable rejection. | Pass F | planned; revalidate at slice entry |
| F5 | P2 | `mcp-server.ts:166`, `:331` | Frozen target catalog not enforced at spawn. | Pass F | verified locally; frozen scope plus current readiness; primary server 224/224 |
| F6 | P2 | `native-coordinator.ts:3753`, `:4065` | `changedFiles` unbounded. | Pass F | verified locally; 500 distinct paths with omitted count; primary server 224/224 |
| F7 | P2 | `AgentExecutionsView.tsx:214`, `ExecutionScope.tsx:397` | No native/federated ownership label. | Pass F | planned; revalidate at slice entry |
| F8 | P2 | `native-coordinator.ts:3854` | Child resources use broad invalidations. | Pass E | planned; revalidate at slice entry |
| F9 | P2 | `federation-mcp.test.ts:605`, `:699`, `viewer.spec.ts:87` | Matrix lacks aliases, lost acceptance, grandchildren, attachment ownership, catalog, Host/Origin, Claude-to-Codex. | Pass F tests | planned; revalidate at slice entry |

## Transcript UI controller

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| T1 | P1 | `resumeSync.ts:41`, `useTranscriptViewportController.ts:1167` | Resume always requests the tail window; a reader of old history jumps. | Pass E | planned; revalidate at slice entry |
| T2 | P1 | `useConversationActions.ts:223`, `useTranscriptViewportController.ts:464` | Edit publishes the new anchor before the new snapshot; preserved transcript snaps to bottom. | Pass E | planned; revalidate at slice entry |
| T3 | P1 | `resourceStore.ts:1300` | Incremental refresh re-infers `workingTurnId` from frame status over authoritative `activeTurnId`. | Pass E | planned; revalidate at slice entry |
| T4 | P1 | `resourceStore.ts:163`, `:199`, `:570` | Execution-scope and detail caches unbounded; reads not cancelled on switch or background. | Pass E | planned; revalidate at slice entry |
| T5 | P2 | `viewportTypes.ts:1`, `useTranscriptViewportController.ts:120`, `:249` | No single atomic viewport plan; anchor, extent, runway split across ref, state, store, DOM. | Deferred (remediation Out of scope) | deferred |
| T6 | P2 (plausible) | `WorkSection.tsx:44`, `useTranscriptViewportController.ts:551`, `:455` | Expanded work commits at height zero then corrects next frame; read-then-write in one observer callback. | Deferred with T5 | deferred |
| T7 | P2 | `agent-transcript-ui-controller-v1.md:439` | Verification record overstates coverage; header status "Implemented — automated verification complete" not honest. | Pass H | planned; revalidate at slice entry |
| T8 | P3 | `virtualizerScroll.ts:1`, `useTranscriptViewportController.ts:149` | Phase 5 shims and write-only refs remain; inclusive range bounds mount one extra turn. | Deferred (cleanup) | deferred |

## Viewer application

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| V1 | P1 | `useConversationActions.ts:141`, `agentCommands.ts:101` | Retries mint new command and client message IDs; lost response duplicates the turn. | Pass E | planned; revalidate at slice entry |
| V2 | P1 | `resourceInvalidations.ts:30`, `useAgentResources.ts:191`, `historyStore.ts:88` | Three independent refresh paths; tray and transcript disagree; refetch storms. | Pass E | planned; revalidate at slice entry |
| V3 | P1 | `useConversationActions.ts:222`, `resourceStore.ts:444` | Edit hydration exhaustion treated as success; old strand stays without error. | Pass E | planned; revalidate at slice entry |
| V4 | P1 | `turnAction.ts:95`, `useConversationActions.ts:188` | Head-CAS rejection leaves the editor bound to the stale strand and revision. | Pass E | planned; revalidate at slice entry |
| V5 | intent | `useConversationActions.ts:248`, `viewer.spec.ts:751` | Stop preserves queued messages; Codex extension clears them. | Decision: keep preservation | decision; docs planned |
| V6 | P1 | `App.tsx:128`, `drafts.ts:9` | Draft access level in-memory only; reload resets read-only to workspace-write. | Pass E | verified locally; delayed-default/access-only reload and draft switching; full viewer 179 passed |
| V7 | P1 | `ConfigButton.tsx:228`, `nativeViewModel.ts:63` | Effort row and Off shown for models that advertise no efforts. | Pass E | verified locally; native string/null effort projection, selection and submissions; full viewer 179 passed |
| V8 | intent | `Sidebar.tsx:88`, `agentCommands.ts:91` | No historical preview or Make Current UI though the spec and README claim it. | Decision: server-only, fix docs | decision; docs planned |
| V9 | intent | `usageWindows.ts:3`, `usage-windows.test.ts:14` | Codex Spark usage windows omitted while the composer spec requires every window. | Decision: keep omission, fix spec | decision; docs planned |
| V10 | P2 | `UsageTray.tsx:23`, `:53` | Compact eligibility ignores queued compact and session resumability. | Pass E | verified locally; selected runtime/queue, resumability and queued/running gating; full viewer 179 passed |
| V11 | P2 | `viewer.spec.ts:751`, `viewer-lifecycle.spec.ts:9` | No coverage for lost response, CAS conflict, hydration failure, reload mid-stream, stopping across reload. | Pass E tests | planned; revalidate at slice entry |

## Rust host and app host

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| H1 | P1 | `ws.rs:781`, `:1425`, `:43` | Agent lanes keyed by caller conversation ID, never evicted; 512 cap is global. | Pass G | planned; revalidate at slice entry |
| H2 | P1 | `viewer_bundles.rs:170`, `:294` | Watcher registers only roots existing at startup. | Pass G | planned; revalidate at slice entry |
| H3 | P1 | `supervisor.rs:1291` | Manual view builds detached; not reaped on stop or restart. | Pass G | planned; revalidate at slice entry |
| H4 | P1 (plausible) | `viewer_bundles.rs:519` | Publication renames before insert; cleanup without the per-view lock can delete it. | Pass G | planned; revalidate at slice entry |
| H5 | P2 | `extension_gateways.rs:614` | `Connection`-nominated headers not stripped on non-101 responses. | Pass G | planned; revalidate at slice entry |
| H6 | P2 | `ws.rs:1425` | Lane policy is a hard-coded method list, not derived from the request contract kind. | Pass G | planned; revalidate at slice entry |
| H7 | P2 | `ExtensionWebView.tsx:525` | Lifecycle evidence consumed before page readiness; `inactiveForMs` lost. | Pass G | planned; revalidate at slice entry |
| H8 | P2 | `lifecycleEvidence.ts:41` | One clock for native suspension and tab switch; tab return reports suspension. | Pass G | planned; revalidate at slice entry |
| H9 | P2 | `crates/remux/tests/extension_gateway.rs:214` | No unauthorized WS upgrade, chunked or aborted upload, mid-stream disconnect, hop-by-hop tests. | Pass G tests | planned; revalidate at slice entry |
| H10 | P2 | `app/package.json:17` | Viewer host-contract and lifecycle scripts not wired into any aggregate or CI. | Pass H | planned; revalidate at slice entry |
| H11 | P3 | `crates/remux/Cargo.toml:11` | `remux-fixture-ext` is an unconditional binary target. | Deferred (nit) | deferred |

## Documentation

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| D1 | P2 | `docs/specs/README.md:85`–`:91` | Five status cells disagree with spec headers. | Pass H | planned; revalidate at slice entry |
| D2 | P2 | lineage spec `:13`, README `:31` | Claims tree, version, preview, Make Current UI that the viewer lacks by decision. | Pass H | planned; revalidate at slice entry |
| D3 | P2 | journal spec `:145`, composer spec `:108`, lineage `:15` | Version boundaries say provider 3, protocol 4–5, schema 6–7; code is 4, 8, 11. | Pass H | planned; revalidate at slice entry |
| D4 | P2 | native, journal, composer headers | "Live acceptance passed" with no committed evidence. | Pass H | planned; revalidate at slice entry |
| D5 | P3 | README `:69`, `constants.ts:3` | Five MCP tools listed; six exist. | Pass H | planned; revalidate at slice entry |
| D6 | P3 | README index composer row | Says transcript and meter presentation deferred; both landed. | Pass H | planned; revalidate at slice entry |
| D7 | P3 | `docs/architecture/codex-extension.md:13` | Describes `cargo run` launch and a partial RPC list. | Pass H | planned; revalidate at slice entry |
| D8 | P3 | native spec "Pre-cutover" section | Describes the Pi-based Agent as current. | Pass H | planned; revalidate at slice entry |
| D9 | P3 | archived phase and runtime specs | Cite deleted files from `d960d2a`. | Pass H | planned; revalidate at slice entry |
| D10 | P3 | several specs | Header block order violates the index rule. | Pass H | planned; revalidate at slice entry |

## Subsequent conversation incidents

These rows supplement the audit and retain its original IDs unchanged. Evidence
is recorded in remediation S0 and its reviewed slice records. I1–I4 fixes are in
the shared working tree and verified locally. I3 includes copied-data repair
acceptance; its live repair remains pending. I4 includes desktop/mobile browser
geometry acceptance; the original device check remains pending. No manual live
Claude threshold-crossing verification has been recorded. The later committed
checkpoint was rebuilt/restarted with thread-preservation and desktop/mobile
smoke checks; that did not establish Stop-after-recovery or child reconciliation.

| ID | Sev | Where | Finding | Planned disposition | Implementation status |
| --- | --- | --- | --- | --- | --- |
| I1 | P1 | `claude-adapter.ts`, `claude-context-usage.ts`, `native-journal.ts`, `native-projector.ts`, `UsageTray.tsx` | Summed per-turn input/cache counts overstated current context; child usage could overwrite the root meter. Native auto-compaction was disabled. User requested a default 300k native compaction policy with actual model capacity kept distinct. | S0 preserve/review current fix; A10 separately reassesses capability declarations. | verified locally; live check pending |
| I2 | P1 | `native-journal.ts`, `StatusMessageRow.tsx` | Provider events before durable admission moved materialized timestamps before creation; ingestion and later history replay hit `updated_at >= created_at` even though the answer completed. | S0 preserve/review monotonic timestamps and history-error labeling; S2 retains admission-race scenarios. | verified locally; live check pending |
| I3 | P1 | `codex-event-mapper.ts:828`, `:864`, `:1125`, `nativeTranscriptViewModel.ts:597`, `useAgentExecutions.ts:62` | Activity and child-thread notifications use different turn-ID forms and create two blocks for one child; completed activity remains running; a child's message to its parent creates a phantom descendant. Shared disclosure keys expose both duplicate blocks as the same dropdown. | S0a priority slice; overlaps C4/A1/A5, adds event-semantics/parentage regression coverage and scoped existing-data repair. | verified locally; runtime and copied-data repair reviewed, live application/device check pending |
| I4 | P1 | `TranscriptViewportBody.tsx:76`, `layout/measureCollapsed.ts:124`, `geometry/geometryIndex.ts:49`, `viewer.spec.ts:478` | Terminal error banner and per-turn projection-retry control render outside measured rows; virtual height and later turn positions omit their normal-flow height. Existing error test checks visibility, not geometry. | S0b priority slice; explicit measured client display rows/footer, cache invalidation, desktop/mobile navigation/anchor regression tests. Does not require deferred T5/T6 rewrite. | verified locally; primary review and full viewer integration, live/device check pending |
| I5 | P1 | `codex-adapter.ts:683`, `:752`, `native-coordinator.ts:3408` | Resume passes a durable active-turn binding but the adapter does not restore its control field; Stop and steer reject while the native turn continues. Child active attempts also need restoration and exact-target Stop. | [Subagent lifecycle checkpoint A](agent-subagent-lifecycle.md); overlaps C2/R7. | implementation in progress |
| I6 | P1 | `native-coordinator.ts:2702`, `codex-child-registry.ts`, `AgentExecutionsView.tsx` | Child history sync returns when any turn exists, so missed terminal evidence leaves real children running. Ten historical interaction-created phantoms also remain in the live journal. | [Subagent lifecycle A/B/C](agent-subagent-lifecycle.md): autonomous reconciliation, proven repair, shared lifecycle projection and stable bottom activity row. | implementation in progress |

I1 evidence: [request accounting tests](../../extensions/agent/tests/claude-context-usage.test.ts),
Claude adapter root/child and compaction coverage, journal root/legacy-context
tests, and desktop/mobile usage-tray checks. The default is a native policy
setting, not a claim that every child has been observed compacting at 300k.

I2 evidence: [journal tests](../../extensions/agent/tests/native-agent-journal.test.ts)
for pre-admission live/replay events, stale running status, early completion and
compaction, and historical imports; [coordinator test](../../extensions/agent/tests/native-agent-coordinator.test.ts)
for events before admission followed by forced history sync; desktop/mobile
history-retry checks; reproduction with a copied affected turn. Observation
timestamps remain intact and the live database was not modified.

I3 evidence: remediation's I3 section records journal sequences 142651/142652,
142709, 142740/142741 and the native message-to-parent identity. The local mapper
reproduction requires no paid provider call. Duplicate blocks exist at start,
not only completion; the execution view's second entry is a phantom descendant,
not a second actual Sol delegation.

I4 evidence: screenshot and durable `serverOverloaded` error on turn
`f58192e3-f52d-45b3-b667-fd2353fe32ba`; renderer appends banner/retry after
measured rows while measurement and geometry omit both. Remediation's I4
section records the bounded fix and primary acceptance. Typed footer measurement
and rendering now share the same snapshot, revision and constants. Six focused
desktop/mobile cases verify geometry within 2 CSS px; the full viewer suite
passes 159 tests with three existing platform skips. Live/device check pending.

## Coverage totals — not a completion count

| Disposition | Count |
| --- | --- |
| Original findings assigned planned remediation | 76 |
| Existing decisions retained; docs corrections planned | 3 (V5, V8, V9) |
| Deferred with reason | 5 (J7, T5, T6, T8, H11) |
| Original audit total | 84 |
| Subsequent incident rows, locally verified; live acceptance pending | 4 (I1–I4) |
| Reproduced implementation-stage findings | 1 (A13) |
| Total tracked rows | 89 |

Deferral revisit conditions are in the remediation spec's Out of scope section.
Update implementation statuses and evidence per reviewed slice, not by changing
this planned-coverage table into a percentage-complete claim.
