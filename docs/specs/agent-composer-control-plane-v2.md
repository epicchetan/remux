Status: Implemented in working tree — audit amendments verified locally;
live/device acceptance pending
Last verified: 2026-09-05
Canonical code: `extensions/agent/shared/provider-runtime.ts`,
`extensions/agent/shared/native-agent-protocol.ts`,
`extensions/agent/server/src/native-runtime/`,
`extensions/agent/server/src/providers/`, and
`extensions/agent/viewer/src/composer/`
Amends: `agent-native-provider-runtime-v1.md`
Depends on: `agent-canonical-turn-journal-v2.md`
Amended by: `agent-state-authority-and-synchronization-v1.md` for message queue
admission, dispatch acceptance, pre-accept failure, projection fences, and
client convergence.
Amended by: `agent-audit-remediation-pass-1.md` for staged implementation,
current context/compaction policy, and reviewed acceptance evidence.

# Agent composer control plane v2

## Outcome

The Agent composer becomes a provider-aware control plane over native Codex and
Claude Code sessions. Provider, model, effort, and access are explicit values;
the server owns durable preferences and capability decisions; switching threads
cannot briefly expose controls from the wrong provider; and every submitted
operation carries the configuration the user saw.

The same pass retains and presents context and subscription usage that the
native providers already expose. Context usage is conversation-scoped and belongs on
`agent/runtime:<conversationId>`. Plan usage is account-scoped and belongs on
`agent/providers`. Manual Compact is a native session operation with durable
lifecycle, not an Agent-authored prompt or a replacement compactor.

This spec defines composer behavior, its usage tray, and its supporting runtime contracts. The
ordered event scopes, turn/pass/block structure, control-event placement, and
schema migration are defined by `agent-canonical-turn-journal-v2.md`. This spec
does not redesign transcript pixels.

## Scope

This version owns:

- provider-instance, model, effort, and access selection for a new
  conversation;
- server-authoritative model, effort, and idle-session access changes for an
  existing conversation;
- per-provider sticky model and effort defaults;
- deterministic effort repair when a model changes;
- target-keyed loading and revision fencing during conversation switches;
- capability gating for composer actions and matching coordinator enforcement;
- propagation of model and effort through edit-and-regenerate and fork;
- normalized per-turn, cumulative, context, cost, and account-plan usage;
- the compact resting usage rail and expanded context/subscription tray;
- provider-native manual and automatic compaction state; and
- mobile suspend, reconnect, and multi-viewer reconciliation for this state.

The following remain out of scope:

- transcript rendering or a new transcript usage row;
- provider-specific context inspectors or category breakdowns;
- per-message context inclusion toggles, artifact readers, or a replacement
  context compiler;
- a Remux-authored automatic compaction threshold;
- arbitrary slash-command UI;
- changes to provider-native prompts, tools, history, or same-provider
  subagents; and
- migration of message-body drafts out of their existing viewer store. Only
  provider/model/effort persistence is replaced here.

## Current defects this version closes

| Defect | Required correction |
| --- | --- |
| New conversations always use `workspace-write` | Access is a visible, explicit create-time selection and is included in the command. |
| Runtime becomes `null` while switching threads | Composer state is keyed and fenced by target; unknown capability means locked, never permissive. |
| Provider is inferred from a model-id prefix | Provider instance is a first-class selection key. Model IDs need only be unique within an instance. |
| Only model and effort are capability-gated | Attach, file references, interrupt, steer, queue, edit, fork, and Compact are gated in both viewer and coordinator. |
| Edit and fork omit model and effort | The branch command and first branch turn carry the submitting composer configuration. |
| Model and effort live in `sessionStorage` effects | Explicit conversation and provider preferences live in the journal and are projected by existing resources. |
| Codex drops last-turn/context-window usage | Both `last` and `total` token data are normalized and context is projected. |
| Claude drops model usage, context, cost, and rate-limit messages | The adapter maps the richer result shape, context reads, compact events, and plan push events. |
| Provider reads discard model-scoped subscription windows | Codex retains `rateLimitsByLimitId`; Claude reads its native structured subscription windows when available. |
| Plan-limit events have no valid event scope | Account usage uses the account-scoped provider envelope and is never forced into a conversation event. |
| The composer renders only a context percentage | The resting rail also shows compact token count and expands to exact context and subscription meters. |
| Agent has no manual Compact command | The provider session exposes one capability-gated operation with durable status. |

## Normative principles

1. The provider instance is selected before its model. A model string never
   determines provider identity.
2. The server is authoritative for durable composer preferences. React effects
   do not synchronize independent global and per-thread settings stores.
3. A missing or stale resource fails closed. The viewer may show a cached value
   for the correct target, but it may not show another target's capabilities or
   an unfiltered cross-provider model list.
4. A submission snapshots provider instance, model, effort, access, target, and
   delivery intent before any asynchronous work starts.
5. Capability hiding is presentation. The coordinator repeats every check and
   rejects a stale or malicious client with a stable error.
6. Compact is provider-native. Remux tracks and displays its lifecycle but does
   not summarize context itself.
7. Unknown usage is represented as unavailable, never as zero.
8. Context limits and subscription plan limits are different scopes and are
   never combined into one percentage.
9. Provider-native values remain honest. In particular, Claude's estimated
   dollar cost is not synthesized for Codex, and runtime-epoch totals are not
   mislabeled as lifetime conversation totals.

## Version boundary

This work is a coordinated hard cut to:

- `PROVIDER_RUNTIME_CONTRACT_VERSION = 2`;
- `NATIVE_AGENT_PROTOCOL_VERSION = 4`; and
- `NATIVE_AGENT_SCHEMA_VERSION = 6`.

The hard cut is shared with `agent-canonical-turn-journal-v2.md`. There is one
Version 2 provider/runtime protocol and one Version 6 schema migration, not an
intermediate composer-only format. The journal spec owns ordered turn
structures and event scopes; this spec owns composer preferences, normalized
usage values, Compact commands, and capability semantics.

All Version 2 writers emit strict Version 2 records. Adapter ingress and viewer
resource parsers continue to reject unknown fields and invalid bounds.

The schema migration preserves conversations, turns, executions, transcript
events, and native-session references. Historical Version 1 usage events need
not be promoted into Version 2 usage because their scope is ambiguous: Codex
stored a cumulative total while Claude stored a main-loop turn value. They may
remain readable by the old transcript projection or be ignored by the Version 2
usage projector. The server hydrates a fresh Version 2 context snapshot from the
native provider when the conversation is next opened. No conversation may be
deleted merely to perform this upgrade.

