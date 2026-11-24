# FND-03 — Cases, Sessions and conversations

A Case is one body of related work in Purin Pantry, and it does not depend on a
provider. A Connector brings provider messages in and sends answers out. A Session is
one Sous Chef agent that works in one Case. A Project groups the Cases of an
Organisation. A Portal chat, a Slack thread, an email thread and a WhatsApp conversation
are each one presentation of a Case. A person can fork a Portal chat at an earlier
answer. An agent can propose separate work as a side Case, and a person starts it. Cues
and schedules open Cases with no person.

## What it does

### The ownership chain

| Owner                           | Owns                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Connector Actor (`ConnectorDO`) | The provider event identity, the Case work queue, delivery, retries and provider receipts                                     |
| Case Actor (`CaseDO`)           | The Case purpose, the shared journal, the revision, bindings, assignments, accepted proposals, the goal and the output outbox |
| Session Actor (`SessionDO`)     | One agent in one Case: its private history, budget, checkpoint and turn                                                       |
| Regional D1                     | Projects, the Case to Project association, Portal conversations, forks and side Case proposals                                |

- One Session belongs to one Case and never changes its Case. Only the Case appends
  shared history and addresses output.
- A Slack thread has one Case (`deriveSlackCaseRouteIdentities`). Each turn runs in the
  Session and the assignment of its authority partition: `partitionSlackTarget` adds
  `_authority_` and the first 24 characters of the partition digest to the two ids.
- The partition key of a channel holds the Organisation role of the requester and the
  membership revision (`AuthorityPartitionKey`). The key of a DM also holds the person.
  Thus one thread can have more than one Session and more than one assignment.
- One Connector serves one Slack integration account.
- A Portal chat has one Case. Each step of a chat request runs in a new Session of that
  Case (`conversationStepIdentity` in `chat/turn/run.ts`).

### Ingress and triggers

```text
signed Slack event -> Slack ingress Worker or Platform Worker: verify the signature
  -> ConnectorDO.admitSlackCaseWork: durable admission, then the acknowledgement
  -> CaseDO.prepareOngoingTurn: accept the trigger one time
  -> SessionDO: initialise or restore, then run the turn
  -> ConnectorDO: stream the answer into the thread
```

- The Connector removes repeated events by their native identity. It admits the work
  before Slack gets the acknowledgement, and it starts the work at once.
- One Connector runs the turns of at most four Cases at one time. The messages of one
  Case run one after another.
- A message that arrives while a turn of its Case runs can join that turn as a steering
  input. The Connector holds it in `connector_case_steering` until the turn ends. If
  the turn read it, the Session asks the Case to write the journal entry
  `steer:<inputId>` (`acceptSteeringInput`), and the Case revision does not change. If
  not, the message returns to the queue as the next turn.
- A Slack turn can schedule a follow-up (`schedule_follow_up`), at most 10,080 minutes
  ahead. It runs at its time as Case work, as a message does. A Case holds at most
  three follow-ups that wait, and one more answers `limit_reached`.
- A `CaseTrigger` has the source `connector`, `cue` or `api`. The Case accepts one
  trigger id one time. A repeated trigger returns the accepted one.
- A Case with an open approval reads the action ledger before it accepts a trigger. If
  the Case still waits, it refuses the trigger (`case_waiting_for_approval`).
- A cue, a schedule or the API can open a Case with no Connector. The route
  `POST …/cases/commands` opens a Case from one instruction of at most 8,000 characters.
- `CaseContent` is `user_message`, `record_message`, `text`, `artifact`,
  `commerce_reference` or `entity_plane_proposal`. A `record_message` keeps the message
  and its source provenance together. The Case refuses a `record_message` or a
  `commerce_reference` whose provenance does not parse (`parseSourceProvenance`).

### Assignments, proposals and shared history

- An assignment names the Case revision, the Session, a role (`coordinator` or
  `specialist`), an objective, an authority, a budget and a `CaseContextSnapshot`.
