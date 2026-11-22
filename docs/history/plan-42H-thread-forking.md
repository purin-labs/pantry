# Plan 42H — Chat Thread Forking

Status: implementation, local harness/storage acceptance and native Portal-to-Worker browser journeys passed. The code is in production (in the release of 2026-10-17 at the latest) and its smoke journey passed on 2026-10-28. Integrated browser file upload, fork and continuation pass on the Codex route, the Satyr platform route and in production ([report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/browser-upload-fork-codex-2026-10-28.md)).
Date: 2026-10-03.
Owners: Satyr platform and Portal.

## User outcome

Choose the **Branch in new chat** icon on an earlier completed assistant response.
Its popover shows the action name on hover or keyboard focus. A **Fork chat from
here** modal offers **Fork in this workspace**; dismissing it keeps the current
chat. Confirming opens a new thread with the conversation through that response
and a **Continued from chat** divider linking to the original branch point.
The header shows the new thread's title, a confirmation
announces its creation, and fullscreen chat reveals the selected thread in the
sidebar. The empty composer receives focus. Continue with a different question
or approach. The original thread and its later messages remain intact and
independently usable.

For example, discuss a bakery workflow, explore an oven arrangement, then fork
from the earlier workflow discussion to explore a different arrangement. Each
thread has its own subsequent messages, queued work, cancellation, and title.
Both initially refer to the same current workspace. Creating an alternative
saved layout remains a separate domain action.

## Decision and scope

Add provider-neutral thread ancestry and a bounded fork command to the existing
chat application. Preserve one `AgentSessionActor` and one harness per session.
Create a fresh destination execution lineage from an authorized, immutable
prefix of Actor-accepted history. Record the source thread and exact cutoff.
Keep canonical history, effect receipts, and authorization with their existing
owners.

