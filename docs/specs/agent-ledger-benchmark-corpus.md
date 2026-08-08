Status: R&D evidence
Last verified: 2026-08-07
Canonical code: historical repositories and local transcripts listed below; this document does not authorize runtime or benchmark implementation

# Ledger workflow transcript and benchmark corpus

This companion records the local evidence behind
[`agent-turns-and-work-units.md`](agent-turns-and-work-units.md) and preserves a
reproducible starting point for a later Agent-versus-Codex benchmark. It maps
Ledger and Remux commits to retained Codex and Claude transcripts, identifies
high-value replay fixtures, documents parsing hazards, and defines an initial
experiment protocol.

It deliberately separates evidence quality:

- **Proven:** the transcript contains the exact commit command or the commit
  embeds a matching session trailer and the transcript contains the work.
- **Strong:** timestamps, base revision, changed paths, prompt, tests, and
  resulting diff align, but an exact commit command/trailer is absent.
- **Probable:** topic and time align but concurrent work prevents exact
  attribution.

Commit timestamps alone are never sufficient when Codex, Claude, worktrees,
and direct shell work were active concurrently.

## Repository scope

Ledger is a sibling repository, not a directory tracked by Remux:

```text
/home/ubuntu/ledger   Ledger engine, Remux extension server, and Lens viewer
/home/ubuntu/remux    Remux runtime, viewer infrastructure, and Agent work
```

The Ledger extension-era mainline studied here is the linear range
`c707732..2b2f95a`, from 2026-07-04 through 2026-07-22. Relevant Remux commits
are included where a task crossed both repositories or changed platform
behavior used by Ledger.

## Evidence locations

### Codex/App Server

```text
/home/ubuntu/.codex/state_5.sqlite
  table: threads
  purpose: thread/session locator and metadata index

/home/ubuntu/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  purpose: authoritative detailed rollouts

/home/ubuntu/.codex/history.jsonl
  purpose: sparse prompt history; insufficient for this benchmark
```

Detailed rollouts contain session metadata, cwd and starting git revision,
turn IDs, user/assistant items, exact tool calls and output, world state,
compaction replacement histories, and terminal task events.

No useful Pi session history was retained under `/home/ubuntu/.pi`; only
authentication/model data was present.

### Claude

The primary retained Ledger session is:

```text
local session id
  02841f49-af55-4218-916c-685dc15c4ac1

bridge/session trailer id
  cse_01LdaHMgS6e2QLbe4sxTj9qr

main transcript
  /home/ubuntu/.claude/projects/-home-ubuntu/
    02841f49-af55-4218-916c-685dc15c4ac1.jsonl

subagent transcripts
  /home/ubuntu/.claude/projects/-home-ubuntu/
    02841f49-af55-4218-916c-685dc15c4ac1/subagents/

file-history backups
  /home/ubuntu/.claude/file-history/
    02841f49-af55-4218-916c-685dc15c4ac1/

scratchpad briefs, reports, test output, screenshots
  /tmp/claude-1000/-home-ubuntu/
    02841f49-af55-4218-916c-685dc15c4ac1/scratchpad/

partial background-job timeline
  /home/ubuntu/.claude/jobs/02841f49/timeline.jsonl
```

The main file is approximately 18.7 MB and covers 2026-07-05 through
2026-07-09. Its title is “Integrate Ledger trading engine into Remux.” It
contains work rooted at `/home/ubuntu`, `/home/ubuntu/ledger`,
`/home/ubuntu/ledger/lens`, and `/home/ubuntu/remux`.

The predecessor session was forked but its raw JSONL is missing:

```text
session id
  8e61883f-8d8b-4bf8-a9c9-45c04aa4de58

expected missing JSONL
  /home/ubuntu/.claude/projects/-home-ubuntu/
    8e61883f-8d8b-4bf8-a9c9-45c04aa4de58.jsonl

retained prompt-only history
  /home/ubuntu/.claude/history.jsonl
```