- The snapshot is immutable. Its evidence dependency is `source_only` or one
  `case_context_collection_evidence` revision with its policy revision, its recipient
  digest and its dependency digest.
- An assignment moves `assigned -> running -> settled`. An abandon move also settles an
  assignment that is still `assigned`, with the start id
  `start_abandoned_<assignmentId>`. A settled assignment is `completed` (with its
  proposal), `cancelled`, `failed`, `budget_exhausted` or `abandoned` (`never_started`
  or `session_quiescent`).
- The Case abandons an assignment that nothing moved for 30 minutes. First the Session
  must prove that it runs no turn. A Case that waits keeps its assignments.
- An installed agent's assignment has a `case_assignment_pin` row: the installation,
  its revisions, the skills, the granted capabilities and the token limit.
- A proposal entry is an `observation` or a `shared_change`. The Case stores an
  `accepted` answer and a `rebase_required` answer, and a repeated proposal returns the
  stored answer. The Case does not store a `rejected` answer: it decides a repeated
  rejected proposal again. The same proposal id with other content fails
  (`case_proposal_conflict`).

| `SessionProposalDisposition` | Meaning                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `accepted`                   | The Case appended the entries, made a new revision and addressed the outputs                                          |
| `rebase_required`            | A `shared_change` named a revision that is not the current one                                                        |
| `rejected`                   | `assignment_missing`, `assignment_mismatch`, `session_mismatch`, `empty_proposal`, `invalid_entry` or `case_not_open` |

A Case lifecycle (`CaseLifecycle`) is `open`, `waiting` or `quarantined`. The only wait
is an `approval` wait. A stored lifecycle with another value does not parse, and the Case
reads as corrupt. A commerce proposal that a person must review moves the Case from
`open` to `waiting` with an `approval` wait. The action nonce is the approval request identity. While the
Case waits, it accepts only observations with no requested effect. The action ledger of
the Organisation decides, and the Case returns to `open`. The Case alarm reads the
ledger if the update is lost. If the caller gives an approval notice, only a Case with
one `slack` or `slack_channel` binding sends it, to its thread. A Portal chat shows the
approval card instead.

A Case can hold one goal: an objective and a token budget, in the state `active`,
`paused`, `budget_limited`, `completed` or `cleared`. An Organisation owner or admin
reads and changes it with a `goal …` message in a Slack thread, or through the goal
route of a Portal chat. The Case answers a Slack goal message itself, as an
`operator_command` output. A Session asks the Case to admit each goal operation and
then reports its usage (`actors/session-goal-usage.ts`).

### Output and delivery

- A `CaseBinding` holds a Connector and a `ConnectorAddress`: `slack` (a thread),
  `slack_channel`, `email_thread` or `whatsapp_conversation`.
- With no binding, the Case makes no output. With one binding, the output goes there.
  With more than one, the Case refuses the output (`case_output_binding_invalid`).
- An output source is `agent_turn`, `commerce_outcome`, `operator_command` or
  `commerce_approval_notice`. The journal entry and its `case_output` row commit in one
  transaction. The output holds the full delivery, so delivery needs no Case read.
- `ConnectorDO.deliver` sends a `pending` output. The delivery receipt goes to
  `CaseDO.acceptDeliveryReceipt`, and it settles only the output that it names.

| Output state | Meaning                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `pending`    | The answer waits for its delivery                                              |
| `held`       | The exit check stopped the answer, and a person decides (FND-07)               |
| `settled`    | The conversation received the answer                                           |
| `dropped`    | A person denied it, nobody decided in time, or nothing delivered it in one day |
| `rejected`   | The provider refused the delivery permanently                                  |

- A Connector delivery is `sending` (under a lease), `retryable`, `delivered` or
  `rejected`. For a streamed Slack answer, each part waits until the information-flow
  binding of the turn passes the destination check.
- Case, Session and Connector each restore their state from their own SQLite. The Case
  alarm runs five steps: context projections, the Portal conversation, outputs that
  nothing delivered, the approval wait and stopped assignments. It retries stored work
  each 15 s. It reads the ledger for an approval wait each minute for the first 10
  minutes, then each 15 minutes, for at most 10 approvals in one alarm.