Codex resume keeps `excludeTurns: true` so opening an old conversation does not
replay its complete native transcript. Because App Server does not emit a
restored token-usage notification in that mode, the adapter reads only a
bounded tail of the rollout path returned by `thread/resume`, recovers the most
recent native `token_count`, and emits it with `freshness: 'cached'`. Focusing a
persisted conversation schedules this resume probe without blocking transcript
hydration. A subsequent provider notification is emitted as `live` and becomes
authoritative. Restored usage is anchored to the latest visible Remux turn even
when Codex reports it against a hidden native compaction turn.

## Provider capability contract

Version 2 keeps the existing authentication, session, turn, content,
collaboration, and interaction groups, removes `content.usage`, and adds exact
access, usage, and compaction groups:

```ts
type ProviderCapabilitiesV2 = {
  protocolVersion: 2;
  provider: ProviderKind;
  providerVersion: string;
  adapterVersion: string;
  auth: ProviderAuthKind;
  authentication: ProviderCapabilitiesV1['authentication'];
  session: ProviderCapabilitiesV1['session'];
  turns: ProviderCapabilitiesV1['turns'];
  content: Omit<ProviderCapabilitiesV1['content'], 'usage'>;
  collaboration: ProviderCapabilitiesV1['collaboration'];
  interaction: ProviderCapabilitiesV1['interaction'];
  access: {
    presets: readonly ProviderAccess[];
    defaultPreset: 'workspace-write';
  };
  usage: {
    turn: boolean;
    cumulative: boolean;
    context: 'none' | 'derived' | 'provider';
    plan: 'none' | 'push' | 'read-and-push';
    estimatedCost: boolean;
  };
  compaction: {
    automaticNative: boolean;
    manualNative: boolean;
  };
};
```

`usage.context = 'provider'` means the provider supplies a context measurement
or supported context read. `derived` means the adapter computes the measurement
from provider-supplied token and window values. Neither value permits Remux to
estimate from transcript text.

`compaction.automaticNative` describes provider support, not the policy Remux
selected for a session. `compaction.manualNative` is true only when the
currently pinned provider version has a tested native path. An optional adapter
method and a true manual capability must agree. A session-time discovery
failure may narrow a probe capability from true to false and must increment
`capabilityRevision` before the viewer enables the action.

Initial provider mapping is:

| Capability | Codex app-server | Claude Agent SDK 0.3.258 |
| --- | --- | --- |
| Context | Derived from native last-turn usage and context window | Derived from the latest root request's input/cache counts and native model capacity |
| Plan | Stable read plus push | Read and push; the experimental read is optional enrichment |
| Estimated cost | Unavailable | Available, scoped to the current SDK query epoch |
| Native automatic compaction | Supported and retained | Enabled with the default 300,000-token native policy window |
| Native manual compaction | `thread/compact/start` | Native `/compact` command only when advertised by `supportedCommands()` |
| Remux session policy | `native-auto` | `native-auto` |

The Claude experimental usage pull is never required for readiness, send, or
render. Its failure is diagnostic-only. The `rate_limit_event` push is the
normal plan-usage path.

### Compaction policy

Capability and selected policy are intentionally separate:

```ts
type CompactionPolicy = 'native-auto' | 'manual';
```

The initial policy is provider-specific and deliberate:

- Codex uses `native-auto`. Remux does not override Codex compaction settings,
  thresholds, prompts, models, or execution path. Native local or remote
  compaction remains Codex's decision. Manual Compact, when invoked, still uses
  the native app-server RPC.
- Claude uses `native-auto`. Session query options enable native automatic
  compaction with a default 300,000-token window, honoring the supported native
  environment override and actual model capacity. Precomputed compaction remains
  disabled. Manual Compact still uses Claude Code's native `/compact` command
  and native compact summary path.

This does not make Remux the compactor. It selects a supported native harness
policy and then observes native status. Remux never starts Claude compaction
from a percentage threshold. A future provider setting may expose the Claude
policy, but no composer toggle is part of this pass.

The adapter maps automatic and manual boundaries. The context meter reports
actual model capacity separately from the native compaction policy window;
observing a boundary invalidates the prior request measurement until new usage
arrives. Failed compaction retains that measurement and records its failure.

## Usage contracts

### Conversation usage

Version 2 replaces the ambiguous five-field `UsageDisplay` with an exact,
scope-carrying shape:

```ts
type TokenUsageBreakdown = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
};

type ContextUsageSnapshot = {
  usedTokens: number;
  windowTokens: number;
  autoCompactWindowTokens?: number;
  percent: number; // finite, clamped to 0..100
  measurement: 'provider' | 'derived';
  freshness: 'live' | 'cached';
  observedAt: number;
  turnId: string | null;
};

type CumulativeUsage = {
  tokens: TokenUsageBreakdown;
  scope: 'native-conversation' | 'runtime-epoch';
  epochId: string;
};

type EstimatedCost = {
  usd: number;
  scope: 'runtime-epoch';
  epochId: string;
};

type UsageDisplayV2 = {
  turn: TokenUsageBreakdown | null;
  cumulative: CumulativeUsage | null;
  context: ContextUsageSnapshot | null;
  estimatedCost: EstimatedCost | null;
};
```

Every object has exactly these keys. `null` means unavailable. Zero means the
provider reported zero. Token numbers are finite non-negative integers; costs
are finite non-negative numbers; and `windowTokens` must be positive.

The adapter does not recompute a provider's `totalTokens` because providers may
account for cached and thinking tokens differently. It maps the provider total
when present. `reasoningOutputTokens` includes Claude `thinkingTokens`, which
the SDK documents as already included in output tokens.

`cumulative.scope = 'runtime-epoch'` is intentionally honest. The pinned Claude
SDK resets `modelUsage` and cost when a resumed query process starts and may
reset on `/clear`. The first Version 2 pass does not add independent samples
across epochs and claim they are a provider lifetime total. `epochId` changes
whenever the native cumulative basis resets.

### Account plan usage

Plan limits use a separate account-scoped shape:

```ts
type AccountUsageWindow = {
  id: string;
  label: string;
  kind: 'rolling' | 'weekly' | 'model' | 'extra';
  model: string | null;
  usedPercent: number;
  resetsAt: number | null;
};

type ProviderAccountUsage = {
  availability: 'available' | 'not-applicable' | 'unknown';
  windows: readonly AccountUsageWindow[];
  source: 'provider-push' | 'provider-read';
  freshness: 'live' | 'cached';
  observedAt: number;
};

type ProviderAccountEventEnvelope = {
  contractVersion: 2;
  eventId: string;
  provider: ProviderKind;
  scope: {
    kind: 'account';
    providerInstanceId: ProviderInstanceId;
  };
  native: {
    kind: string;
  };
  observedAt: number;
  event: {
    type: 'account.usage-updated';
    usage: ProviderAccountUsage;
  };
};
```

Only windows with a real, finite utilization are included. Missing subscription
data produces `not-applicable` or `unknown` with an empty window array, not a
set of zero-percent windows. Reset times are provider timestamps normalized to
Unix milliseconds.

`ProviderAccountEventEnvelope` is the account-scoped arm of the shared
`ProviderEventEnvelope`; it has provider-instance identity and deliberately has
no conversation, execution, turn, or native-session identity. A provider
session may forward native account reads and pushes through its event stream.
The coordinator persists those events as provider-instance state, so they do
not become conversation transcript events.

An explicit provider read emits a complete normalized baseline. Native push
events may be sparse. The adapter merges pushes while its native session is
alive, and the journal also merges sparse `provider-push` windows by stable ID
against the durable baseline so a process restart cannot drop an unchanged
window. A later `provider-read` replaces that baseline in full. An event older
than the stored `observedAt` cannot replace it. Raw provider shapes never cross
the adapter boundary.

Reading `agent/providers` while the viewer is foregrounded schedules a
non-blocking account-usage read for each ready provider that implements
`readAccountUsage`. Reads are coalesced per provider instance and throttled to
at most once per minute. An experimental provider read failing records a
diagnostic but does not fail the provider resource, authentication, or a turn.

### Provider mapping rules

Codex maps `thread/tokenUsage/updated` as follows:

- `last` becomes `turn`;
- `total` becomes cumulative usage with `scope = 'native-conversation'`;
- context `usedTokens` uses Codex's native per-turn occupancy,
  `last.totalTokens`, with `last.inputTokens` only as a compatibility fallback
  for older app-server versions that omit the total;
- `modelContextWindow` becomes `windowTokens`; and
- percentage is derived from those two values.

The mapper retains `cacheWriteInputTokens` and `reasoningOutputTokens`. It does
not silently substitute `total` for `last`.

Codex maps `account/rateLimits/read` and
`account/rateLimits/updated` into named normalized windows. Native duration and
limit identifiers determine the label; the adapter does not assume that
`primary` always means five-hour if the duration says otherwise.
`rateLimitsByLimitId` contributes every named model/bucket snapshot as well as
the general `rateLimits` entry. Sparse pushes merge into the last full provider
snapshot before normalization and again at the durable journal boundary.

Claude maps a result as follows:

- the main-loop `usage` contributes the immediate per-turn sample;
- `modelUsage` supplies thinking, cache creation/read, context-window, model,
  cumulative token, and estimated-cost information across the SDK query epoch;
- changes from the prior `modelUsage` sample may enrich the per-turn value, but
  a missing prior baseline remains unknown rather than being treated as zero;
- the current model, rather than the largest context window used by a child,
  determines the root conversation's context window; and
- `getContextUsage({ detail: 'summary' })` may replace the result-derived
  context sample after open/resume, a terminal result, and compaction. The
  `full` form is not used on the hot path.

Claude maps `rate_limit_event` immediately. A foreground provider-resource
read uses the SDK's experimental structured usage control call to obtain the
five-hour, seven-day, OAuth-app, Opus, Sonnet, extra-usage, and server-named
model-scoped windows that are present. Missing or null utilization does not
become zero. The coordinator catches and diagnoses read failure and keeps the
last durable baseline/push snapshot.

### Projection and freshness

`AgentRuntimeResource` gains `usage`, whose `context` member is the latest
context snapshot for that conversation. The projector persists the latest
valid snapshot so a resumed WebView can render `freshness = 'cached'`
immediately. Session attach/resume then requests or awaits a native update and
replaces it with `live`.

Each `ProviderCatalogEntry` gains `accountUsage`. The provider resource follows
the same cached-then-live rule. Signing out changes availability to `unknown`
unless the provider positively reports `not-applicable`; it does not continue
to present a cached percentage as current.

At coordinator startup, the journal marks persisted context and account usage
projections cached without rewriting immutable provider events. A successful
native read or push writes a later live projection. This makes freshness honest
during the interval between process restart and provider reconciliation.

Both additions use the existing runtime/providers reads and invalidations. No
usage-specific viewer subscription or polling loop is added.

Updates are ordered by provider instance, native sequence when available, and
then `observedAt`. An older sample cannot replace a newer one after reconnect.

## Composer usage presentation

The usage presentation adds no standalone toolbar button. Its collapsed
affordance is the existing status rail beneath the composer actions:

- left: provider mark, selected model, and effort;
- right with context: rounded context percent, the word `context`, and compact
  used-token count, for example `47% context / 121.3k tokens`; and
- right before context exists but plan usage is supported: `Usage`.

The rail is disabled only when neither context nor plan usage can exist. It is
a semantic button with `aria-expanded` and a real focus outline. Its hit area
occupies the bottom-bar padding rather than overlapping the composer actions;
coarse-pointer layouts reserve at least 40 pixels in that safe-area band.

Tapping the rail expands a tray in the already-collapsible composer context
strip. The tray contains:

1. Context — exact used and window tokens, rounded percent, a progress meter,
   cached-state copy when applicable, and a native Compact action only when the
   active runtime advertises `compaction.manualNative`.
2. Subscription — every normalized window with its provider/model label,
   percentage, meter, and reset time, followed by live/cached source and update
   time.

Utilization below 75 percent uses the normal accent. Values from 75 through 89
use warning color, and values at or above 90 use critical color. Unknown plan
usage says that usage has not been reported; `not-applicable` says subscription
limits are unavailable. Neither renders invented zero meters.

The tray closes when the rail is tapped again, Escape is pressed, a pointer
lands outside the usage surface, a message is sent, or the selected
conversation/provider changes. It may remain open through a background/active
lifecycle transition; the ordinary authoritative resource reread refreshes
both context and subscription values, including when all background
invalidations were lost.