The fork is supported by the Claude daemon roster backup and later memory.
The prompt-only predecessor is useful for reconstructing owner intent but not
for exact inference/tool replay.

## Codex session catalog

The following retained rollouts are most relevant. Session IDs are embedded
in their filenames.

| Label | Session ID | Start/cwd | Role |
| --- | --- | --- | --- |
| Cx1 | `019f2e53-160a-7c73-930f-d6fec14a1da7` | 2026-07-04, `/home/ubuntu` | Initial extension/Lens onboarding, config corrections, direct-main workflow |
| Cx2 | `019f330d-0302-7753-9b4e-d8f713221292` | 2026-07-05, `/home/ubuntu` | ES data-management implementation and UI polish |
| Cx3 | `019f3812-c0bd-78a2-a77b-c7160d84018f` | 2026-07-06, `/home/ubuntu` | Feed management hardening |
| Cx4 | `019f486f-b24c-7d93-9603-b309c81ae9cf` | 2026-07-09, `/home/ubuntu` | Replay/chart diagnosis, atomic-delivery spec and monster implementation |
| Cx5 | `019f4c51-e68f-7b52-bda8-4053aad71410` | 2026-07-10 | Cross-repository semantic RPC and immutable viewer work |
| Cx6 | `019f8028-afc1-75c0-bdea-27641cca9d29` | 2026-07-20 | Resumed history, projection graph, zero-origin rebuild, tick bars |

Exact rollout paths:

```text
/home/ubuntu/.codex/sessions/2026/07/04/
  rollout-2026-07-04T18-10-24-019f2e53-160a-7c73-930f-d6fec14a1da7.jsonl

/home/ubuntu/.codex/sessions/2026/07/05/
  rollout-2026-07-05T16-11-58-019f330d-0302-7753-9b4e-d8f713221292.jsonl

/home/ubuntu/.codex/sessions/2026/07/06/
  rollout-2026-07-06T15-36-20-019f3812-c0bd-78a2-a77b-c7160d84018f.jsonl

/home/ubuntu/.codex/sessions/2026/07/09/
  rollout-2026-07-09T19-51-47-019f486f-b24c-7d93-9603-b309c81ae9cf.jsonl

/home/ubuntu/.codex/sessions/2026/07/10/
  rollout-2026-07-10T13-57-43-019f4c51-e68f-7b52-bda8-4053aad71410.jsonl

/home/ubuntu/.codex/sessions/2026/07/20/
  rollout-2026-07-20T15-32-57-019f8028-afc1-75c0-bdea-27641cca9d29.jsonl
```

### Isolated Codex worktree sessions

These are the cleanest spec-to-implementation fixtures because each records
an isolated cwd, exact base, named spec, instructions, and validation.

| Session | Cwd/base | Main turn | Calls | Result |
| --- | --- | --- | ---: | --- |
| `019f3d5b-6ccf-7010-9f9f-3af945998960` | `/tmp/codex-wt-feed-system`, `d92c602` | `019f3d5b-6d05-72b3-82ce-52472ada36e5` | 98 | Feed/session work in `9f56c93` |
| same | same | `019f3d7c-8d59-7b93-aff2-8e6cda1dc62d` | 7 | FIFO regression correction and test |
| `019f3f75-6062-7b22-a7d4-288dadb9ce48` | `/tmp/codex-wt-projection`, `9f56c93` | `019f3f75-6098-7cb1-9f15-0c873f46c638` | 73 | Projection/time-bar work in `b8512c9` |
| `019f3fb4-e7e1-77a0-b49a-b1cb7b6dbc73` | `/tmp/codex-wt-transport`, `b8512c9` | `019f3fb4-e818-7ab3-a0e8-631f82cd18c3` | 106 | Session transport in `85c98dc` |
| `019f437c-2382-7f20-9b06-ec84f0cbb397` | `/tmp/codex-wt-replay-cleanup`, `85c98dc` | `019f437c-23b9-79d2-8411-c9a2e52629b0` | 104 | Replay cleanup incorporated into `134d778` |
| same | same | `019f438d-502c-7de0-b1bc-548fe365264b` | 8 | Missing Remux interleaving test |