- A Connector Case work item is `pending`, `running` or `retryable`. After five
  attempts, the Connector tells the thread that the message did not run. At most three
  more claims can post this notice.

### Projects

- Each Project belongs to one Organisation. Each Case belongs to one Project
  (`case_project`). A move changes the association and its revision. It does not change
  the Case identity, the Actor address or the provider binding.
- A Project is `personal` (one owner) or `shared` (members with the role `owner`,
  `editor` or `viewer`). Its content is a name, a brief and at most 12 references.
- Each Organisation has one default Project (`organisation_default_project`), an
  ordinary shared Project with the first name "Base". Organisation owners and admins
  are its owners, operators are its editors and viewers are its viewers.
- A Case with no named Project joins the default Project. The first accepted admission
  decides: a retry reads the same association after a change of the default. With no
  usable default Project, admission fails with `default_project_unavailable`.
- The Case origin (`origin_kind`) never changes: `portal_chat`, `canvas_chat`,
  `direct`, `slack`, `email`, `whatsapp`, `inbox_assistant` or `commerce_approval`.
- A Portal chat inherits the brief and the references of its Project only through the
  access of the member who sends the message. A Case from Slack, email, WhatsApp, a cue,
  a schedule or the API runs with no Project context. A move gives the agent of the
  Case nothing (`agentProjectContext: "none"`).
- A delete of a Project returns its private chats to the default Project. Shared chats
  (`project_contains_shared_chats`) and Cases that a source admitted
  (`project_contains_cases`) block the delete. The default Project cannot be deleted
  (`project_is_default`) until another shared Project replaces it.
- When a member leaves the Organisation, their private chats return to the default
  Project. If they were the only owner of a shared Project, another member becomes owner.
- When a member is removed from a shared Project, their private chats in that Project
  return to the default Project.

### Portal conversations

- A `portal_conversation` row names its Case and keeps no Project of its own. Its access
  is `private`, `shared` or `workspace_canvas`.
- The work of a conversation is `ready`, `running`, `cancelling`, `awaiting_permission`
  or `failed`. The Case holds one wake row while the work can move with no person.
- A running turn holds a lease of 15 minutes. A running chat queues at most eight
  messages, and one more answers `chat_queue_full`. A stored conversation holds at most
  960,000 bytes, or 1,000,000 bytes while its work is `failed`.
- A member's sidebar order, pin, archive state, read position and draft are personal
  records (`portal_conversation_user` and the `portal_chat_directory` tables).
- The chat list shows a pinned chat one time, in the pinned rows at the top, and not
  again in its Project. A pinned chat moves only through **Move to project** in its menu.
- A chat with a failed turn that can run again, or with queued messages, does not change
  Project (`chat_work_unfinished`, `case_work_unfinished`). A person can delete only an
  archived chat. The delete also erases each fork of it.

### Thread forks

1. A person selects **Branch in new chat** on a completed answer. The dialog of the
   same name asks for **In this workspace**. The client sends the message id and an
   operation id.
2. The server finds the accepted history up to that answer and makes its digest. It does
   not trust a message list from the browser.
3. The fork gets a new conversation, a new Case and the title "Fork of …". It is private
   to its creator and starts in the default Project.
4. The new chat shows **Continued from chat** with a link to the source answer. The
   source chat lists the forks of its reader (at most 50).

- A fork makes no model call and no tool call. The same operation id returns the same
  fork. The same id with another source or message fails (`idempotency_key_conflict`).
  The fork keeps the model route of the selected answer.
- The fork keeps the timeline and the history bindings up to the selected answer. It
  starts in a new Case with no queued input, no draft and the work state `ready`.
- Each read of a fork and each turn of a fork checks the inherited history for the
  reader (`authorizeForkHistoryAccess`, `admitChatForkInformationFlow`).
