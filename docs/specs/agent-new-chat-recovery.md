# Message recovery across disconnects

Status: implemented, committed, and deployed on 2026-09-06. Broader audit remains paused.

## Incident and contract

Draft 7ccfb567-b5eb-4e08-8051-4d2ed69cd0bb created conversation
7f096dc4-5aaa-4f5d-964b-e862ed5e7632 at 2026-09-06 00:00:53.190 UTC.
The Agent process exited 291ms later. The create receipt is accepted, native
session ready, and no first message/turn was admitted. The phone retained a draft
and showed a transport error. Exact create replay returned the existing ID.

One persistent client owner records new-chat submission before any side effect:
original draft/snapshot, exact creation request and operation ID, accepted
conversation identity, exact first-message request and operation/client-message
IDs. Accepted results remain durable in server receipts and are read again during
recovery. Reconnect/reload resumes that same operation.
No new ID or changed payload may be substituted for an uncertain request.

Persist the frozen message intent and IDs before artifact uploads or send. Keep
submitted content and current edited draft distinct: successful recovery clears
only the submitted snapshot, never later edits or another conversation's draft.
A failed handoff/resource read must retain enough information to attach the
already-created conversation. Clearing the original draft before the durable
handoff is complete is not permitted.

A read-only command status query supports only conversation.create and turn.send.
It returns receipt status and their safe accepted results, rejects kind mismatch,
and causes no native effects. Accepted means reuse its result. Missing/received
may use the original request. Dispatching/recovery_failed remains uncertain;
never generate another native operation based only on disconnect or timeout.
Known rejection must be distinguished from acceptance/uncertainty before any
replacement request is allowed.

The historical draft predates persisted submission payloads. If its create receipt
is accepted, attach it to that conversation and preserve the current draft. Do
not automatically submit mutable text whose original message request was never
persisted. The user can send from the recovered conversation.

## Presentation and boundaries

While recovering, show a concise reconnect/checking status. Coalesce simultaneous
Send/reconnect events, bound automatic recovery attempts, and expose explicit
Retry if recovery cannot finish. An ordinary unsent draft must never send just
because the app reconnects. Navigation must not redirect or clear the currently
selected conversation when an older operation resolves.

The original slice covers new-chat creation and first-message submission, with
server receipt lookup. The parallel cleanup batch extends the same owner to
ordinary messages in existing conversations. No branch/steer/compact rewrite,
server queue-failure policy, or new database schema is included.
Use staged Sol ownership: viewer owner/state-machine and tests; server read-only
status API and tests; primary contract, integration review, commit/push, build,
controlled restart and live verification. Preserve the shared native daemon.

## Acceptance

- Disconnect before creation; retry exact ID, one conversation.
- Accepted creation/lost response; reconnect and reload recover existing ID.
- Creation succeeds but resource/handoff read fails; retain recoverable draft.
- First message accepted/lost response; replay exact IDs, one turn/message.
- Attachments preserve stable upload/send identities and survive reload.
- Edits after submission, conversation switches, and concurrent retry events do
  not change submitted payloads, erase newer text, or duplicate native work.
- Ordinary unsent drafts remain unsent after reconnect.
- Legacy accepted-create draft attaches without automatically submitting text.
- Rejected versus unknown outcomes get distinct recovery behavior and errors.

## Evidence

Implementation checkpoints:

- `73a2157`: read-only create/send receipt API, strict kind validation, safe
  accepted-result projection, and server regression coverage.
- `dc04358`: persistent viewer owner, exact replay identities, bounded automatic
  recovery and explicit Retry, legacy attachment, and browser/storage coverage.
- Main pushed; server API rebuilt and restarted through the extension lifecycle.
  Viewer rebuilt and published after review. The shared native daemon was kept
  running, and the viewer watcher was restored after publication.

