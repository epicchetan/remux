Status: R&D evidence with H4 qualification completed
Last verified: 2026-08-09
Canonical code: historical repositories and local transcripts listed below; E0 controller and fixture code lives under `extensions/agent/tests/benchmark/`

# Ledger workflow transcript and benchmark corpus

This companion records the local evidence behind
[`agent-turns-and-work-units.md`](agent-turns-and-work-units.md) and preserves a
reproducible starting point for a later Agent-versus-Codex benchmark. It maps
Ledger and Remux commits to retained Codex and Claude transcripts, identifies
high-value replay fixtures, documents parsing hazards, and defines an initial
experiment protocol.

## Implemented E0 benchmark

The first production-path fixture is
`ledger-feed-session-collaboration-v1`. It starts from Ledger commit
`d92c6020b7729b22e709a31b2da9d7923cfc1923` and uses the accepted
`docs/ledger_feed_system_implementation_spec.md` present at that base. The
historical result `9f56c93a0bbfa7197b0f27a10fc0d1644b629f8b`, source rollout, and named
source turn IDs remain evaluator-only evidence and are rejected if a worker
tool call attempts to retrieve them.

The scenario deliberately uses four collaborative owner turns rather than the
original large implementation brief: audit without edits, terse authorization,
the historical FIFO correction, and final audit/validation. Its completion
gates are a clean audit turn, no commits, no forbidden-path changes, unchanged
source repository, no reference leakage, formatting, and full workspace tests
with the historical reference tests overlaid after the worker finishes. This is
the initial Codex baseline and later Agent/Pi replay surface; it is not yet a
claim that the context compiler or complete harness wins.

### First measured comparison

The first controlled comparison was completed on 2026-08-08 with GPT-5.6 Sol
at high reasoning. All three runs used the same fixture, four owner turns, and
post-run evaluator:

| Arm | Run | Gates | Compactions | Context behavior |
| --- | --- | ---: | ---: | --- |
| Codex/App Server baseline | `2026-08-08T20-23-11-730Z-codex-8e6618` | 7/8 | 1 | 117 function calls; provider reported 14,739,935 cumulative input tokens, including 14,396,160 cached tokens |
| Agent stateful, compiler v1 | `2026-08-08T22-33-40-616Z-agent-52a064` | 6/8 | 0 | 91 provider calls; 4 frames, 3 rollovers, 4 state updates, and 24 journal retrievals |
| Agent stateful, corrected authority contract | `2026-08-08T23-08-20-772Z-agent-e4682b` | 7/8 | 0 | 86 provider calls; 4 frames, 3 rollovers, 5 state updates, and 20 journal retrievals |
| Agent stateful, final exact-resource build | `2026-08-08T23-43-02-340Z-agent-c635c1` | 7/8 | 0 | 144 provider calls; 5 frames, 4 rollovers, 7 state updates, and 23 journal retrievals |

The v1 run exposed a real context-governance failure: the model promoted its
own speculative audit ideas as project decisions, then expanded the
implementation into forbidden runtime files. The corrected compiler labels
model-maintained state as fallible working state, keeps user/spec/observed
sources authoritative, and instructs the model to preserve exact governing
contracts. The second Agent run stayed within scope and matched the baseline's
7/8 result.

Every 7/8 run failed only at the hidden historical compatibility gate. In the
Agent runs the visible workspace tests passed, but the overlaid tests expected
the historical public API shape: the original helper and type re-exports,
`EsReplayCells::register` arity, and the `es_replay` and `start` builder
methods. The Codex baseline missed the same gate. The payload type names are
specified, but the failing re-export paths, component-id helper, builder method
names, and registration signature are not stated by the accepted fixture spec,
so retaining the complete spec did not determine that API shape. The fixture
remains discriminating, but this gate currently mixes behavioral validation
with historical implementation similarity and does not establish an Agent win.

The Agent subscription transport did not report provider token usage, so its
estimated input-token totals are deterministic harness estimates and must not
be compared as if they were the same measurement as Codex's provider usage.
The robust conclusion from this sample is narrower: the stateful Agent
completed the realistic multi-turn task without compaction, survived an
explicit benchmark resume in an earlier run, produced inspectable
frame/state/retrieval evidence, and matched baseline correctness after one
compiler-policy correction.