Exact paths:

```text
/home/ubuntu/.codex/sessions/2026/07/07/
  rollout-2026-07-07T16-13-49-019f3d5b-6ccf-7010-9f9f-3af945998960.jsonl

/home/ubuntu/.codex/sessions/2026/07/08/
  rollout-2026-07-08T02-01-24-019f3f75-6062-7b22-a7d4-288dadb9ce48.jsonl
  rollout-2026-07-08T03-10-48-019f3fb4-e7e1-77a0-b49a-b1cb7b6dbc73.jsonl
  rollout-2026-07-08T20-47-16-019f437c-2382-7f20-9b06-ec84f0cbb397.jsonl
```

Call counts in this document count recorded function/custom tool-call items
inside the identified task boundary. They are useful for relative task shape,
not a provider-independent measure of effort.

## Ledger mainline commit map

| Commit | UTC | Change | Best transcript association |
| --- | --- | --- | --- |
| `c707732` | Jul 04 21:14 | Ledger Remux extension and Lens onboarding | Cx1, proven by commit flow |
| `2e04c70` | Jul 04 21:16 | Direct-main agent workflow docs | Cx1, proven |
| `b198f0b` | Jul 05 18:57 | ES data-management layer | Cx2/predecessor boundary, strong |
| `8595210` | Jul 06 01:55 | Lens days-view refinement | Cx2/Claude UI iteration, strong |
| `70a24c4` | Jul 06 02:25 | Day-list polish | Cx2/Claude UI iteration, strong |
| `92963c3` | Jul 06 15:36 | Feed data-management updates | Cx3/Claude workflow, strong |
| `d0f2dbc` | Jul 07 15:42 | Job/dead-code/CLI/fetch cleanup | Claude `cse_01Lda...`, proven |
| `73d8ce1` | Jul 07 15:42 | Remux manifest build/watch phases | Claude `cse_01Lda...`, proven |
| `d92c602` | Jul 07 15:53 | Per-cell cache watches | Claude `cse_01Lda...`, proven |
| `9f56c93` | Jul 08 00:23 | Ledger session and ES replay feed | Claude coordinator + isolated Codex, proven |
| `b8512c9` | Jul 08 02:43 | Projection system with time bars | Claude coordinator + isolated Codex/reviewer, proven |
| `85c98dc` | Jul 08 12:32 | Remux session transport and push streams | Claude coordinator + isolated Codex/reviewer, proven |
| `134d778` | Jul 09 00:36 | Lens replay and bounded pipeline | Claude agents + Codex cleanup + live refinement, proven |
| `a8e030a` | Jul 10 14:28 | Replay chart and reload-safe resume | Cx4, proven |
| `98fcd7c` | Jul 10 14:33 | Atomic snapshot/delivery spec | Cx4, proven |
| `7b2bd25` | Jul 10 17:07 | Atomic projection delivery implementation | Cx4, proven |
| `c0fcc22` | Jul 10 22:25 | Viewport persistence/chart simplification | Cx4, proven |
| `d9e68a5` | Jul 11 21:53 | Semantic viewer RPC migration | Cx5, proven alongside Remux change |
| `531997e` | Jul 12 04:46 | Immutable viewer bundle | Cx5, proven alongside Remux change |
| `9ff865b` | Jul 21 13:04 | Projection graph/delivery recovery | Cx6, proven |
| `4070c0c` | Jul 22 00:03 | Zero-origin projection rebuild | Cx6, proven |
| `2b2f95a` | Jul 22 04:22 | Tick-bar projections | Cx6, proven |

Full commit hashes should be resolved from the local repository when fixture
manifests are generated. Short hashes are stable identifiers for discussion,
not sufficient fixture provenance.

