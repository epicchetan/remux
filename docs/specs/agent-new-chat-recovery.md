# New-chat recovery across disconnects

Status: approved in chat; implementation in progress. Broader audit remains paused.

## Incident and contract

Draft 7ccfb567-b5eb-4e08-8051-4d2ed69cd0bb created conversation
7f096dc4-5aaa-4f5d-964b-e862ed5e7632 at 2026-09-06 00:00:53.190 UTC.
The Agent process exited 291ms later. The create receipt is accepted, native
session ready, and no first message/turn was admitted. The phone retained a draft
and showed a transport error. Exact create replay returned the existing ID.

One persistent client owner records new-chat submission before any side effect:
original draft/snapshot, exact creation request and operation ID, accepted
conversation identity, exact first-message request and operation/client-message
IDs, and acknowledged result. Reconnect/reload resumes that same operation.
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

This slice covers new-chat creation and first-message submission, with server
receipt lookup. No branch/steer/compact rewrite or new database schema is required.
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

Implementation and acceptance pending.