An exact-resource defect discovered after the first three runs was also fixed.
A focused production-path smoke retained the 26,728-byte accepted spec,
restarted the Agent process, compiled a new 36,765-byte frame containing that
exact body, and answered the next turn with no retrieval tool call. The durable
evidence is in conversation `5489604c-9020-4168-8f70-166193867aa0`: frame
ordinals advance from 0 to 1 across restart and both boundaries use full
provider requests.

The final E0 row then exercised that fix through the complete production
scenario. One implementation turn alone crossed three frames; the whole run
crossed five frames with four pressure rollovers, no compaction, no restart,
and no transport error. It again passed 7/8 gates, proving continuity but not
efficiency: 264 function calls and 144 provider calls were materially higher
than both the prior Agent run and the Codex baseline. Frame rollover solves
window exhaustion; it does not by itself create good work-unit boundaries or
prevent repeated self-audit. Tool volume and work-unit shaping are therefore
the clearest next optimization target.

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

### H4 frozen evaluation profiles

The Agent names for the next run are `full-history`, `managed-v1.1`, and
`managed-v1.1-work-units`. The first is the in-stack causal control; the two
managed profiles differ only by availability of the sequential `work_unit`
tool. The retained Codex/App Server result is an external reference, not the
primary causal comparison. A fresh Codex run is required only if the retained
baseline cannot be evaluated by the frozen rubric.

All Agent arms use the same model, reasoning, coding tools, fixture, staged
user inputs, and fresh workspace/project. No state, retrieval, patch, or owner
feedback crosses runs. Evaluator code and hidden lifecycle regressions are
frozen before the first model call.

The evaluator reports four gate groups: contract, safety/authority,
validation, and historical parity. Overall pass is the conjunction of the
first three; historical parity is diagnostic. The lifecycle suite explicitly
checks that a restarted feed advances reread clocks correctly and that dual
playback/shutdown failures preserve both the primary and shutdown error
contexts.

The frozen evaluator contract is:

- **E1 — causal profiles:** run `full-history`, `managed-v1.1`, and
  `managed-v1.1-work-units` with identical model, reasoning, coding tools,
  staged owner inputs, and fresh isolated project/workspace state.
- **E2 — grouped gates:** report contract, safety/authority, validation, and
  diagnostic historical-parity gates; only the first three determine pass.
- **E3 — lifecycle regressions:** independently check feed-loop clock reread
  after regression and preservation of simultaneous playback/shutdown errors.
- **E4 — context mechanics:** record provider transport, frames, pressure,
  rollover, block/omission sizes, state/provenance, invalid references,
  context-limit failures, and compaction.
- **E5 — repetition and exposure:** record reads by path, full-spec rereads,
  shell/edit/write/test activity, retrieval quality signals, and
  parent-visible result bytes.
- **E6 — work-unit accounting:** record enter/return mode, child calls and
  frames, result/trace size, parent trace reopens, local-state leakage, and
  abandoned promotions.

### H4 conformance audit (2026-08-09)

The implementation was audited against the frozen identifiers before the
qualification runs. `Pass` means both the production implementation and a
focused deterministic regression exist; the live row additionally records a
real GPT-5.6 Sol provider run.