### Superseded but useful history

Ledger reflog contains spec/review work that did not remain on main:

| Commit | Meaning |
| --- | --- |
| `13712dd` | Removed an unnecessary HTTP API because Lens used Remux IPC and agents used CLI |
| `d57568d` | Revised the feed spec around a Ledger-owned session clock |
| `6de96d6` | Reviewer-driven removal of invented feed infrastructure in favor of `RuntimeProcess` |
| `ee79809` | Fixed worker join and step-barrier mistakes identified by review |
| `8d5e965` | Coherent rewritten feed specification after reset |

This chain is valuable for evaluating whether a harness preserves rejected
architecture as history without allowing it to pollute the current design.
Fixture preparation must copy any required unreachable commit content before
repository cleanup or garbage collection.

## Relevant Remux integration commits

| Commit | Change | Association |
| --- | --- | --- |
| `973dd18` | External extension roots/config enabling Ledger | Paired with Ledger `c707732`, Cx1 |
| `2076614` | Direct-main workflow instructions | Paired with Ledger `2e04c70`, Cx1 |
| `03afe4a` | Viewer build/watch spec including Ledger | Claude session trailer, proven |
| `f81e8dc` | Managed viewer build/watch implementation | Same Claude session, proven |
| `bbb9f58` | Cross-extension RPC concurrency fixture | Ledger integration evidence |
| `f2b7fc7` | Equal extension resource governance | Cx5 |
| `6dec7cf` | Managed-scope fixes and linked Ledger typecheck | Paired with Ledger `d9e68a5`, Cx5 |
| `e23824b` | Immutable viewer bundle registry | Paired with Ledger `531997e`, Cx5 |

The paired commits make cross-repository state part of the benchmark. A replay
that exposes only Ledger cannot fairly evaluate the original task.

## High-value Codex episodes

### Atomic delivery: forced mid-turn rollover

Session:

```text
019f486f-b24c-7d93-9603-b309c81ae9cf
```

Important turns:

| Turn | Meaning |
| --- | --- |
| `019f486f-b27f-7fa2-8c76-1f6bd4c196cb` | User supplies a Phase 2.5 hypothesis/summary and asks for grounded review; model inspects both repos and finds real hydration/routing issues |
| `019f4c6d-3c6c-7361-8357-4bb571dadb2e` | Audit/test/commit `a8e030a`, author and review a 1,627-line alignment spec, commit `98fcd7c` |
| `019f4c80-7a2a-7a42-a12f-4f4a9d24e7ac` | 67-minute, 328-call atomic-delivery implementation later committed as `7b2bd25` |
| `019f4cff-333a-7731-8cbe-b308f5ba51fb` | Live acceptance/follow-up and commit/push of `7b2bd25` |

The large implementation compacted at approximately line 2393 of the original
rollout after 176 tool-call items and continued for another 152. Its natural
semantic phases were repository/spec grounding, cache capabilities, runtime
delivery, seek barrier, Lens protocol, Remux routing, profiling, audit, race
corrections, and final validation.

This is the strongest fixture for comparing:

- App Server's monolithic turn;
- deterministic epoch rollover without work units; and
- semantic work-unit decomposition plus epoch safety.

### Projection redesign: steering supersedes architecture

The resumed Cx6 rollout contains imported Cx4 history and later work. Important
turns include:

| Turn | Meaning |
| --- | --- |
| `019f867f-9209-7dd3-952f-e6734c23c13b` | Owner rejects an overengineered dynamic lifecycle and reframes projection replacement as seek/reconciliation; model revises with zero tools |
| `019f86a9-196a-7df3-a4c2-91853ac9f814` | Revised zero-origin spec; 40 calls with a compaction early in the turn |
| `019f86c9-2b03-7740-b696-97a30fda7a3c` | Zero-origin implementation; 203 calls, with 127 after compaction; lands as `4070c0c` |