## Composer configuration model

### Identity

The model selection key is always:

```ts
type ProviderModelSelection = {
  providerInstanceId: ProviderInstanceId;
  model: string;
  effort: string | null;
};
```

The same native model ID may exist in more than one provider instance. All
model lookups start from `agent/models:<providerInstanceId>`. The viewer never
filters a global list after inferring provider from the model ID.

### Durable preferences

The journal stores two preference scopes:

- one explicit model/effort pair per conversation; and
- one sticky explicit model/effort pair per provider instance.

It also stores the last explicitly selected provider instance for initializing
a new conversation when more than one ready instance exists. Selecting a model
or effort writes the complete repaired pair to the relevant conversation and
provider scopes in one transaction. An automatic fallback or a send using a
derived value is not an explicit selection and does not silently overwrite a
preference.

The new schema uses a `composer_preferences` table with a strict scope
(`provider`, `conversation`, or singleton `default-provider`), scope ID,
provider instance ID, model, effort, monotonic revision, and timestamp. It also
adds bounded `usage_snapshots` and `compaction_operations` records. Exact SQL
column layout may vary, but those identities, uniqueness constraints, and
durability semantics are normative.

Message text, attachment thumbnails, and edit buffers may remain viewer-local.
Model and effort are removed from `sessionStorage`; no effect or ref mirrors
server selection back into that store.

### Selection precedence

For an existing conversation, the server resolves one model/effort pair in
this order:

1. explicit preference for this conversation;
2. the most recent dispatched turn's actual model and effort;
3. the sticky explicit preference for this provider instance; and
4. the provider's current default model and repaired preferred effort.

“Dispatched” excludes queued turns: a queued configuration has not yet been
used by the provider. The resolved resource includes the winning origin so the
behavior can be tested and diagnosed.

For a new conversation, provider selection resolves from the current explicit
draft choice, then the last explicit provider instance, then the first ready
provider in stable catalog order. Model and effort resolve from the current
draft choice, provider sticky, and provider default. Draft choice is transient;
the provider sticky survives a WebView recreation.

Access resolves independently:

- a new draft starts at `workspace-write`; its selected access persists with
  that draft's text through switching and WebView reload, including an empty
  draft and access-only changes. Legacy or invalid persisted access falls back
  to `workspace-write`; asynchronous model defaults do not replace saved access;
- all three presets are shown only if the provider advertises them;
- `full-access` requires a deliberate selection for that draft and is never
  sticky across new conversations; and
- an existing conversation may change access only while it is idle and its
  provider advertises native resume plus more than one access preset. The
  journal persists the new access, the coordinator detaches the idle provider
  session, and the next send resumes that same native conversation under the
  new access policy. Active, queued, non-resumable, and unsupported sessions
  keep the control locked.

### Effort repair

The complete pair is normalized against the selected provider-scoped model
catalog before it is returned or persisted:

1. retain the requested effort if the model supports it;
2. otherwise choose the first supported value from `high`, `medium`, `low`,
   `off`; and
3. otherwise choose the model's first advertised effort value; and
4. if the model advertises no efforts, use `null` and omit the effort row.

The viewer preserves advertised effort strings without a fixed enum filter.
Only advertised choices appear; a literal native `off` remains distinct from
`null`. Supported-effort models retain the row even when the current value is
null. Nullable Remux configuration commands transmit null for absence, while
optional create/native-provider parameters are omitted.

This deliberately retains the useful ladder from the previous Agent composer.
An explicitly selected `xhigh`, `max`, or another provider-native value remains
selected when supported; it is not preferred as a fallback unless it is the
model's only advertised choice.

If a stored model disappears after a provider update, the provider default is
selected and effort is repaired for a provider preference or for a conversation
whose native session permits model changes. The server records that repaired
value with a new preference revision, rather than returning an invalid
preference on every read. If an existing native session cannot change model,
its last native model remains visible as a locked legacy value even when it is
no longer offered for new sessions; the resolver must not manufacture an
unusable default-model change. The same rule applies to a locked effort.

### Existing-conversation resource

`AgentRuntimeResource` gains:

```ts
type ComposerConfigurationView = {
  revision: string;
  providerInstanceId: ProviderInstanceId;
  nextTurn: {
    model: string;
    effort: string | null;
    access: ProviderAccess;
    origin:
      | 'conversation-explicit'
      | 'last-used'
      | 'provider-sticky'
      | 'provider-default';
  };
  lastUsed: {
    turnId: string;
    model: string;
    effort: string | null;
  } | null;
  editable: {
    model: boolean;
    effort: boolean;
    access: boolean;
  };
};
```

The runtime resource continues to carry provider identity, execution state,
capabilities, and health. Its prior top-level `model` and `effort` fields are
either removed in the Version 2 hard cut or explicitly documented as the
active native configuration; they may not ambiguously duplicate `nextTurn`.

The providers resource gains the default provider instance and each instance's
normalized sticky preference. This is sufficient to initialize a new draft and
does not add a composer resource subscription.

### Preference command

Explicit existing-conversation changes use an idempotent command:

```ts
type ComposerPreferenceSetCommand = {
  commandId: CommandId;
  conversationId: ConversationId;
  expectedRevision: string;
  model: string;
  effort: string | null;
};
```

The server validates provider ownership, model existence, effort support, and
the two change capabilities; applies effort repair; updates conversation and
provider preferences atomically; and invalidates runtime and providers. A
revision mismatch returns `configuration_conflict` plus no mutation. The viewer
rereads and may reapply an explicit user action once; it does not loop.

New-draft changes update the provider sticky/default-provider preference and
the in-memory draft selection. Conversation creation carries the entire
provider/model/effort/access snapshot, so a tab loss between selecting and
creating cannot produce a partially configured conversation.

New-draft persistence uses a second idempotent command:

```ts
type ProviderComposerPreferenceSetCommand = {
  commandId: CommandId;
  providerInstanceId: ProviderInstanceId;
  expectedProvidersRevision: string;
  model: string;
  effort: string | null;
  makeDefaultProvider: true;
};
```

The method is `remux/agent/composer/provider-preference/set`. The conversation
method is `remux/agent/composer/conversation-preference/set`. Both write a
complete repaired pair rather than independent fields. The provider command
does not persist access.