| Contract | Status | Implementation and evidence |
| --- | --- | --- |
| F1 | Pass | `journal_open` resolves the compiler, journal, primary, artifact, omission, scope, work-result, and exact-file reference plane; the H4 context-workspace test opens emitted refs. |
| F2 | Pass | Journal search ranks/deduplicates high-signal records and exposes ordinary operations only through `include: "operations"`; search behavior is covered end to end. |
| F3 | Pass | `context_update.set.evidence` validates all refs atomically and persists primary/binding provenance; invalid-evidence rollback and proposal lineage are tested. |
| F4 | Pass | `context_update.pin` snapshots exact bounded files and journal resources; pins remain openable across rollover and restart. |
| F5 | Pass | The deterministic `TurnAnchor` contains current, preceding, accepted, and steering refs without an acceptance classifier; terse acceptance is pinned by Sol in the live smoke. |
| F6 | Pass | `open_work` is observation-backed and carries bounded command refs, failures, dirty paths, status hash, and readable completed-work objectives/results. |
| F7 | Pass | Pi compaction is disabled; model-window admission, one-notice-per-frame pressure, rollover, and durable notice telemetry have deterministic regressions and real-provider evidence. |
| W1 | Pass | One optional `work_unit` tool implements validated `enter` and `return` actions. |
| W2 | Pass | Repository invariants permit one sequential root child and reject nested/concurrent entry. |
| W3 | Pass | Entry creates an isolated child scope/space/epoch and deterministic bounded capsule; child dispatch starts with a full frame. |
| W4 | Pass | Child state defaults local, direct project writes are rejected, and promotion remains explicit. |
| W5 | Pass | Explicit return writes an openable content-addressed result and restores a parent objective naming that result instead of replaying the trace. |
| W6 | Pass | Terminal child text becomes a provisional implicit result followed by a parent-only integration inference. |
| W7 | Pass | An unfinished child resumes from its durable capsule after repository/runtime restart without parent scratch replay. |
| E1 | Pass | Adapter tests prove the three Agent profiles isolate full history, managed context, and work-unit availability while retaining identical model/tool fixture inputs. |
| E2 | Pass | The evaluator emits contract, safety/authority, validation, and diagnostic historical-parity groups; only the first three determine overall pass. |
| E3 | Pass | Frozen hidden regressions independently catch stale feed clocks and discarded simultaneous shutdown errors. |
| E4 | Pass | Journal evidence records transport, estimates/usage, frames, notices, rollovers, blocks/omissions, state, invalid refs, limit failures, and compaction. |
| E5 | Pass | Evidence reports path reads/repeats, full-spec exposure, shell/edit/write/test activity, retrieval quality, and parent-visible result bytes. |
| E6 | Pass | Evidence reports work-unit entry/return mode, child calls/frames/tokens, result/trace bytes, parent trace reopening, state leakage, and abandoned promotion. |

The production-lifecycle smoke used a fresh isolated journal, the real
OpenAI-subscription transport, `gpt-5.6-sol` at high reasoning, and the actual
Agent server/runtime implementation. It completed in 134 seconds with one
explicit child, one active accepted-proposal primary with two provenance refs,
eight durable pressure-notice inferences, four deliberately low-threshold
rollovers, eight full and fifteen continuation requests, zero implicit child
returns, zero compaction, zero context-limit failures, successful runtime
restart recovery, and an unchanged working tree. Conversation
`9d73ca4d-a0ad-4e43-9912-05c07a719982` and result artifact
`95c06d230cc463ca49bf15a4a5607cec7f52253196d50e05d5e6384fc60719bd`
identify the retained smoke evidence.

### H4 measurements and decisions

In addition to existing quality gates, record:

- invalid, self-referential, duplicate, useful search/open/update calls;
- primary create/revise/close operations, provenance, active bytes, and
  exact proposal-evidence survival;
- provider calls, full/delta transport, frames, pressure notices, rollovers,
  checkpoints, estimated peak, bootstrap/raw/state/runtime/omission bytes,
  reported usage, errors, and compaction events;
- reads by path, repeated and full-spec reads, shell/edit/write/test counts,
  retrieval counts, and parent-visible tool-result bytes; and
- work-unit enter/return mode, tools, tokens, frames, result/trace size, parent
  reopen behavior, leakage, and changed paths.

Mechanics pass requires zero invalid or self-referential refs, no compaction,
exact recovery of the current request and accepted proposal, a pressure notice
before non-emergency rollover, no context-limit failure, and restart recovery.
Initial efficiency targets are at most two rollovers, eight journal retrievals,
three full-spec reads, and provider calls within about 15% of full history
unless quality improves.

Work units become the default only if their use is semantically sensible,
quality and permission isolation do not regress, parent peak input or
parent-visible tool-result exposure falls by at least 25%, and provider-call or
wall-time overhead stays within 20% absent a quality improvement. Explicit
completion should be normal and the parent should not need to reopen the full
child trace. If both managed profiles pass, repeat each once before drawing a
directional conclusion.