- A fork of a fork works. A fork writes only regional D1 rows: its `portal_chat_fork`
  receipt, the new conversation and the Project association of the new Case. A fork
  that cannot be made answers `failed` with a code, for example
  `chat_fork_boundary_unavailable` or `chat_fork_history_capacity`.

### Side Cases

- An agent calls `propose_side_case` with a title (1 to 80 characters) and a brief (1 to
  2,000 characters) for separate work that it found. The agent does not start that work.
- The proposal id is a digest of the Session, the turn, the title and the brief. A
  repeated call makes no second proposal. A source holds at most three open proposals,
  and a fourth call answers `side_case_not_proposed`.
- A proposal is `open`, `starting`, `started` or `dismissed`. An open proposal reads as
  `expired` after seven days. A start that stops reads as `open` again after 10 minutes.
- Each turn of a side Case gets one more harness instruction: approvals and effects in
  the other chat or thread do not authorize actions here.

In a Portal chat:

- The chat read returns `sideCases`, at most 20, newest first. Each is a card in the
  timeline. A reader who may not receive the output of the proposing turn sees no card.
- **Start in a subthread** makes a new private chat for the starter. Its title is the
  proposal title, and its first message is the brief. It has no history of the parent.
  It goes to the Project of the parent when the starter can read it there. If not, it
  goes to the default Project.
- **Do it here** sends the brief as the next message of the parent chat, with the
  request id `side_case_here_<proposalId>`, and then dismisses the proposal.
- The sidebar shows a side Case one level below its parent, when the parent is in the
  same list. The chat shows **Proposed in** with a link to the parent.
- A delete of the parent deletes its `open` and `dismissed` proposals. A `starting` or
  `started` proposal row stays, and each started side Case stays. The side Case then
  shows no link to its parent.

In Slack:

- The Connector posts the title, the brief and a **Start** button in the parent thread.
  Slack sends the click to `/slack/interactions`. Pantry verifies the signature and asks
  that Connector to start the side Case.
- The start posts a new top-level message in the same channel, pins that thread to a new
  Case and queues the brief as its first work (event id `sidecase_<proposalId>`).
- The parent thread gets one line with a link, and the proposal message loses its
  button. A refusal goes only to the person who clicked. A Slack proposal has no dismiss.

### Cues and schedules

```text
Stripe or Shopify webhook, or OrganisationDO.applyCommerceDelivery
  -> CUE_Q "cue.event.v1" -> compiled snapshot (POLICY_KV) -> match
  -> OrganisationDO.claimCueDelivery
  -> processDirectCaseCommand (trigger source "cue")
  -> assignment and proposal -> Case outbox -> Slack channel
```