Existing-conversation access uses a separate idempotent command because an
access change reconfigures the native session rather than merely changing the
next turn's inference preference:

```ts
type ConversationAccessSetCommand = {
  commandId: CommandId;
  conversationId: ConversationId;
  expectedRevision: string;
  access: ProviderAccess;
};
```

The method is `remux/agent/composer/conversation-access/set`. It validates the
advertised preset and current `editable.access` capability, persists the
conversation and root-execution access atomically, and detaches the idle native
session. A send racing the reconfiguration is rejected until detachment
finishes; the next send resumes the existing native session with the selected
access. The command never forks or replaces the conversation.

## Target-switch state machine

Composer resource state is keyed by `{kind, id}` where kind is `draft` or
`conversation`. Every read has a monotonically increasing viewer generation.

On a conversation switch:

1. change the active target immediately;
2. use a cached runtime only if its conversation ID matches that target;
3. otherwise use the conversation summary's provider/model/effort as a
   non-editable placeholder;
4. fetch runtime and its provider-scoped models;
5. ignore responses whose target or generation no longer matches; and
6. unlock controls only after a coherent runtime/capability revision is ready.

The viewer never falls back to all models. Missing capabilities mean every
capability-dependent action is locked. A failed read retains the correctly
scoped cached value when one exists, marks it stale, and offers retry; without
a correct cached value it stays locked.

An explicit preference write is also target-fenced. A late response for
conversation A cannot change conversation B's composer. This replaces
`conversationSettingsTargetRef` and the interacting synchronization effects
with one target-keyed store and one pure resolution path.

## Submission snapshot and delivery

Every new-chat, send, queued send, edit, and fork submission captures:

```ts
type ComposerSubmissionConfiguration = {
  providerInstanceId: ProviderInstanceId;
  model: string;
  effort: string | null;
  access: ProviderAccess;
  configurationRevision: string | null;
};
```

The new-conversation command requires all four selection fields. Existing
conversation commands verify that the provider instance and access match the
conversation. Model and effort are applied according to capability.

While a turn is active, message send includes explicit delivery intent:

```ts
type DeliveryIntent = 'auto' | 'steer' | 'queue';
```

`auto` chooses steer when supported, otherwise queue when supported, otherwise
returns `conversation_busy`. `steer` never changes model or effort and fails if
the submitted next-turn configuration differs from the active turn. `queue`
captures model and effort on the durable queue entry; later preference changes
do not rewrite an already queued turn.

When a queued turn actually dispatches, it becomes the conversation's
`lastUsed` configuration. Merely enqueueing it does not.

Edit-and-regenerate and fork commands require model and effort. The new native
forked conversation inherits provider instance, cwd, and access from the source
conversation, but its first turn uses the submitted model/effort pair and stores
that pair as the new conversation's explicit preference. The coordinator passes
the same pair to `ProviderSession.startTurn`.

## Capability enforcement matrix

| Composer operation | Required capability/state | Coordinator behavior |
| --- | --- | --- |
| Choose access for new chat | Access exists in `access.presets` | Reject unsupported preset before opening a session. |
| Change model on existing chat | `turns.changeModelOnExistingSession` | Reject different model with `capability_unavailable`. |
| Change effort on existing chat | `turns.changeEffortOnExistingSession` | Reject different effort with `capability_unavailable`. |
| Attach image | `content.images` | Reject the picker action in UI and reject image parts on every command. |
| Attach file reference | `content.fileReferences` | Reject mention/file-reference parts when unsupported. |
| Stop | Active turn and `turns.interrupt` | Do not show an operative Stop; reject stale interrupt commands. |
| Send now while running | `turns.steer` | Steering cannot carry a model/effort change. |
| Queue while running | `turns.queue` | Do not silently queue when false. |
| Edit-and-regenerate | `session.forkNative` | Validate source native turn identity and content/configuration. |
| Fork | `session.forkNative` | Validate source native turn identity and content/configuration. |
| Manual Compact | `compaction.manualNative`, a resumable native session, and no queued/running compact; viewer runtime and queue belong to the selected conversation | Dispatch at an idle root boundary or enqueue a durable Compact control entry; never create a normal Agent turn. The supported control remains disabled while ineligible or awaiting submission. |

The viewer and coordinator both enforce this table. Adapter methods perform a
final native-state check and return `capability_unavailable` when the advertised
feature disappeared after a provider upgrade.

## Native Compact contract

### Adapter and viewer command

The provider session gains:

```ts
type CompactProviderSessionInput = {
  commandId: CommandId;
  conversationId: ConversationId;
  executionId: ExecutionId;
};

interface ProviderSessionV2 extends ProviderSessionV1 {
  compact?(input: CompactProviderSessionInput): Promise<{
    accepted: true;
    nativeOperationId?: string;
  }>;
}
```

The viewer invokes:

```text
remux/agent/conversation/compact
```

with `commandId` and `conversationId`. The coordinator derives execution and
native session identity. The response means the provider accepted the
operation, not that compaction completed.

The coordinator response is:

```ts
type CompactConversationResult = {
  accepted: true;
  operationId: string;
  delivery: 'sent' | 'queued';
};
```

Compact participates in the existing durable operation queue as a control
entry, not a message turn:

```ts
type NativeQueueEntry =
  | NativeQueuedMessage
  | {
      kind: 'compact';
      commandId: CommandId;
      operationId: string;
      createdAt: number;
    };
```

Queue removal can cancel a pending Compact before native dispatch. Once
dispatched, cancellation is provider-defined and Version 2 exposes no synthetic
cancel operation.

### Preconditions

Manual Compact is accepted when:

- the conversation and native session exist;
- the provider capability and adapter method are present;
- the native session is resumable rather than permanently lost or closed; and
- no manual or automatic compaction is already queued or running.

If the root command lane is idle and no older queue entry exists, the
coordinator dispatches Compact immediately. If a root turn, foreground tool,
foreground child, recovery, or older FIFO entry occupies that lane, it appends
one durable Compact control entry and returns `delivery = 'queued'`. It sends
the native compact command when all older root-lane work reaches a provider
turn boundary. It does not inject the command into an active model response.

This retains the accepted behavior in the existing Codex extension: Compact
can be requested while a turn is active without interrupting it, and its place
relative to already queued messages is explicit FIFO state.