### H4 qualification result (2026-08-09)

The frozen three-profile run used GPT-5.6 Sol at high reasoning and fresh
isolated copies of `ledger-feed-session-collaboration-v1`. The retained Codex
run is shown as an external reference. Agent input counts are deterministic
harness estimates; Codex input/cache counts are provider-reported and are not
directly comparable.

| Profile | Run | Common outcome | Context result | Calls / exposure |
| --- | --- | --- | --- | --- |
| Codex/App Server reference | `2026-08-08T20-23-11-730Z-codex-8e6618` | Completed 4/4 turns; failed only the hidden historical API-shape tests | One App Server compaction | 117 function calls; 14.74M reported input tokens, 97.7% cache-read |
| `full-history` | `2026-08-09T17-21-25-695Z-agent-33a5fe` | Stopped after 2/4 turns; also missed dual-error preservation in its partial patch | Failed admission at 242,492 estimated input tokens; zero compaction | 80 provider calls, 141 tools, 586,617 parent-visible result bytes |
| `managed-v1.1` | `2026-08-09T17-43-12-966Z-agent-28e01b` | Completed 4/4 turns; matched the Codex reference on common gates and failed the same hidden API-shape tests | Two frames, one noticed rollover, no limit failure or compaction; one invalid context call | 114 provider calls, 193 tools, 14.73M cumulative estimate, 226,486 peak, 977,099 parent-visible result bytes |
| `managed-v1.1-work-units` | `2026-08-09T18-54-39-994Z-agent-a42a10` | Completed 4/4 turns but missed the feed clock-reread lifecycle invariant and the hidden API shapes | Three explicit children, seven full frames from child/parent transitions, no rollover/limit failure/compaction; eight invalid context calls | 125 provider calls, 244 tools, 9.64M cumulative estimate, 164,519 peak, 375,767 parent-visible result bytes |

The work-unit arm entered three semantically coherent children: initial audit,
implementation, and final audit. All three returned explicitly; child-local
state did not leak, no abandoned promotion occurred, and the parent never
reopened a child trace. Relative to `managed-v1.1`, it reduced cumulative
estimated input by 34.6%, peak input by 27.4%, and parent-visible tool-result
bytes by 61.5%. Provider calls increased 9.6% and measured four-turn wall time
increased 5.3%, both within the frozen overhead allowance. This is strong
evidence that bounded child frames can reduce parent pollution and total
context exposure.

It is not evidence to make work units the default yet. Quality regressed on a
frozen lifecycle gate, total tools increased 26.4%, journal retrievals rose
from 7 to 46, and full accepted-spec reads rose from 1 to 7. The model also
changed the accepted spec to its independently reasoned `ts_recv` design
without a new owner acceptance turn. Its reasoning may be technically useful,
but it crossed the intended authority boundary for this fixture.

The eight invalid calls identified a concrete primitive-design problem rather
than random search noise. The model naturally supplied workspace paths and
file/line citations in `work_unit.refs`, returned finding evidence, and
`context_manage.sources`; those fields accepted only openable journal URIs. It
also wrote the free-form kind `accepted_proposal` instead of the canonical
`accepted-proposal`, so the then-current survival gate did not credit it. This
finding motivated the smaller `context_update` contract qualified below:
workspace resources have an explicit pin operation, state does not expose a
model-facing kind, and proposal acceptance follows exact evidence instead of a
reserved name. It did not justify a context-manager agent or a larger workflow
protocol.

One excluded work-unit attempt,
`2026-08-09T18-14-52-757Z-agent-a6bfdc`, exposed a harness durability defect:
a provider-visible tool result containing an unsafe JavaScript integer crashed
canonical journal storage. Tool-result durability now derives semantics from
the exact provider-visible text and preserves out-of-domain JSON as text; both
semantic and real Pi-runtime regressions cover the boundary. The qualification
rerun above completed after that fix. Evaluator-only extraction corrections
also made failed-turn settlement durable before scoring and count frames and
pressure notices once per actual frame. They changed no model prompt, workspace,
hidden test, or pass threshold.