| Source     | Event types                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe`   | `charge.failed`, `invoice.payment_failed`, `refund.failed`, `customer.subscription.deleted`                                                                                        |
| `shopify`  | `orders/create`, `inventory_levels/update`                                                                                                                                         |
| `commerce` | `payment_failed`, `inventory_shortage`, `inventory_low_stock`, `order_unshipped`, `tracking_stalled`, `delivery_exception`, `cancellation_refund_proposed`, `entity_plane_changed` |

- A `cue_subscription` row is one rule: a source and an event type, a Slack scope, a
  debounce time, a maximum for each hour and an action. The enabled rows go to
  `POLICY_KV` as one snapshot (`cue:<organisationId>:latest`). The match reads only this
  snapshot and makes no model call.
- `claimCueDelivery` answers `claimed` (with a lease), `duplicate`, `in_progress` or
  `suppressed` (`debounce` or `max_per_hour`). One event and one subscription make at
  most one Case trigger. The Case gets a `slack_channel` binding from the Slack scope of
  the subscription. A cue never takes a destination from model output.
- A `cue_binding` row can name an agent installation and instructions for one event
  type. An inventory cue opens a coordinator Session and a specialist Session. Other
  cues open one coordinator. The principal is the system component `cue_engine`.
- An event that matches nothing makes no Case and no row. It adds to a counter in KV.
  `cue_log` is an audit record only: `matched`, `store_only` and `proposed`.
- A `schedule_binding` gives an hourly, daily or weekly window. The cron of each 15
  minutes claims each due window in D1 and sends one `agent_schedule.dispatch.v1`
  message to `EVENT_Q`. Pantry does not fill a window that it missed.
- A scheduled run opens a Case with no binding and writes a `schedule_dispatch_receipt`.

## Contracts

- **Actors** (`workers/platform/src/actors/`): `CaseDO` over `CaseActor` (`case.ts`,
  `case/case-actor.ts`, binding `CASE`), `ConnectorDO` (`connector.ts`, `connector/`,
  binding `CONNECTOR`) and `SessionDO` (`agent-session.ts`, binding `SESSION`).
- **Case SQLite** (`case-schema.ts`, version 2): `case_meta`, `case_trigger`,
  `case_binding`, `case_assignment`, `case_proposal`, `case_commerce_proposal`,
  `case_commerce_approval`, `case_email_proposal`, `case_journal`, `case_output` and
  `case_context_projection_outbox`. The Case also holds
  `portal_conversation_execution` (`chat/execution.ts`) and the `case_goal` tables.
- **Connector SQLite**: `connector_meta`, `connector_ingress`, `connector_delivery`,
  `connector_case_work`, `connector_case_work_receipt`, `connector_case_native_message`,
  `connector_case_steering`, `connector_parked_case_work` and `connector_side_case`.
  **Organisation SQLite**: `cue_delivery` (`actors/cue-delivery.ts`).
- **Regional D1** (`workers/platform/migrations-regional/0001_current_schema.sql`):
  `project`, `project_member`, `project_operation`, `project_access_operation`,
  `organisation_default_project`, `case_project`, `portal_conversation`,
  `portal_conversation_user`, `portal_chat_directory`, `portal_chat_directory_project`,
  `portal_chat_directory_operation`, `portal_chat_conversation_access_operation`,
  `portal_chat_deletion`, `portal_chat_fork`, `side_case_proposal`,
  `session_turn_access`, `case_assignment_pin`, `cue_subscription`, `cue_binding`,
  `cue_log`, `schedule_binding` and `schedule_dispatch_receipt`. **Global D1**:
  `slack_thread_case_pin` (the Slack surface owns it).
- **Case RPC** (`case/case-actor.ts`): `ensure`, `acceptTrigger`, `prepareOngoingTurn`,
  `prepareDirectTurn`, `acceptSteeringInput`, `attachBinding`, `assignSession`,
  `beginAssignment`, `settleAssignment`, `abandonAssignment`, `assignmentLifecycles`,
  `acceptSessionProposal`, `acceptDeliveryReceipt`, `holdOutput`, `rejectOutput`,
  `dropHeldOutput`, `noteRefusedEffect`, `scheduleConversation`,
  `quiesceConversationExecution`, `read`, `readTail`, `readMetadata` and `inspect`.
- **Case RPC for commerce**: `acceptCommerceProposal`,
  `acceptCommerceEntityPlaneProposal`, `readAcceptedCommerceEntityPlaneProposal`,
  `waitForCommerceApproval`, `readCommerceApprovalNotice`, `resolveCommerceApproval`,
  `syncCommerceApprovalWait` and `acceptCommerceOutcome`. **For goals**:
  `acceptGoalMessage`, `readGoal`, `applyGoalCommand`, `bindGoalExecution`,
  `closeGoalExecution`, `admitGoalOperation` and `acceptGoalUsage`.
- **Connector RPC** for Case work and Slack (`connector.ts`): `acceptIngress`,
  `acceptCaseWork`, `admitSlackCaseWork`, `recoverCaseWork`, `scheduleSlackFollowUp`,
  `parkSlackPermission`, `noticeSlackPermission`, `releaseSlackPermission`,
  `parkSlackSideCase`, `postSlackSideCaseProposal`, `startSlackSideCase`, `deliver`,
  `deliverApprovedOutput`, `invalidateCaseContextCollectionEvidence` and `inspect`.
- The two lists leave out the Actor framework methods (activation, quarantine, export,
  census and the alarm, FND-02) and `listReachableAttachmentObjectKeys`. They also
  leave out the methods that `CaseDO` adds in `case.ts` (email proposals and execution
  records) and the email, WhatsApp and eval methods of `ConnectorDO`.
- **Types**: the Case and Connector types in `packages/contracts` (`CaseLifecycle`,
  `CaseTrigger`, `CaseAssignment`, `SessionProposal`, `ConnectorAddress`). `projects.ts`,
  `project-access.ts`, `chat-forks.ts` and `chat-side-cases.ts` are in
  `packages/control-api/src/`.
- **Queue messages**: `cue.event.v1` on `CUE_Q`, `agent_schedule.dispatch.v1` on
  `EVENT_Q`. **Capability**: `context.case.read` (`capability-catalogue.ts`). A fork and
  a side Case start need it for the inherited content.
- **Agent tool**: `propose_side_case` (`agent-tools/turn/turn.ts`, effect `proposal`,
  direct call only). The turn origin selects it, not a capability: a Portal chat turn
  that a message started, or a Slack thread turn (`turnMayProposeSideCase`).

The control routes are under `/v1/control/organisations/:id`. Each needs the
Organisation role admin. Each change also checks the Project or chat role, with two
exceptions: `POST /cases/commands` checks only the Organisation role, and
`create_project` needs only an active member.

| Route                                                                    | Purpose                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `GET`, `POST /projects`                                                  | The catalogue; `create_project`, `edit_project`, `delete_project`, `set_default_project`         |
| `GET /projects/references`, `GET /projects/:projectId/cases`             | Search for a reference; the Cases of one Project (at most 200)                                   |
| `GET`, `POST /projects/:projectId/access`                                | Members; `share_project`, `set_project_member`, `remove_project_member`                          |
| `GET`, `POST /cases/:caseId/project`                                     | Read the association; `move_case`                                                                |
| `POST /cases/commands`                                                   | Open a Case from one instruction                                                                 |
| `GET`, `POST /chat/projects`                                             | The personal sidebar; `set_project_placement`, `move_chat`                                       |
| `POST /chat/projects/chats`                                              | Start a new chat in a Project                                                                    |
| `PATCH /chat/conversations/:id`                                          | The actions `fork`, `delete`, `rate_response`, `rename`, `archive`, `restore`, `pin` and `unpin` |
| `GET`, `POST /chat/conversations/:id/goal`                               | Read the goal of the chat's Case; a goal command                                                 |
| `GET`, `POST /chat/conversations/:id/access`                             | `share_conversation`, `move_shared_conversation`                                                 |
| `POST /chat/conversations/:id/side-cases/:proposalId/start`, `…/dismiss` | Start or dismiss a side Case                                                                     |

The main code: `workers/platform/src/` with `actors/case/`, `actors/connector/`,
`actors/case-direct-processing.ts`, `projects/`, `chat/store.ts`, `chat/forks.ts`,
`chat/side-cases.ts`, `chat/side-case-start.ts`, `actors/connector-side-case.ts`,
`cues/`, `gateway/cue-delivery.ts`, `schedules/` and `surfaces/portal/ui/features/chat/`.

## Rules and limits

| Action                                                             | Who can do it                                                                                                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Use the Portal chat, the Project routes and the Case command route | Organisation admin and owner; a canvas chat needs operator                                                                               |
| Edit the content of a Project                                      | Its personal owner, or an owner or editor of a shared Project                                                                            |
| Move the Case of a chat                                            | The owner of a private chat, while it is idle. A shared chat moves only through the share command (`case_move_requires_audience_review`) |
| Move a Case that a source admitted                                 | An Organisation admin, into a shared Project that they own or edit, or to the default                                                    |
| Replace the default Project                                        | An Organisation owner or admin, with a shared Project that they own                                                                      |
| Fork a chat                                                        | A member who can read the full inherited history                                                                                         |
| Start or dismiss a Portal side Case                                | A person who can send messages in the parent; a viewer cannot                                                                            |
| Start a Slack side Case                                            | A linked member with the role owner, admin or operator; in a DM only its person                                                          |
| Propose a side Case                                                | The agent only. No agent starts one or returns its result to the parent                                                                  |

| Limit                                                | Value                                                                       | Constant                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Assignment with no movement                          | 30 minutes                                                                  | `ASSIGNMENT_ABANDON_AFTER_MS`                                                                             |
| Pending output with no delivery                      | 24 hours                                                                    | `UNDELIVERED_OUTPUT_TTL_MS`                                                                               |
| Connector delivery lease, retry                      | 30 s, 5 s                                                                   | `DELIVERY_LEASE_MS`, `DELIVERY_RETRY_MS`                                                                  |
| Case alarm retry of stored work                      | 15 s                                                                        | `CASE_RECOVERY_INTERVAL_MS`                                                                               |
| Ledger read for an approval wait                     | Each minute for 10 minutes, then each 15 minutes; 10 approvals in one alarm | `APPROVAL_READ_FIRST_MS`, `APPROVAL_READ_FIRST_WINDOW_MS`, `APPROVAL_READ_LATER_MS`, `APPROVAL_READ_PAGE` |
| Cases that one Connector runs at one time            | 4                                                                           | `CASE_WORK_CONCURRENCY`                                                                                   |
| Case work lease, attempts, notice claims             | 120 s, 5, 3                                                                 | `CASE_WORK_LEASE_MS`, `CASE_WORK_MAX_ATTEMPTS`, `CASE_WORK_NOTICE_ATTEMPTS`                               |
| Slack follow-ups that wait for one Case, latest time | 3, 10,080 minutes                                                           | `MAX_PENDING_FOLLOW_UPS`, `MAX_FOLLOW_UP_MINUTES`                                                         |
| Chat turn lease, queued messages                     | 15 minutes, 8                                                               | Literals in `chat/application.ts` and `chat/turn/admission.ts`                                            |
| Stored conversation                                  | 960,000 bytes; 1,000,000 bytes while the work is `failed`                   | `CONVERSATION_PROJECTION_BYTES`, `CONVERSATION_STORAGE_BYTES`                                             |
| Wait for a permission in a chat                      | 24 hours                                                                    | `PERMISSION_WAIT_MS`                                                                                      |
| Fork history with its conversation                   | 1,800,000 bytes                                                             | `FORK_HISTORY_BYTES`                                                                                      |
| Side Case: open proposals, lifetime, start lease     | 3, 7 days, 10 minutes                                                       | `SIDE_CASE_OPEN_LIMIT`, `SIDE_CASE_LIFETIME_MS`, `SIDE_CASE_START_LEASE_MS`                               |
| Cue claim lease, abandoned claim                     | 30 s, 15 minutes                                                            | `CUE_DELIVERY_LEASE_MS`, `CUE_CLAIM_ABANDONED_AFTER_MS`                                                   |

- **Information flow.** A side Case proposal stores the flow binding of its turn. Each
  turn of the side Case admits it as an observation (`organisation_record`
  `side_case:<proposalId>`) before inference. A fork admits each inherited binding in
  the same way (`chat_fork:<sessionId>:<turnId>`).
- A card, a start, a read and a share of a side Case each check the binding for the
  reader (`decideChatFlowDelivery`, `authorizeSideCaseAccess`,
  `authorizeSideCaseChatRead`). A denied start answers `side_case_not_found`.
- A Slack proposal post passes `decideCaseConversationSink`. The posts of a start pass
  `decideStoredFlowConversationSink` with the live authority of the starter. No content
  of a side Case returns to the parent.
- A private Case in a shared Project stays private. Project lists show a Case with no
  title and no preview.
- A new Organisation member joins the default Project automatically only while it holds
  no shared Case and no reference. After that, an owner uses the access command.
- A cue turn runs with a `workflow` request authority (`buildWorkflowAuthority`). It
  holds the Organisation, the subscription id and the subscription version. It names no
  person and no role.

**Out of scope:** a `ProjectActor`; nested Projects; a Case in more than one Project;
moves between Organisations; external guests; an edit of an old message; a merge of
forks; a fork tree view; a side Case that starts with no person or in another Slack
channel; side Cases for email, WhatsApp, canvas chats and scheduled turns.

**Boundaries:**

- FND-02 owns Actor activation, placement, the alarm framework and quarantine. FND-04
  owns the harness, model routes and the Session checkpoint. FND-05 owns typed messages,
  attachments and automatic context.
- FND-06 owns identity and approval. FND-07 owns the exit check and held outputs
  (`held_output_request`). FND-09 owns the agent tool catalogue. FND-10 owns shared rooms.
- INB-01 owns the email and WhatsApp Connector parts. COM-03 owns the commerce
  projections that make commerce cues. PRT-01 owns the Portal pages. The Slack surface
  owns signatures, thread pins and Slack posts.

## Open work

- The Case has no `transition` command, and no Case completes. A plan that builds Case
  completion adds its states to `CaseLifecycle`. No Case code writes `quarantined`.
- No agent holds access to a Project, and a move does not go through the Case Actor.
- The Project view lists a source-admitted Case with its origin only, with no link to
  its source.
- Refactor 9 names two journeys that are not built: a provider reply that uses Project
  context, and provider continuity after a move.
- No result of a side Case returns to its parent. The browser journey
  (`scripts/plan-74/browser-side-case.js`) does not drag a side Case out of its nest.
- The Slack journeys (`slack-side-case.test.ts`, `slack-side-case-dm.test.ts`) cover no
  proposal that the channel cannot show, and no start whose label no longer reaches the
  channel.
- `scripts/slack/pantry-public-manifest.json` has no interactions address. Only
  `scripts/slack/pantry-dev-manifest.json` has one.
- The cue sources are only `stripe`, `shopify` and `commerce` (`CueSource`), so no cue
  comes from Case or Session state (stale work, a pending approval). The subscription
  parser accepts only `tier` 1, so ambient scoring (Tier 3) is not built.
- The information-flow guide does not name the side Case entry points.

## Sources

- [Plan 15](../../history/plan-15.md), with its
  [closure record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-15-closure-2026-08-03.md).
- [Plan 42H](../../history/plan-42H-thread-forking.md), with its
  [acceptance record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/README.md),
  [live Worker report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/live-worker-acceptance-2026-10-03.md),
  [browser upload report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42H-thread-forking/browser-upload-fork-codex-2026-10-28.md).
- [Plan 74](../../history/plan-74-side-cases.md), with its
  [browser evidence](https://github.com/seams-tech/pantry-history/tree/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-74/browser/).
- [Refactor 9](../../history/refactor-9.md), with its
  [evidence report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-9/README.md).
- [Runtime architecture](../../architecture/runtime.md), sections "Case coordination
  and connector delivery" and "Cues and proactive work". Where a source differs from the
  code, this spec follows the code. The checks are in the
  [information-flow guide](../../../foundation/authority/policy/information-flow/README.md).
- E2E journeys in `workers/platform/tests/e2e/`: `case-command-recovery.test.ts`,
  `case-undelivered-output.test.ts`, `case-projection-outbox.test.ts`,
  `slack-connector-admission.test.ts`, `slack-concurrent-cases.test.ts`,
  `slack-streamed-answer.test.ts`, `slack-held-output.test.ts`, `projects.test.ts`,
  `project-cases.test.ts`, `project-sharing.test.ts`, `project-ifc.test.ts`,
  `chat-execution.test.ts`, `chat-shared-runtime.test.ts`, `chat-fork-connected.test.ts`,
  `chat-fork-retention.test.ts`, `chat-steering-fork.test.ts`, `chat-side-case.test.ts`,
  `chat-side-case-ifc.test.ts`, `slack-side-case.test.ts`, `slack-side-case-dm.test.ts`,
  `cue-claim-sweep.test.ts`, `schedule-runs.test.ts` and `idle-tenant-cost.test.ts`.
  The browser journey of side Cases is `python3 scripts/plan-74/run-browser.py`.