An unsent ordinary draft may remain in the viewer. It is not injected into the
provider and is restored unchanged after compaction. Edit/fork modes may hide
the action as a presentation safeguard, but draft text is not a server
precondition.

Background or already-detached child executions do not block manual Compact.
This preserves the useful boundary in which a Claude parent has launched
subagents and returned to the prompt while those children continue. If the
root turn is still synchronously waiting for a foreground child, Compact is
accepted into the durable control queue and runs after that root turn reaches
an idle boundary.

Stable rejection codes are `capability_unavailable`, `session_unavailable`,
`operation_in_progress`, and `native_command_unavailable`.

### Work isolation

Root compaction changes only the bound provider conversation's model context.
It must not interrupt, stop, close, or wait for independent work merely to make
the context operation convenient.

The following continue across root compaction:

- provider-native background subagents and workflows;
- provider-native background Bash, PTY, and other task processes;
- background MCP tasks owned by the native harness;
- detached cross-provider federated executions owned by the Remux coordinator;
  and
- their journal identity, progress, stop affordances, and eventual result.

Foreground tools, foreground native children, and foreground federated MCP
calls still occupy the root turn. They delay native dispatch of a queued
Compact until the root boundary, but Compact does not cancel them.

The adapter implementation may call only the provider's native compact path.
It must not implement Compact by invoking interrupt, closing/reopening the
session, killing task processes, or recreating the native conversation. Child
and process identities observed before compaction remain valid afterward.

Native and federated children are different execution mechanisms. Same-provider
Codex collaboration and Claude Task children remain owned by their native
harness. Cross-provider Fable/Sol delegation remains a Remux MCP operation with
its own provider session. Both are projected as child executions, and neither
is made a child of the compaction operation.

Because native compaction may remove the parent's recollection of a federated
execution ID, the Version 2 federation surface includes the bounded,
credential-scoped `remux_list_agents` read defined by
`agent-canonical-turn-journal-v2.md`. It restores handles for owned federated
children only. Compact does not inject their state into model context, and the
list operation does not expose transcripts or native same-provider children.

### Lifecycle

Version 2 replaces the terminal-only `context.compacted` event with:

```ts
type ContextCompactionEvent =
  | {
      type: 'context.compaction.started';
      trigger: 'manual' | 'automatic';
      operationId: string;
      beforeTokens: number | null;
    }
  | {
      type: 'context.compaction.completed';
      trigger: 'manual' | 'automatic';
      operationId: string;
      beforeTokens: number | null;
      afterTokens: number | null;
    }
  | {
      type: 'context.compaction.failed';
      trigger: 'manual' | 'automatic';
      operationId: string;
      error: DisplayError;
    };
```

`AgentRuntimeResource` exposes selected policy plus a strict operation state:

```ts
type CompactResultView = {
  operationId: string;
  trigger: 'manual' | 'automatic';
  disposition: 'dispatched' | 'satisfied-by-native-auto';
  beforeTokens: number | null;
  afterTokens: number | null;
  completedAt: number;
};

type ContextCompactionView =
  | { state: 'idle'; lastResult: CompactResultView | null }
  | {
      state: 'running';
      trigger: 'manual' | 'automatic';
      operationId: string;
      startedAt: number;
    }
  | {
      state: 'failed';
      trigger: 'manual' | 'automatic';
      operationId: string;
      error: DisplayError;
      failedAt: number;
      lastResult: CompactResultView | null;
    };

type RuntimeCompactionView = {
  policy: 'native-auto' | 'manual';
  operation: ContextCompactionView;
};
```

The coordinator records `context.compaction.started` and a durable command
receipt before native dispatch. A duplicate `commandId` returns the original
result. A different command while one is running returns
`operation_in_progress`.

A queued manual Compact also records the conversation's current compaction
generation. If native automatic compaction completes after that request but
before manual dispatch, the coordinator removes the queued entry and completes
it with `disposition = 'satisfied-by-native-auto'`; it does not immediately
compact the freshly compacted context a second time. If the automatic attempt
fails, the queued manual operation remains eligible at the next root boundary.

Success invalidates runtime, removes the Compact control entry if it was
queued, requests a fresh context measurement, and leaves plan usage untouched.
Compact never produces a Remux user message, assistant message, message
follow-up, or model/effort preference change.

If the Agent process loses the provider after dispatch but before a terminal
event, the operation becomes recovering. It reconciles against the native
snapshot or compact boundary. Because not every provider accepts an idempotency
key, the coordinator must not blindly dispatch a second compact. If native
state cannot prove completion, the operation terminates with
`delivery_unknown`; a later user action may start a new operation once the
session is healthy.

### Codex implementation

The Codex adapter calls `thread/compact/start` for the bound thread. It emits
the native request once; the coordinator records the durable started boundary
before dispatch, and the adapter maps `thread/compacted` to completed.
Snapshot/history compaction items may reconcile a missed completion.
The adapter maps native automatic compactions to the same lifecycle with
`trigger = 'automatic'`. It does not set an alternate threshold, disable native
automatic compaction, replace a native remote compact with a local summary, or
select a compaction model.

### Claude implementation

The pinned Claude SDK has compact status and boundary events but no typed
`compact()` method. Claude Code's native command catalog and the pinned T3
integration demonstrate manual `/compact` through the SDK input stream.

The Claude adapter therefore:

1. starts Remux root sessions with `autoCompactEnabled: false` and
   `precomputeCompactionEnabled: false` in the supported SDK settings layer;
2. calls `supportedCommands()` at session readiness and advertises manual
   support only when the exact native compact command is present;
3. submits exactly `/compact` through the native SDK input path with no effort
   prefix, attachment, model change, or user draft content;
4. routes the resulting status, compact boundary, and compact result into the
   compaction operation rather than a normal Agent turn;
5. does not project the adapter-authored `/compact` input as a user-authored
   Agent transcript message; and
6. uses `SDKCompactBoundaryMessage` token metadata and
   `SDKStatusMessage.compact_result`/`compact_error` for terminal state.

If runtime discovery or a pinned-version integration test fails, the adapter
sets manual support false. It does not fall back to asking the model to
summarize, nor does it send `/compact` as an ordinary user turn.

Automatic Claude compact boundaries use the same event mapping and remain
observable even when manual support is false.

## Mobile, reconnect, and concurrent viewers