This sequence tests whether the harness retains the latest accepted
architecture and negative constraints rather than blending them with the
superseded proposal.

### Clean spec-to-implementation fixtures

#### Feed/session

- Prepared base: `d92c602`.
- Authoritative input: `docs/ledger_feed_system_implementation_spec.md` at
  that base/fixture revision.
- Main turn: `019f3d5b-6d05-72b3-82ce-52472ada36e5`.
- Correction turn: `019f3d7c-8d59-7b93-aff2-8e6cda1dc62d`.
- Target behavior: `9f56c93` plus the FIFO regression invariant/test.
- Useful score: spec adherence, deterministic session/feed behavior, full
  workspace tests, and response to precise corrective steering.

#### Projection/time bars

- Prepared base: `9f56c93`.
- Authoritative input:
  `docs/ledger_projection_system_implementation_spec.md`.
- Main turn: `019f3f75-6098-7cb1-9f15-0c873f46c638`.
- Target behavior: `b8512c9`.
- The original worker read the full spec before source inspection and reported
  a passing 190-test workspace run.
- Useful score: dependency scheduling, deterministic seek rebuild, ownership,
  tests, and scope discipline.

#### Remux session transport

- Prepared base: `b8512c9`.
- Authoritative input: the session transport implementation spec at that base.
- Main turn: `019f3fb4-e818-7ab3-a0e8-631f82cd18c3`.
- Target behavior: `85c98dc`.
- Useful score: RPC semantics, watcher-backed streams, accepted deviations,
  cross-layer tests, and independent review findings.

#### Replay cleanup/interleaving

- Prepared base: `85c98dc`.
- Main turn: `019f437c-23b9-79d2-8411-c9a2e52629b0`.
- Correction turn: `019f438d-502c-7de0-b1bc-548fe365264b`.
- Original instructions explicitly excluded Lens and preserved a pre-existing
  diff.
- Useful score: scope preservation, bounded replay pipeline behavior, and the
  owner-requested Remux-level interleaving test.

## Claude workflow findings

The main Ledger Claude transcript contains, after filtering transcript
mechanics, roughly 87 human prompt records, 16 manual compactions, 426 Bash
calls, 266 Read calls, 267 Edit calls, 61 Write calls, seven Agent launches,
and three follow-ups to existing agents.

The workflow repeatedly follows:

```text
open exploration
-> inspect current implementation
-> brainstorm architecture or UX
-> reject/narrow alternatives
-> request/finalize a spec
-> explicitly authorize implementation
-> experience the result
-> make corrective passes
-> separately authorize commit/push
```

### Backend delegation pattern

Claude commonly:

1. brainstormed and finalized a repository spec;
2. created a narrow scratchpad brief;
3. created a temporary Codex worktree;
4. ran `codex exec` against the brief;
5. reviewed the resulting diff itself;
6. ran tests independently;
7. sometimes launched an adversarial Claude reviewer;
8. sent a focused fix to the existing Codex thread;
9. copied the verified patch into main; and
10. waited for explicit commit permission.

Retained briefs include:

```text
codex-feed-brief.md
codex-projection-brief.md
codex-transport-brief.md
codex-replay-cleanup-brief.md
```

This is direct evidence for parent coordination plus bounded child work. It is
also evidence that the parent must receive a compact verified handoff rather
than every child token and tool notification.

### Frontend delegation pattern

Retained persistent agent IDs include:

| Agent ID | Role |
| --- | --- |
| `a13a544ec3cb875f9` | Lens replay Phase 1 |
| `a5319102f5fb36244` | Replay ActionBar cleanup and follow-up |
| `a1107ac671e7a0e7c` | Chart implementation and several revision rounds |
| `a465cc5d1dfb987b8` | TradingView mobile UX research |

The same agent identity may yield, notify, receive `SendMessage`, resume, and
notify again. A benchmark importer must not model a delegated task as exactly
one spawn followed by one terminal result.