No repeat was run because neither managed profile passed all frozen gates. H4
therefore selects `managed-v1.1` as the safer current baseline, retains work
units as an experimental profile, and rejects `full-history` for realistic
long implementation turns.

### Context-update v3 qualification (2026-08-09)

The next managed-context iteration removed the planner-shaped context API from
the model surface. `context_update` now exposes only four primitive operations:
`set`, `remove`, `pin`, and `unpin`. Thread scope is the default, project scope
is explicit, state values are arbitrary canonical JSON, and revision,
descriptor, kind, retention, placement, and promotion mechanics remain harness
internals. Work units are opt-in and were disabled for this arm. The fixed
prompt explains hot context, cold journal retrieval, and small durable state,
but does not prescribe a task workflow or a reserved state key.

Proposal acceptance is recognized by exact provenance rather than by the
literal key `accepted-proposal`. Any effective model state may establish the
turn anchor when it cites the exact preceding assistant turn or message. This
keeps the model free to choose a meaningful work key while retaining a
deterministic, classifier-free acceptance contract.

One interrupted qualification attempt,
`2026-08-09T20-27-17-987Z-agent-5603a8`, exposed a runtime recovery defect. A
provider WebSocket failure left the in-memory Pi suffix ahead of the durable
journal, and the first retry reused that contaminated runtime. The server now
disposes an errored conversation runtime and hydrates a fresh one from the
durable prefix before retrying. The resumed turn completed the remaining
implementation and validation, proving durable recovery, but its 68 retrieval
calls and failed-turn journal artifacts make it unsuitable as an efficiency
measurement.

The clean retained run is
`2026-08-09T21-00-03-940Z-agent-eab4b1`. It used the same fixture, GPT-5.6 Sol
at high reasoning, four owner turns, frozen correction, and hidden evaluator as
the earlier arms.

| Profile | Common quality | Context mechanics | Calls / exposure |
| --- | --- | --- | --- |
| Codex/App Server reference | Failed the hidden historical API-shape suite; passed both frozen lifecycle checks | One App Server compaction | 117 tools; 14.74M provider-reported input tokens |
| Prior `managed-v1.1` | Matched the Codex common gates | One noticed rollover, no limit failure or compaction; one invalid context call | 114 provider calls; 193 tools; 14.73M cumulative estimate; 7 retrievals |
| `context_update` v3 | Failed the same hidden API-shape suite and additionally missed dual playback/shutdown error preservation | **Passed**: zero compaction, invalid context calls, context-limit failures, self-search hits, or unannounced rollovers; one noticed rollover | 95 provider calls; 192 tools; 12.80M cumulative estimate; 223,656 peak; 6 retrievals |

The model used the primitive without correction. On the implementation turn it:

1. created `ledger-feed-implementation` with the accepted constraints and the
   exact preceding assistant-message evidence;
2. revised the same key after the implementation milestone with completed
   components, durable design decisions, validation, and the next check; and
3. removed the state and unpinned the request when the work was complete.

Ordinary reads, edits, test output, and journal retrieval stayed ephemeral.
The implementation turn performed no journal retrieval, while the full
four-turn run used six retrieval calls, five of which the evaluator classified
as useful. This is the first retained run that demonstrates the intended
model-managed-state lifecycle without manual compaction, a reserved primary
name, or a separate context-manager agent.

This is a context-mechanics improvement, not an overall benchmark win. Relative
to the prior managed arm, provider calls fell 16.7%, state operations fell from
nine to three, invalid context calls fell to zero, and the cumulative input
estimate fell 13.1%. Total tools were essentially unchanged (192 versus 193),
repeated reads increased from 30 to 37, and the clean run still used 64.1% more
tools than the Codex reference. Its hidden behavior was also worse by one
frozen lifecycle gate. The next iteration should preserve this primitive and
prompt contract while improving implementation grounding and validation; it
should not add a second context model or hard-code repairs for this fixture.

Before full evaluation, publish a conformance table for F1-F7, W1-W7, and
E1-E6 and run one production smoke through the same UI/server/provider path:
proposal, terse acceptance, child entry, bounded real repository inspection,
forced low-threshold rollover, child return, runtime restart, and a follow-up
that requires both the accepted proposal and child result.

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