All preference writes, usage samples, account windows, command receipts, and
compaction operations live in the Agent server journal. Turning off the screen
or destroying the WebView cannot cancel them.

On resume the viewer reads the same existing resources:

- providers for auth, capabilities, sticky choices, and cached plan usage;
- conversation/runtime for the exact target, selection, cached context usage,
  execution health, and compaction state; and
- queue for pending follow-ups.

The viewer fences these responses by coordinator generation, resource revision,
target ID, and capability revision. Cached context/plan values are labeled
cached until native reconciliation. A compact operation still running on the
server remains running after the phone sleeps; the action is not reissued by
the client.

Two viewers use optimistic concurrency on preference revisions. Both receive
resource invalidations after a successful write. A stale writer receives
`configuration_conflict`, rereads, and never overwrites a newer explicit choice
silently.

## Implementation sequence

Passes 0–5 are implemented. Automated acceptance passes across server, unit,
desktop, mobile, lifecycle, and style-boundary suites. Subscription-authenticated
Codex and Claude both pass live composer usage acceptance. The full
Fable-to-Sol orchestration matrix, provider-native Compact matrix, and physical
phone lock/restore cases remain separate acceptance work.

### Pass 0 — freeze the coordinated Version 2 contracts

- land the ordered turn/journal contract and this composer control-plane spec;
- keep one provider-runtime Version 2, native protocol Version 2, and schema
  Version 5 cut; and
- lock provider fixtures for event order, usage, plan limits, and compact
  lifecycle before changing adapter output.

The coordinated Version 2 contract, runtime, and composer implementation have
landed together in the working tree.

### Pass 1 — canonical journal, schema, and compatibility projection

Implement Pass 1 of `agent-canonical-turn-journal-v2.md` first:

- add strict scope-aware event, ordered pass/block, conversation-control, and
  Version 2 resource contracts;
- migrate the journal to Version 5 without deleting conversations;
- add preference, usage-snapshot, account-usage, and compaction-operation state
  in the same migration;
- materialize ordered blocks and explicit legacy ordering; and
- retain a compatibility projection so the current virtualized viewer remains
  usable before the later transcript presentation pass.

Exit: the storage and public-resource shape is stable before either native
adapter begins emitting Version 2 events.

### Pass 2 — native adapters, usage, and recovery projection

- map Codex native ordered items and snapshots plus
  last/total/context/rate-limit/compact data;
- map Claude content-block starts/deltas/stops and snapshots, removing the late
  tool-start defect;
- map Claude model usage, context, cost, rate-limit, and compact data;
- configure the Claude root-session native-auto policy and probe native
  `/compact` support;
- extend capability probes;
- project context on runtime and plan usage on providers, including cached and
  resumed states; and
- add bounded federated-child rediscovery.

This pass stabilizes the resource contract before the composer presentation;
it does not redesign transcript pixels.

### Pass 3 — composer correctness

- replace global/effect-driven model and effort synchronization with the
  target-keyed state machine;
- make provider instance and access first-class selections;
- add server preference commands and the precedence resolver;
- retain effort repair;
- apply the complete capability matrix in viewer and coordinator;
- add delivery intent; and
- carry model and effort through edit/fork.

This pass may use existing composer controls. It does not redesign their visual
layout.

### Pass 4 — composer Compact control

- add the idempotent viewer command and runtime lifecycle;
- add Compact as a non-message durable queue entry and dispatch it at a native
  root boundary;
- expose Compact only when runtime capability and state allow it;
- validate Codex RPC and Claude native-command paths; and
- preserve the unsent draft and background work, and reconcile after mobile
  suspend.

### Pass 5 — composer usage presentation

- render provider/model/effort plus context percentage and compact token count
  in the resting status rail;
- expand the rail into exact context and account-plan meters in the existing
  context strip;
- put native Compact beside the context remedy;
- provide threshold colors, honest unavailable states, reset times, and
  live/cached provenance;
- close on toggle, outside pointer, Escape, send, and target change; and
- reserve a non-overlapping safe-area touch target and refresh the open tray
  after suspend/resume.

### Pass 6 — live cutover and mobile acceptance

- run fixture, restart, duplicate-event, queue, and capability suites before
  live provider turns;
- validate real subscription-authenticated Codex and Claude sessions;
- dogfood a Fable parent with native Claude children and a federated Sol writer;
- compact at idle and while foreground/background work exists, then rediscover
  and follow up with the federated child; and
- lock and restore a physical phone during streaming and Compact before calling
  the Version 2 path complete.

## Validation plan

### Contract and parser tests

- Version 1 capabilities or five-key usage records fail Version 2 adapter
  ingress; Version 2 exact records pass.
- Negative, fractional token counts, invalid percentages, invalid windows,
  non-finite costs, and extra keys fail at their precise paths.
- Account events require provider instance identity and cannot carry
  conversation identity.
- A true manual-compaction capability without an adapter method fails adapter
  registration.

### Adapter fixtures

- A Codex token update retains `last`, `total`, cache writes, reasoning output,
  and context window and computes context from `last`, not cumulative total.
- Codex rate-limit read plus sparse pushes produce complete named windows and
  never invent zero utilization.
- Codex `rateLimitsByLimitId` retains model-scoped five-hour and weekly windows.
- Codex manual and automatic compactions produce one lifecycle each despite
  duplicate native notifications.
- Codex session options do not override native automatic or remote compaction
  configuration.
- A Claude result maps immediate turn usage, cumulative `modelUsage`, thinking,
  context window, and epoch-scoped cost.
- A Claude resume changes the cumulative epoch instead of pretending the new
  zero-based total is a decrease in lifetime usage.
- Claude `rate_limit_event` updates provider account usage without a
  conversation event.
- Failure of Claude's experimental usage read does not fail probe, open,
  resume, send, or the last push snapshot.
- Claude's structured usage read maps ISO reset timestamps, closes its control
  query, and distinguishes unavailable utilization from a reported zero.
- Empty Claude text/thinking block starts are not persisted; the first
  non-empty delta opens the strict turn block without killing the native stream.
- Claude manual Compact sends exactly one native `/compact`, applies no effort
  prefix, produces no ordinary Agent turn, and terminates from compact status
  or boundary events.
- Claude Remux root-session options enable automatic compaction with the default
  300k native policy window and disable precomputed compaction, while retaining
  the native manual command. A live threshold-crossing run remains pending.