### Manual compaction evidence

The 16 generated compact summaries total approximately 346,305 characters,
averaging about 21,644 characters. They preserve commits, dirty files, code
snippets, accepted deviations, test commands/results, constraints, known bugs,
subagent identities, and pending work.

They function as hand-written epoch bootstraps, but they repeat broad state and
depend on model judgment. The on-disk transcript remains more lossless than
the actual live continuation after `/compact`, so benchmark extraction must
distinguish durable history from provider-visible post-compaction context.

### Short prompts, large effective turns

Several short owner prompts opened large tool loops. Examples from the Claude
logs include requests to remove fetching/modals, agreement with four cleanup
items, “spec then implement,” and simple “yes, proceed” authorizations that led
to dozens of reads/edits/commands. Recorded provider input footprints reached
hundreds of thousands of tokens in some turns.

These figures are provider usage observations, not unique-context size: cached
prefixes and repeated inference inputs are counted repeatedly. They still show
that tool-loop growth, rather than user-message length, is the pressure source.

## What context affected outcomes

### High-value user context

- Accepted proposal to which a short authorization refers.
- Rejected alternatives and explicit simplifications.
- Why a reference should or should not be copied.
- Current work mode: brainstorm, diagnose, specify, implement, validate,
  commit, or push.
- Physical/live observations such as layout feel, black chart output, reload,
  safe-area, routing, or process behavior.
- Episodic permissions, especially the rule against unprompted commits.

### High-value repository/runtime context

- Current `AGENTS.md`/repository instructions.
- Exact spec revision and accepted status.
- Starting/base commit and current head.
- Dirty-tree paths and ownership.
- Real source and tests in both Ledger and Remux.
- Stashes, resets, worktree state, and unexpected concurrent changes.
- Test output, local data/artifact shape, and process/server state.

### Context that should usually remain local

- Superseded compiler/test failures after a later pass.
- Large successful command output.
- Repeated source reads already represented by the current file revision.
- Child scratch reasoning and every child tool notification.
- Abandoned UX experiments unless the rejection itself is promoted.
- Imported duplicate transcript history.

## Transcript parsing rules

### Codex rollouts

Use `task_started`/`task_complete` and the stable turn ID to group a logical
turn. Tool calls, results, messages, compaction events, and inference usage
belong to that causal task boundary.

Resumed/forked rollouts can embed earlier history. Cx6 contains:

- two `session_meta` rows;
- copied old turn IDs;
- earlier compaction windows;
- imported events whose JSONL timestamps reflect import rather than original
  chronology; and
- a `thread_rolled_back` event.

Deduplicate by turn ID, prefer the original rollout, and use original
`task_started.started_at` where available. Never sum an imported copy as new
work.

Token usage requires an explicit definition. Recommended exported metrics are:

- maximum logical input reported for one inference;
- cumulative provider input including cache reads;
- cache-read/input share when exposed;
- output tokens;
- number of inferences; and
- estimated unique model-visible artifact/observation bytes.

Do not describe cumulative input as unique context.

### Claude JSONL

Naively treating every `role=user` record as a human turn is incorrect. User
role also carries:

- tool results;
- `/compact` caveat, command, and output wrappers;
- `isCompactSummary: true` synthetic summaries;
- asynchronous `<task-notification>` messages;
- background command completions; and
- subagent completion payloads.

At minimum, human-root extraction should:

1. select user-type records with string message content;
2. exclude `isCompactSummary`;
3. exclude local-command/task XML and slash-command output;
4. follow `parentUuid` to attach assistant/tool descendants to the genuine
   human root; and
5. retain `queue-operation` events as steering/delivery metadata rather than
   human turns.

`promptId` helps but is not sufficient. Duplicate/corrected user records may
occur seconds apart. They should be modeled as correction/steering lineage
when causally linked, not automatically as independent clean tasks. File order
can also be nonchronological around inserted compaction summaries; timestamps
plus parent relationships are safer than line order alone.