This plan owns the bounded historical branching deferred by
[Plan 45](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-45-chat-portal.md#excluded). It extends the chat UX used by
[Plan 42G](plan-42G-automatic-context-loading.md) and coordinates with
[Plan 50](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-50-pi-durable-execution-multiplayer.md). Forking is a separate
delivery milestone; it does not enlarge Plan 50's initial adoption gates.

The first release includes:

- Forking after a completed assistant turn anywhere in retained history,
  including an earlier turn while the source runs later work.
- Independent continuation, restart, cancellation, archive, and reopening.
- Parent/branch-point navigation and a small list of directly derived threads.
- Forking a fork, with explicit ancestry and a bounded history projection.
- Existing attachment, model-route, information-flow, and shared-workspace rules.

Defer editing an old message in place, automatic regeneration, branch merging,
a graphical tree explorer, workspace cloning, cross-organisation forks, and forks of
another owner's private chat. [Plan 54](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-54-chat-shared-projects.md) extends
forking to currently authorized members of explicitly shared conversations;
each destination is private to its creator and descendant erasure reaches those
retained copies across users. Streaming fragments and boundaries inside unresolved tool-call/result
pairs are ineligible. The first release exposes completed assistant-turn
boundaries; editing and resubmitting an earlier user message is separate work.

## Foundation and implementation gaps

Pi Durable provides `conversation.fork(entryId, options, context)`. A fork
inherits entries through an inclusive parent entry and continues independently.
Conversation documents choose `asOf`, `current`, or `initial` fork behavior;
historical restoration requires rewindable document history. See the
[reviewed API](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/README.md#more-conversations-and-forks)
and [upstream fork example](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/test/examples/02-forks.ts).

That native operation links conversations inside one Pi session store. Satyr's
[integration design](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-50-durable-execution/integration-design.md#ownership-and-placement)
places separate sessions in separate Actors. Implement the product fork at
the Satyr history boundary and reconstruct the selected harness in the new
Actor. Avoid consolidating unrelated chat authority into one harness to obtain
a native ancestry pointer. Pi's API establishes library support; the cross-Actor
initialization path passes acceptance with the currently installed Pi SDK.
Plan 50's Durable adoption must preserve that contract.

| Existing boundary                                                                        | Required addition                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Chat timeline](../../foundation/conversation/chat/timeline.ts)                             | Bind each eligible displayed response to its exact completed Actor-history cutoff.                           |
| [Conversation and lifecycle](../../foundation/conversation/chat/conversation.ts)            | Required ancestry variants and explicit fork preparation outcomes.                                           |
| [Chat storage](../../foundation/conversation/chat/store.ts)                                 | Persist fork identity, immutable prefix binding, directory visibility, and idempotent creation.              |
| [Chat application](../../services/platform/src/chat/application.ts)                         | Authorize source reads and destination creation; initialize a fresh Case/session through existing admission. |
| [Actor history authority](../../foundation/agent/actors/agent-session-harness-authority.ts) | Validate and initialize accepted inherited context without replaying execution events.                       |
| [Portal chat](../../apps/portal/src/features/chat/route.tsx)                                | Fork action, preparation state, branch navigation, and independent composer.                                 |

Use [NF9's two history lanes](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-14-nf9-actor-owned-history.md#decision).
Display messages alone cannot reconstruct model history. A visible message ID
must resolve on the server to the accepted history prefix and its digest,
including completed tool results and relevant context. Never slice a browser
message array and treat it as trusted model history.

## Fork contract

### Exact boundary and independent state

The client supplies source conversation ID, selected message ID, and a stable
fork request ID. Resolve the organisation and control identity from authentication.
Resolve the source Case/session lineage, accepted cursor, and prefix digest on
the server. A repeated request returns the same destination; reuse with a
different source or cutoff fails.

The prefix includes the selected completed response and its settled tool
history. Exclude later messages, later context changes, pending input, in-flight
generation, tasks, and source checkpoints. Later source appends cannot advance
the destination cutoff. An unavailable or unverifiable prefix produces a typed
failure; never substitute a newer cutoff or silently omit missing history.

The destination starts ready with an empty composer and no admitted work.
Creating a fork performs no model call or tool dispatch. The user's next message
admits a fresh request and turn through the destination Case and session.
Preserve inherited
message provenance and identify inherited usage as historical; do not charge it
again or reset organisation-wide accounting.

Record ancestry as a discriminated union: an original thread has no parent
fields; a fork requires source conversation, branch message, accepted history
binding, and creation identity. Fork preparation distinguishes preparing, ready,
and failed states with their required destination, progress, or failure fields.
Core functions accept validated variants. Use exhaustive handling and static
rejection fixtures for invalid combinations, broad spreads, and unsafe casts.

### Persistence and interruption

Reuse existing durable command, receipt, and recovery patterns. Persist the
fork intent and stable destination identity before cross-Actor work. Prepare an
immutable, authorized history bundle with its cutoff and digest; initialize the
destination once; publish its ready directory entry after initialization is
accepted. Preparing entries cannot accept chat input.

D1 and separate Actors do not share a transaction. Reconcile initialization and
directory publication by the original fork identity after response loss or
restart. A duplicate request or concurrent recovery must yield one destination
and one initialized prefix. Persist the next recovery action before acknowledging
pending creation. Reuse existing owners and alarms; add no Actor kind or fork
scheduler.

Materialize the accepted prefix once for independent destination restoration.
Preserve source provenance while establishing destination-local cursor and
checkpoint bindings. Do not copy the source's hash chain as newly executed
destination events. Reuse or extend the canonical history initialization path,
including the tool-call/result associations required by each adapter.

### Authority and effects

Authorize the entire inherited prefix and referenced attachments under current
access rules. Keep the destination in the same organisation and the requesting user's
private scope. Private sources require ownership; explicitly shared sources
require current membership and permission to inherit the complete history.
If part of the prefix cannot be inherited, fail with a precise reason.
Do not create a misleading partial conversation. Recheck authority when the
destination admits work and when either thread is opened again.

Inherited approvals and tool receipts are historical evidence. Their controls
cannot authorize destination actions. Do not copy execution leases, pending
approvals, submission queues, tool tasks, provider request IDs, or outstanding
effect intents into the destination runtime. Pending effects remain owned and
reconciled by the source, even when the fork excludes their later messages.

A new action requires current domain observations, a new accepted user request,
normal policy checks, and any approval required for its exact payload. Forking
cannot undo or resend an email, repeat a payment, or dispatch a robot. Current
domain state may include source effects that occurred after the cutoff; read
that state before proposing a new mutation. Never replay old user requests as
new work while rebuilding context.

Use the model and funding route recorded for the selected turn as the initial
destination choice, subject to current availability and authorization. Resolve
credentials anew. An unavailable route gives an explicit blocked outcome or
requires an ordinary user-selected route change. No inference fallback or
inherited credential material. Cancellation addresses the destination's own
accepted request and cannot cancel the source.

### Shared workspace and context

Thread history branches; referenced shared resources retain their current
identity and state. Both threads initially use the same authorized Plan 40C
rooms, including Plan 50 canvas positions. Show that shared-workspace relationship
when the fork opens. A fork does not rewind the Yjs room or replace it with a
historical snapshot.

Retain historical observations as attributed context. Revalidate workspace
revisions before edits. Browser readiness, surface session IDs, epochs, and
pending browser effects must be acquired through Plan 42G for the new request.
Preserve local unsaved page work while switching threads. A request to explore
an isolated layout must use a separately supported draft/snapshot operation.

Initialize Code Mode scratch values and selected-tool runtime state fresh.
Retain accepted tool results in history, and rediscover capabilities under
current grants. Do not copy opaque Pi/Codex checkpoints or assume Pi document
fork policies also fork external workspace state. Use one initialization path
for each supported adapter and prove the selected production Pi implementation;
Plan 50 cutover must preserve this contract when it occurs.

### Retention and lifecycle

Archiving the source leaves the fork usable. Source deletion or retention expiry
must not leave an apparently valid destination with missing context or assets.
Register inherited attachment references under the existing retention lifecycle.
Include inherited content and ancestry in export, erase, and restore semantics.
Privacy erasure must reach retained copies in descendant threads, or explicitly
invalidate affected histories through the existing erasure mechanism. Ancestry
links reveal source content only after an access check.

## Portal behavior

Expose **Fork from here** in the completed assistant-message actions, accessible
without hover and by keyboard. Show a short reason at ineligible boundaries.
Creating a fork preserves the source composer, scroll position, and running
work. Open the ready destination with the inherited prefix and an empty composer.

Use a plain title derived from the source without a model call. Show **Forked
from [thread] at [message]** and a link to the exact branch point. Show directly
derived threads near that point or through the existing thread menu; authorize
each entry. Support nested forks without requiring a tree explorer.

Display inherited approval/receipt cards as history with source attribution.
Keep branch-local drafts, unread state, queues, errors, archive, and Stop scoped
to the selected thread. A reload during preparation must recover the same
destination or display its failure, with a retry that preserves request identity.

## Delivery sequence

### H1 — Accepted history and fork creation

- [x] Trace current UI messages to accepted Actor history, including compacted
      history and messages produced across successive sessions.
- [x] Define eligible cutoffs, ancestry types, idempotent fork command, and
      immutable history initialization. Resolve unavailable-prefix behavior.
- [x] Implement durable preparation and cross-store reconciliation using the
      existing chat, Case, and Actor owners. Prove one destination after restart.
- [x] Add boundary parsers and compile-time fixtures. Preserve original-thread
      records through one persistence-boundary conversion where necessary.

Exit: a fork from an earlier completed turn restores an exact authorized prefix
in an independent session, with no model call or side effect during creation.

### H2 — Continuation and Portal controls

- [x] Reconstruct Pi and Codex context from inherited accepted history. Prove
      complete tool protocol, fresh execution state, current grants, and pinned
      routing. Advertise capability only for routes that pass acceptance.
- [x] Add message action, preparation/failure feedback, ancestry navigation,
      independent composer, and read-only inherited action cards.
- [x] Preserve shared-room identity and unsaved page state; reacquire browser
      readiness and refresh domain observations for new actions.
- [x] Verify two live Yjs clients retain the current room identity and snapshot
      across fork creation and continuation, with zero fork-induced mutations.
- [x] Read later human menu edits through the real Tool Host in both a fork and
      nested fork. Require an enabled read policy, a current grant and membership,
      and refuse reads after grant revocation between discovery and execution.
- [x] Prove source and destination can continue and stop independently, including
      a fork of a fork and source activity after the chosen cutoff.

Exit: an operator can branch mid-conversation and continue in either thread with
clear workspace behavior and independent execution controls.

### H3 — Faults, lifecycle, and cleanup

- [x] Run the E2E journey below with deterministic fault injection and a native
      canary for each advertised Pi/Codex route. Label evidence by runtime.
- [x] Verify compaction, attachment retention, archive, export, erasure, restore,
      revoked access, and unsupported source-history handling.
- [x] Remove trial scaffolding, duplicate history reconstruction, and obsolete
      persistence paths after replacement. Add no permanent fork feature flag.
- [x] Record final contracts and repeatable evidence, including any unsupported
      route. Keep Plan 45 and Plan 50 references aligned with delivered scope.

## End-to-end acceptance

Use a medium-to-hard journey with two browser tabs, retained attachments, an
accepted tool effect, and later source activity. Exercise actual chat admission,
Actor history, Tool Host, receipt reconciliation, and Portal controls.

1. Build a source conversation with an attachment, an authorized read, and an
   approved effect with a settled receipt. Record a completed assistant response
   as the cutoff. Add later messages and begin another source request.
2. Fork at the earlier cutoff while that later work is running. Verify the
   destination includes the exact earlier prefix and receipt, excludes later
   messages, and has no source queue, approval authority, or active task.
3. Lose the fork response after destination initialization, restart the relevant
   runtime, and retry the same request. Verify one destination and one prefix.
   A different cutoff under that request ID must fail.
4. Continue in the destination with an alternative question. Verify the model's
   inherited context, zero repeated historical effects, and fresh tool admission.
   Continue in the source. Stop one thread while the other runs and verify isolation.
5. Open the same shared workspace from both threads. Make a human layout edit,
   then ask the fork to inspect it. It must observe the current accepted layout
   and preserve unsaved page work. Fork creation must produce zero room mutations.
6. Fork the destination at one of its completed responses. Reload all views and
   evict/reconstruct the relevant Actors. Verify ancestry, exact prefixes, and
   branch-local queues, titles, read state, and continuation.
7. Repeat targeted variants with a compacted source, unavailable attachment,
   revoked access, a tool call lacking a settled result, and source archival.
   Verify explicit failures or the documented eligible boundary. Exercise
   export/restore and privacy erasure across inherited content.

Capture the revision, exact command, fixture identity, source/cutoff/destination
IDs, prefix digests, sanitized model-context evidence, fork receipt, mutation
counts, and both threads' final states under
`docs/evidence/plan-42H-thread-forking/`. Include browser screenshots or a
recording of branch creation, source navigation, and independent continuation.
Separate deterministic fault evidence from native model/provider results.

Use E2E tests for behavior and static fixtures for domain-state rejection. Add
no unit tests. Run the narrow journey first, then relevant platform type checks,
Portal build, and required lifecycle/commerce checks for affected code. Run
documentation link checks and `git diff --check`. Completion requires passing
fork recovery and effect-isolation evidence, with no unsupported behavior
presented as available.

## Implementation evidence — 2026-10-03

The [review follow-up](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/review-followup-2026-10-03.md)
fixes per-reference attachment validation and delayed submission cleanup across
thread changes. Accepted files and text stay cleared in the submitted composer;
other branch drafts remain intact, and a refused upload retries with the same
request identity. Shared private forks and interrupted cross-user erasure also
pass the existing Plan 54 Actor journey. The original acceptance records below
retain their runtime labels.

[Acceptance record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/README.md) and
[sanitized journey results](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/acceptance-2026-10-03.json).

Implemented the response-to-Actor-history binding, immutable fork bundles,
idempotent D1 receipts, nested ancestry, fresh Pi/Codex continuation, current
access checks at read/admission/runtime, inherited attachment preparation,
descendant erasure, and Portal fork/navigation controls. Thread switching saves
drafts and remembers scroll positions. Historical connector and response actions
are read-only. Creation uses the selected response's pinned model route and
performs no model call.

The deterministic journey proves forks during later source work, settled tool
history, exclusion of later messages, publication-response loss, duplicate request
recovery, conflicting request rejection, Actor eviction, nested continuation,
archive/reopen, denied reads and admission after grant revocation, and descendant
erasure. Both Pi and Codex pass. The native Pi SDK canary separately proves a new
session recalls an accepted real-model tool result with zero destination tool
calls. The native Codex App Server canary now passes the same recall and zero-repeat guarantee with `gpt-5.6-luna`.

The [upload, restore and native acceptance report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/upload-restore-native-acceptance-2026-10-03.md)
and its [sanitized results](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/upload-restore-native-acceptance-2026-10-03.json)
close the three implementation gaps previously listed here:

- The native Codex adapter calls the already-connected local App Server bridge
  on port 3112. An independent session recalls its accepted inventory result and
  branch marker, with one source tool call and zero destination tool calls.
- Portal sends selected files with the message through a bounded multipart
  request. R2 retains their bytes and typed Portal provenance; the accepted
  timeline carries references through queues, steering, reloads and forks.
  The connected Worker journey now uses actual Portal upload admission for
  text, PNG, WAV and MP4. Its test-only source directory projection is removed.
  An identical upload replay makes no model call; changed content under the
  same request ID is refused. Audio/video decoding limitations remain explicit.
- Organisation Actor exports carry a D1 chat snapshot and referenced file objects
  through existing Actor portability. Restore recovers the twelve chat tables,
  eleven Actors and eight chat-owned R2 objects into a fresh placement, then
  creates and continues another nested fork. Repeated restore returns the same
  receipt. The current menu room and its accepted human edits also survive.
  Organisation identities, memberships, policy and inference configuration remain
  prerequisites of the existing account restore lifecycle.

The [live Worker acceptance report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/live-worker-acceptance-2026-10-03.md)
records authenticated production Portal components against the actual local
Worker and native Pi/Codex harnesses. Both routes pass mid-conversation and nested
forks, independent continuation and Stop, ancestry navigation, reload, unsaved
workspace preservation and fresh browser readiness. The run fixed omitted
public attachment parts and a late harness failure that overwrote cancellation.
Three focused Worker E2Es, 2,424 platform tests, 51 onboarding checks, types and
Portal build pass. Earlier fixture browser evidence retains its original labels.

Integrated browser file upload remains blocked by Chrome's disabled file-access
permission; confirmation is pending. Actual multipart admission, media
inheritance and restore pass through Worker E2Es. Production rollout and its smoke
check follow the remaining integrated file acceptance. Plan 42H remains open
for those release checks.

The [current room acceptance report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/current-room-acceptance-2026-10-03.md)
records six passing focused E2Es, 2,424 passing platform tests with three skipped,
51 onboarding checks, and platform/test type checks. All 39 checks in the three
previously failing chat fixture files also pass in the current shared checkout.
The earlier failure record below remains historical evidence.

The new `menu_draft_read` capability reads the existing Organisation-owned room without
creating or modifying it. A fork sees a human move to order 7 at revision 3;
its nested fork sees a later move to order 11 at revision 4 through Code Mode.
Revocation between discovery and execution refuses the next read. Two live Yjs
clients converge, and all fork operations leave the room unchanged. The read
capability is disabled by default and requires explicit policy and grant setup.

Two-tab creation, independent drafts/continuation, reload, keyboard activation,
ancestry focus, and unsent page work pass using the production Portal with a
deterministic API fixture. Exact scroll preservation passes at 1568px, with the
selected chat URL and reload identity verified. Concurrent Stop isolation passes
through the Actor/API journeys on both routes.

Next release steps:

1. Complete integrated browser file upload and inherited-file continuation on
   the authorized native Pi and Codex routes after resolving Chrome file-access
   permission. The remaining native browser behaviors pass in the live report.
2. Complete production rollout and repeat the smoke journey. No deployment was
   performed during local implementation or acceptance.

The [current connected acceptance report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/connected-acceptance-2026-10-03.md)
records six passing focused E2E checks, platform/test types, and 51 onboarding
closure checks. It found and fixed dropped attachments in direct Case admission.
It also carries required sharing state through conversation recovery and updates
fixtures for busy project moves and personal archive revision semantics.
The final recheck repaired a shared-chat save SQL predicate and retry-text
narrowing in queued draft cleanup.
The [earlier acceptance report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/acceptance-closure-2026-10-03.md)
records browser evidence, the native Pi canary, and the Portal build.
Cross-Actor compacted-source cutoffs now pass, as do refused missing/corrupt
prefixes and unsettled-tool-bundle refusal. Testing found and fixed history-menu
URL/scroll restoration and inherited image loss during Pi compaction. The earlier
identity setup and type-check blockers are resolved. No deployment was performed.

### Lifecycle and UI follow-up

Attachment collection now includes prepared and ready fork bundles in its
complete reference inventory. Corrupt fork history skips collection for that
organisation. User-input and inline tool-result attachment references are retained.
The E2E fixture uses real D1 and R2 with a fork as the file's sole owner; it proves
orphan removal, retention before publication, ready-history restoration,
missing-file rejection, unresolved tool-pair rejection, conservative behavior
on a bad digest, and file collection after fork erasure.

The concurrent source/descendant journey now holds both model turns open,
stops the source through the chat API, verifies the descendant remains running,
and lets it finish. A late source completion cannot create an eligible response
binding. The deterministic Codex bridge now pauses the actual turn-poll path.

Browser inspection found and fixed overlapping assistant actions. Fork controls
now occupy a visible wrapping row. Fresh branch-point links focus the selected
response; keyboard navigation reaches Fork from here. Retry identity remains
stored until destination navigation succeeds. The
[UI screenshot](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/keyboard-fork-preview.png) uses
the development preview's synthetic chat data and does not establish backend
fork acceptance.