- Automatic Claude boundaries are projected accurately; root context counts
  exclude child requests and cumulative result totals.
- Missing `/compact` in `supportedCommands()` narrows the runtime capability
  and returns `native_command_unavailable` to a racing stale client.

### Coordinator and journal tests

- Provider, conversation, last-used, and default precedence are each selected
  in isolation.
- A queued turn does not become `lastUsed` until dispatch.
- Model removal repairs model and effort deterministically and revisions the
  stored preference.
- `full-access` never becomes a new-chat sticky default.
- Retrying a preference, send, branch, interrupt, or compact command ID is
  idempotent.
- The coordinator rejects every capability-matrix command when its capability
  is false, even if invoked without the viewer.
- Edit and fork persist and dispatch the submitted model and effort.
- Compact requested during an active turn, foreground child, recovery, or
  non-empty queue is recorded once and dispatches in FIFO order at a root
  boundary.
- Background native children, federated children, Bash/PTY tasks, and MCP tasks
  neither block an otherwise idle Compact nor get interrupted by it.
- A pending Compact can be removed before dispatch; a running Compact cannot be
  synthetically cancelled.
- A second Compact is rejected while one is queued or running.
- A native automatic compaction that completes ahead of a queued manual Compact
  satisfies that queued operation without a redundant second compaction.
- Ambiguous compact delivery is reconciled or ends `delivery_unknown`; it is
  never blindly dispatched twice.
- Schema migration retains conversations and native-session references while
  treating ambiguous Version 1 usage as unavailable.
- Provider reads replace the durable account baseline, sparse pushes merge by
  stable window ID, stale pushes cannot win, and process restart downgrades the
  projection to cached until reconciliation.

### Viewer state tests

- Rapid A-to-B-to-A switching never shows B models or capabilities on A, even
  when reads resolve out of order.
- A runtime miss or failure leaves controls locked and never exposes the global
  model list.
- Provider selection survives through explicit provider preference; per-thread
  selection survives WebView recreation through the server resource.
- Changing models retains a supported effort or applies the exact repair
  ladder.
- New-chat submission always includes access; an idle resumable conversation
  changes access only when the provider capability and preset allow it.
- Attachment, Stop, queue, edit, fork, model, effort, and Compact affordances
  follow the capability/state matrix.
- A preference conflict rereads authoritative state and cannot stamp one
  conversation's choice onto another.
- The collapsed rail includes context percentage and compact token count; its
  expanded tray exposes exact context, plan windows, reset times, and native
  Compact on desktop and mobile.
- The mobile rail is tappable without intercepting composer actions, and an
  open tray refreshes after suspend/resume even when background invalidations
  were dropped.

### Live subscription acceptance

Run against the installed subscription-authenticated Codex and Claude runtimes:

1. create one conversation per provider with an explicit provider, model,
   effort, and access preset;
2. complete two real turns and verify context changes without cross-provider
   model leakage;
3. verify five-hour/weekly plan data when the account supplies it and honest
   unavailable state when it does not;
4. perform native Compact on both providers when advertised, verify context
   falls, the draft survives, and no ordinary Agent turn is created;
   verify the Codex runtime reports `native-auto` and the Claude runtime reports
   `manual`;
   repeat with a background native child, background process, and detached
   federated child and verify all retain identity and continue; after Compact,
   use `remux_list_agents` to recover the federated handle and successfully
   wait or send a follow-up;
5. request Compact during a foreground turn and verify it queues once, does not
   interrupt the turn, and dispatches at the next root boundary;
6. edit and fork using a non-default supported model/effort and verify the
   provider receives those exact values;
7. queue a follow-up, change the next-turn preference, and prove the queued
   entry retains its captured configuration;
8. lock the phone during a turn and during Compact, then return and verify one
   operation, fresh runtime state, and no duplicate send; and
9. open two viewers, change a preference in one, and verify revision-safe
   convergence in the other.

Live validation must record provider version, adapter version, capability
revision, native operation IDs, resource revisions, and command receipts. It
must not record credentials, hidden reasoning, or raw provider context.

### Validation record — 2026-09-02

- Automated: 92 server tests, 37 unit/boundary tests, and 94 desktop/mobile
  browser tests passed; two viewport-inapplicable cases skipped. The browser
  matrix includes a dropped-invalidation suspend/resume usage refresh and
  non-overlapping mobile rail interaction.
- Codex: App Server `0.144.0`, adapter
  `remux-codex-app-server-v1`, capability revision
  `91c9de5b5967ccf278069d7d987e86acd0b120b1e7ced08506c5b1427bca166f`.
  Existing-conversation live acceptance rendered `121,266 / 258,400` context,
  general weekly usage, and both named GPT-5.3-Codex-Spark windows on desktop
  and mobile.
- Claude: Claude Code `2.1.258`, adapter
  `remux-claude-agent-sdk-v1`, capability revision
  `bfd0d806eda1096c0ca59d19d5db0840eacf639b574dfdda9ebccb6c4a27d926`.
  A real subscription-authenticated turn completed and projected
  `27,435 / 1,000,000` context. Live desktop/mobile acceptance rendered the
  five-hour, weekly, and Fable-scoped plan windows.
- The first Claude live canary exposed and now covers a strict-ingress defect:
  Claude's empty `content_block_start` was being persisted as an invalid empty
  text block. The adapter now waits for the first non-empty delta. The separate
  stream-message identity/fragment ordering cleanup remains owned by
  `agent-canonical-turn-journal-v2.md`; it is not part of this composer pass.
- Physical iOS/Android lock-screen acceptance is still pending. Browser-host
  lifecycle simulation is passing but is not represented as physical-device
  evidence.

## Exit criteria

This composer control-plane pass is complete when:

- no model or effort preference is read from or written to `sessionStorage`;
- no provider is inferred from a model ID;
- conversation switching cannot fail open;
- access is explicit on every new-conversation command;
- the coordinator enforces the full composer capability matrix;
- edit and fork deliver the selected model and effort;
- runtime context and provider plan usage recover after a WebView recreation;
- Codex retains native automatic/remote compaction while Claude root sessions
  default to native manual compaction;
- Compact can wait for a root boundary without blocking or cancelling native
  background work or federated children;
- Compact is native, idempotent at the Remux boundary, recoverable, and does
  not appear as a normal Agent turn; and
- fixture, restart, out-of-order, and live subscription acceptance pass for
  both provider adapters.