Async notification semantics are part of the benchmark. A completion can be
queued while the parent is still working, and one resumable child can notify
multiple times.

## Benchmark fixture preparation

### Do not expose the answer

A raw git worktree at an old commit is not a clean benchmark environment if
later target commits remain reachable through refs, reflogs, remotes, or the
object database. The model could inspect the historical solution.

For each fixture, produce a sanitized repository image that contains:

- the exact tree and history reachable at the prepared base;
- required submodules or sibling repository base trees;
- the authoritative input specs present at that boundary;
- required local data fixtures with later artifacts removed;
- repository instructions valid at that boundary; and
- no descendant refs, remote access, reflog entries, target patch artifacts,
  or transcript text visible to the evaluated agent.

An archive reconstructed into a fresh git repository is safer than a linked
worktree. If historical ancestry matters, copy only commits reachable from the
base and initialize without remotes. The evaluator retains the target commit
and transcript outside the agent's sandbox for scoring.

### Fixture manifest

Every prepared fixture should have an evaluator-only manifest:

```ts
type HistoricalFixture = {
  fixtureId: string;
  sourceRepositories: Array<{
    name: string;
    sourcePath: string;
    baseCommit: string;
    sanitizedTreeHash: string;
  }>;
  sourceSessionIds: string[];
  sourceTurnIds: string[];
  userInputRefs: string[];
  acceptedDecisionRefs: string[];
  rejectedDecisionRefs: string[];
  authoritativeSpecRefs: string[];
  initialDirtyStateRef?: string;
  allowedCapabilities: string[];
  forbiddenActions: string[];
  acceptanceCommands: string[];
  outcomeRubricRef: string;
  hiddenTargetCommitRefs: string[];
};
```

The agent receives the prepared repository and replayed user/context inputs,
not the evaluator-only target fields.

### Replay inputs

There are three increasingly realistic levels:

1. **Task replay:** one historical user request plus exact accepted spec and
   base state.
2. **Steering replay:** a sequence of user messages is delivered at recorded
   semantic boundaries, including corrections and explicit authorization.
3. **Workflow replay:** parent/child tasks, async notifications, live test or
   process events, and repository transitions are reproduced.

Start with task replay for deterministic infrastructure. Use steering and
workflow replay to evaluate the context design; reducing everything to one
fully specified prompt would remove the behavior under test.

## Experiment arms

Run the same current model and reasoning profile against:

1. **Codex baseline:** current Codex/App Server extension behavior.
2. **Epoch-only Agent:** deterministic reducer/artifact storage and rollover,
   with one execution context per user turn.
3. **Work-unit Agent:** the same storage/epoch machinery plus semantic child
   contexts and bounded handoffs.

Optional ablations:

- work units with concurrency disabled;
- child traces copied into the parent, demonstrating parent pollution;
- no promoted decision lineage;
- no raw recent conversation;
- no repository-state refresh in child capsules; and
- model-written compaction versus deterministic bootstrap.

Alternate arm order. Use fresh sanitized copies. Do not let a prior run's
patch, tests, or owner feedback enter a later arm.

The historical output is a reference, not a mandate to reproduce the exact
diff. A different implementation can be better while satisfying the same
behavior and constraints.

## Scoring

### Outcome rubric

For each fixture score:

- required behavior and tests;
- architectural constraints;
- forbidden changes and scope discipline;
- cross-repository integration where applicable;
- response to steering and supersession;
- explicit permission adherence;
- final dirty/process state;
- evidence quality and auditability; and
- independent owner acceptance when subjective UX is involved.

Use exact diff similarity only as a diagnostic. It can reveal missed files,
unnecessary churn, or rediscovery of the historical shape, but it is not the
primary quality score.

### Context/runtime metrics

Collect per inference, epoch, work unit, turn, and scenario:

- maximum and cumulative provider input;
- cache-read share and request mode when available;
- output tokens and inference count;
- tool calls by family;
- model-visible bytes versus artifact bytes;
- parent versus child hot-context size;
- epoch and work-unit count;
- rollover/capsule compile latency;
- full-request and prefix-stability evidence;
- source rereads and repeated observations;
- retrieval calls and whether retrieved evidence was useful;
- required facts omitted and never recovered;
- wall time and time to first useful action;
- tests, corrections, forbidden changes, and duplicate effects; and
- owner steering latency while work is active.

### Work-unit-specific checks

- Did the parent remain bounded as child tool volume grew?
- Did each child receive the applicable accepted and rejected decisions?
- Did abandoned exploration remain local?
- Did a sibling recover exact evidence without inheriting the full trace?
- Was the child result supported by inspectable artifacts?
- Did concurrent workers observe explicit immutable bases?
- Did resume/follow-up preserve identity without duplicating work?
- Did the coordinator independently validate delegated work when required?

## Initial benchmark suite

The recommended first suite is deliberately small:

1. **Projection/time-bars bounded implementation** — clean spec adherence and
   tests.
2. **Session transport bounded implementation** — cross-layer implementation
   and review.
3. **Atomic delivery monster turn** — forced decomposition/rollover and
   cross-repository integration.
4. **Zero-origin redesign** — accepted correction, superseded architecture,
   spec, and long implementation.
5. **Replay cleanup correction** — preserve dirty scope and respond to a
   precise missing-test request.
6. **Claude delegated projection flow** — parent brief, child implementation,
   adversarial review, focused correction, independent validation, and
   integration.
7. **Rejected UX exploration** — implement or inspect an option, receive live
   owner rejection, and prove the abandoned details do not pollute later
   project context.

This suite covers bounded work, monster turns, steering, delegation, context
promotion, and cross-repository state without trying to represent every Ledger
commit.

## Release interpretation

The harness should not be declared better because it uses fewer tokens in one
run or produces the historical diff. The evidence sought is:

> Equal or better implementation quality, with less context pressure, fewer
> repeated observations, stronger adherence to current decisions and
> permissions, and a clearer evidence chain for why the result is correct.

Dogfooding for one or two weeks remains valuable after these fixtures pass. It
measures comfort, creativity, and unexpected workflow friction. It should not
replace controlled replay, and controlled replay should not pretend to measure
all of subjective collaboration quality.

## Corpus limitations

- The raw Claude predecessor `8e61883f...` transcript is missing.
- Some older Remux Claude sessions survive only as prompt history.
- Commit association after 2026-07-09 cannot be assigned to Claude merely by
  time proximity.
- App Server resumed rollouts duplicate prior history.
- Claude user-role records mix human, tool, compaction, and async data.
- Provider usage is not unique-context size.
- Historical specs may have been edited later; fixture preparation must use
  the revision from the prepared base, not today's working copy.
- Local absolute paths describe the current evidence host and should be
  converted to content hashes/fixture-relative paths when the corpus is
  packaged.
- Some live UX observations cannot be fully replayed without recorded device
  state or screenshots; those fixtures require an explicit owner-rating
  component.
- Current models may behave differently from the historical model build. The
  benchmark compares current harness arms, not past and current model quality.

## Next preparation work

Before running the benchmark:

1. write read-only extractors for Codex and Claude causal turn graphs;
2. export exact user messages, accepted/rejected decision lineage, tool/event
   counts, compaction boundaries, and child-task links;
3. content-address every retained source transcript and target diff;
4. build sanitized base repository images with no descendant solution access;
5. author evaluator-only behavioral rubrics and acceptance commands;
6. validate each fixture once without a model;
7. implement telemetry common to all experiment arms; and
8. freeze model, reasoning profile, tool contracts, and run-order policy for
   the first comparison.

Extraction and packaging must be read-only with respect to the original
transcripts and repositories. Generated fixtures should live under a separate
benchmark data root and record their complete provenance.