The pending record uses per-operation session storage, so separate drafts cannot
replace one another's frozen intent. Image bytes are stored once within that
record. A failed storage write stops submission before effects. Automatic checks
are limited to three attempts per operation in a connection; reconnect resets the
budget, and explicit Retry reuses the same operation. Closing a browser tab or
clearing its session storage is outside the reconnect/reload recovery guarantee.

Validation:

- Root TypeScript and linked-viewer typechecks passed.
- Server suite: 285 passed, including four pending-record storage tests.
- Desktop/mobile recovery cases cover legacy attachment with no send, accepted
  create/lost response and reload, later edits, navigation away and return,
  simultaneous retries, and accepted send/lost response with an image. The image
  case verifies the original turn, one accepted send, no artifact re-upload,
  cleared submitted composer, and removed pending record after handoff.
- Final full browser suite: 198 passed, 3 skipped, one mobile geometry case failed
  because a neighboring virtualized turn was not mounted. The isolated mobile
  geometry suite then passed all 3 cases. An earlier full run passed 199 with 3
  skips. No virtualizer code was changed in this slice; retain the transient
  failure as a test reliability observation rather than claiming every full run
  was green.
- Exact create replay and read-only receipt lookup returned the incident's
  existing conversation. The live built viewer recovered that legacy draft on
  desktop and mobile, preserved diagnostic draft text, and emitted no page errors.
  Before/after checks show the same idle conversation/native session and zero
  turns; the original user's message was not submitted by the check.
- Main-thread integrity check preserved all 67 baseline turn IDs and user-content
  hashes, the root execution, native session, and strand. It currently has 90
  hydrated turns, remains running, and reports no health error.

Evidence artifacts are under `/tmp/remux-audit-implementation/`:
`newchat-server-regression.log`, `newchat-viewer-build.log`,
`newchat-recovery/legacy-live.json`, desktop/mobile screenshots in that directory,
and `subagent-deploy-thread-after.json`. Full browser results are in
`/tmp/newchat-full-viewer-final.log`.

This evidence combines server receipt/replay tests, browser fault injection, and
live legacy-draft recovery. It does not claim a live process-kill canary at every
possible create/upload/send boundary. At that original checkpoint, unresolved
and rejected provider-effecting receipts remained explicit errors. The ordinary-
message extension below distinguishes a positively rejected send from uncertainty
and permits a later explicit submission after rejection; uncertain requests never
receive replacement IDs.


## Ordinary-message extension — parallel cleanup batch

Existing-conversation normal Send now persists the exact send request, IDs,
configuration, parts, and submitted snapshot before any artifact or send effect.
It uses the same receipt lookup, promise coalescer, bounded retry schedule,
transcript/queue handoff, and conditional clearing as new-chat recovery. A queued
receipt is accepted enqueue evidence; recovery must not create another queued
message while waiting for native execution.

`pendingMessageSubmission.ts` records an explicit `new-chat` or
`existing-conversation` source. An existing-conversation record has no fabricated
create stage and matches only its exact non-null conversation ID. One
`submissionMatchesTarget` predicate protects both selection and in-flight
recovery, including navigation to a blank New chat. Old source-less records still
normalize to new-chat, and the shipped session-storage prefix is unchanged.

The implementation deliberately shares the existing recovery flow instead of
adding a parallel existing-message retry mechanism. The larger actions-hook
extraction remains optional maintenance; this slice removes the separate ordinary
send/handoff path and gives both paths one owner. Native rejection, unresolved
delivery, and an accepted message whose transcript is still loading remain
separate outcomes. A positively rejected `turn.send` releases the pending intent,
retains the editable draft and visible error, and permits a later explicit Send
with a fresh request. This is never an automatic replacement: transport errors,
`dispatching`, and `recovery_failed` keep the original identity fenced. General
queue retry/recheck, branch/edit/fork, and manual
Compact/steer are separate cleanup stages.

Focused evidence: 20 desktop/mobile shared-recovery cases, then eight existing
message/navigation cases passed in Sol's handoff. Primary added shared target
matching and legacy-record validation; six storage tests pass. Final integrated
and live results are recorded in the remediation spec's batch deployment entry.
