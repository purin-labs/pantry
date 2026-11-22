# Plan 74 — Side Cases

Status: Phase 1 (Portal) and Phase 2 (Slack) are in production since the
whole-dev release of 2026-10-20 02:17 UTC
(`refs/backup/released-2026-10-20-plan-74-whole-dev`). The live Slack journey
passed in production on 20 October 2026. Date: 19 October 2026. Updated: 27 October 2026.
Owners: Satyr platform and Portal.

## Outcome and scope

While an agent works on a request, it can find other work: a fault, wrong
data, a missing setup step or a task for later. The agent can propose that
work as a **side Case**. A side Case is a new Case that an agent proposes
from another Case (its **parent**) and that a person starts. The agent does
not start it.

In the Portal, the proposal is a card in the parent chat. A person clicks
"Start in a subthread", and a new chat starts with the agent's brief as its
first message. The sidebar shows the new chat under its parent. "Do it here"
sends the brief as the person's next message in the parent chat instead. In Slack, the
proposal is a message in the parent thread, and the side Case is a new
thread in the same channel.

In scope:

- Portal chats (Phase 1).
- Slack threads (Phase 2).

Out of scope:

- A side Case that starts without a person. Each started side Case costs
  model turns that the organisation pays for, and an operator must not get
  Cases that nobody asked for.
- A result that returns to the parent. The parent shows the side Case's
  state and a link, not its content. A return path widens a label (see
  [Information-flow contracts](#information-flow-contracts)).
- A side Case with the parent's full history. A person can fork the chat
  for that today.
- Email, WhatsApp, workspace canvas chats and scheduled turns.
- Sidebar nesting for forks.

This is not the subagent feature that
[Plan 57](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-57-live-delivery.md) kept out of scope. A side Case is a
normal Case with its own requester, authority and budget. No turn waits for
it, and it reports to nobody.

## Starting state

- No agent tool creates a Case, a chat or a thread. The agent tools that
  propose work are `propose_memory` (reviewed in Brain),
  `request_permission` (a modal), `slack_message_propose` and
  `email_operational_propose` (cards in the chat). `schedule_follow_up`
  returns to the same Slack thread and is offered on Slack thread turns
  only.
- A person can fork a Portal chat at an assistant message (`forkChat` in
  `chat/forks.ts`). The fork row in `portal_chat_fork` keeps the inherited
  history and its flow bindings. Every turn of the fork reads that history,
  checks it with `authorizeForkHistoryAccess` and admits it with
  `admitChatForkInformationFlow`. The new chat shows "Continued from chat",
  and the source chat lists its forks above its messages, not in the
  sidebar.
- `Conversation.lineage` is `original` or `fork`
  (`packages/control-api/src/chat-forks.ts`).
- A fork starts in the default Project. `writeConversation` in
  `chat/store.ts` takes an `initialDestination` Project, but no caller
  passes one.
- Draft cards in the chat are timeline inserts (`ChatTimelineInsert`), not
  timeline events. The chat read returns their data (`emailReviews`,
  `slackDrafts`), and `renderChatTimeline` merges them by time.
- The sidebar (`features/chat/organizer.tsx`) shows Pinned, then one
  section for each Project. It has no nesting.
- Deleting a chat erases its forks, also the forks of other users
  (`eraseForkDescendants` in `chat/deletion.ts`).
- Slack: ingress ignores messages from bots. A thread becomes a Case only
  when a person's first message in it claims a `slack_thread_case_pin`, and
  a reply needs that pin. So a thread that Satyr starts cannot be a Case
  today.
- Slack has no handler for interactive buttons. Approvals for Slack turns
  happen in the Portal, through a link.
- The Slack destination check (`decideCaseConversationSink`) compares the
  channel, not the thread. So a new thread in the parent's channel passes,
  and another channel fails.

## Implementation decisions

### 1. The `propose_side_case` tool

The agent calls `propose_side_case` with:

- `title`: 1 to 80 characters. It becomes the title of the new chat.
- `brief`: 1 to 2,000 characters. It is the first message of the new Case,
  so it must stand alone: what is wrong, the evidence and the expected
  result.

The tool description tells the agent to use it for separate work that it
found, not for the work that the person asked for, and not to do that work
in the current turn. The agent tells the person in one line that it
proposed a side Case. The chat prompt (`chat/prompt.ts`) gets one line, as
for `propose_memory`.

The turn's origin selects the tool, not a capability grant, as for
`propose_memory`. It is offered on Portal message turns of private and
shared chats (Phase 1) and Slack thread turns (Phase 2). The requester
must be a person who may send messages in the parent. It is a direct call,
outside Code Mode. Pi replay treats it as the other proposal tools
(`RERUN_BY_ANY_CALLER` in `pi-tool-replay.ts`).

In a large catalogue the model finds the tool through `tool_search`, as it
finds `propose_memory`: only `tool_search`, `codemode` and
`request_permission` are enabled before a search. A canvas chat's turn is
offered the tool too, and the call answers that a canvas chat cannot hold
proposals.

The proposal id is a digest of the Session, the turn, the title and the
brief, so a replayed call makes no second proposal. A parent Case holds at
most three open proposals. A fourth call returns
`side_case_not_proposed` with the reason `limit_reached`. A refusal is a
result, not an error.

### 2. The proposal record

A new D1 table `side_case_proposal` keeps each proposal of both surfaces:

- `organisation_id`, `proposal_id` (primary key);
- `source_kind`: `portal_chat` or `slack_thread`;
- `source_case_id`, `source_session_id`, `source_turn_id`;
- for a Portal chat: `source_conversation_id`, `requested_by_user_id`;
- for a Slack thread: `source_connector_id`, `source_workspace_id`,
  `source_channel_id`, `source_thread_ts`, `requested_by_person_id`;
- `title`, `brief`, `content_digest`;
- `flow_binding_json`: the turn's flow binding at the tool call;
- `status`: `open`, `starting`, `started` or `dismissed` (a Slack proposal
  has no Dismiss);
- `destination_case_id` (unique), and `destination_conversation_id` for a
  Portal chat or `destination_thread_ts` for a Slack thread;
- `decided_by_user_id`, `decided_by_slack_user_id` (Slack only),
  `created_at`, `decided_at`, `expires_at`.

`CHECK` constraints keep the columns of each kind complete, and the columns
of the other kind empty. A proposal expires seven days after it was made.
The read computes the expiry, so no alarm is needed. The table goes into the
regional `migrations/0001_current_schema.sql`, next to `portal_chat_fork`.

Phase 1 made the table with `NOT NULL` chat columns, and its patch is
applied in production. SQLite cannot make a column nullable in place, so the
Phase 2 patch `scripts/plan-74-slack-side-case-d1-patch.sql` rebuilds the
table: it copies each row as a Portal chat proposal into the new shape. The
production table had no rows, and neither phase was released, so the
rebuild was chosen over a second table on 2026-10-19. Each turn then reads
one table for its side Case origin (`readSideCaseOrigin`).

### 3. The card in the parent chat

The chat read returns a new field `sideCases`. The Portal renders each
proposal as a timeline insert at its time, as it renders draft cards. The
card shows the title and the brief, and one of these states:

- **Open:** "Start in a subthread" and "Do it here". "Do it here" sends the
  brief as the person's next message in this chat, then closes the
  proposal through the dismiss route. It waits while the agent answers.
  Its request identity is `side_case_here_{proposalId}`. Retries use the same
  brief without composer files or browser context. Chat admission deduplicates
  that identity. After reload or renderer failure, accepted chat history
  restores **Finish here**, which retries only dismissal. The start route
  refuses a subthread when the source chat already accepted this brief.
- **Started:** "Open chat" for the person who started it. Other readers
  see "Started".
- **Dismissed** (shown as "In this chat") or **Expired:** the title and
  the state only, with no action.

A person who may send messages in the parent can start or dismiss a
proposal. A viewer sees the card with no action. Routes:
`POST …/chat/conversations/{id}/side-cases/{proposalId}/start` and
`…/dismiss`. Start takes no operation id: the new chat is named by the
Organisation, the person and the proposal, so a repeated Start finishes or
returns the first one.

### 4. Start makes a new Case with the brief only

Start follows the receipt pattern of `forkChat`:

1. Check the starter's control authority, their role in the parent chat,
   placement, and that the proposal is open and not expired.
2. Check the proposal's flow binding for the starter with
   `decideChatFlowDelivery`. A denied check answers as a missing proposal.
3. Claim the proposal: set `starting` and the destination ids, only where
   the status is `open`. The destination conversation id is a digest of
   the organisation, the starter and the proposal id, so a retry or a
   second click makes one chat.
4. Write the new chat: lineage `side_case`, the proposal's title, the
   parent's model route and effort, and the parent's Project when the
   starter can read it there. Otherwise the chat goes to the default
   Project.
5. Admit the brief as the first message of the starter, through the normal
   chat input path.
6. Set `started`.

The new chat is private to the starter. Its context is the brief, not the
parent's history. So its first turn is smaller than the first turn of a
fork. Like any new chat, its turns also read the organisational context
that the starter may read (Plan 42G). That context can name the parent's
messages, and it keeps their labels.

The new lineage variant is
`{ kind: "side_case"; sourceConversationId; proposalId }`. The child shows
"Proposed in" with a link to the parent, when the starter can read the
parent.

### 5. Authority and the harness instruction

Each turn of a side Case runs with the starter's authority, compiled for
that turn. Approvals, grants and effects in the parent do not carry over.
If the side Case needs a permission, `request_permission` asks in that
chat, as in any chat.

The harness instruction of a side Case says: "This chat started from a
proposal in another chat. The first message is that proposal's brief.
Approvals and effects in the other chat do not authorize actions here."

### 6. The sidebar

The directory row of a side Case gets a `parentConversationId` from its
lineage. The organizer shows the row under its parent, one level in, with
a thin guide line, in the order of creation, only when the parent row is
in the same Project list. The row keeps its own status dot and unread
state. In all other cases the row is a normal row, and no drop position
sits above a nested row.

- A side Case of a side Case shows under the top parent. The sidebar has
  one level only.
- A person can drag a side Case to another Project. It then leaves the
  nest. The "Proposed in" link stays in the chat.
- A side Case does not use its manual position while it is nested.
- An archived parent shows no nest. Its side Cases become normal rows.

This keeps the one-list layout of the Portal. It adds no pane.

### 7. Deletion of the parent

When a person deletes the parent, the side Cases stay. They are separate
work, and their value does not depend on the parent. The proposal row
stays as the evidence of each started side Case: its title, brief and flow
binding. Open and dismissed proposals of the parent are deleted. The
started side Case then shows "Proposed in a chat that you cannot open",
which is also what a person sees who cannot read the parent. The user
chose this rule over the fork rule on 2026-10-19.

### 8. Slack (Phase 2)

- `propose_side_case` is offered on Slack thread turns. The thread's
  Connector keeps a copy of the proposing turn's command, and posts one
  message in the parent thread: the title, the brief and a Start button
  (decision 2 below). The title and the brief are plain text, so Slack makes
  no mention or link of them.
- Slack sends a click to `/slack/interactions` on the Slack ingress Worker,
  which gives it unchanged to the platform Worker. The platform verifies the
  signature, answers Slack at once and asks the parent thread's Connector to
  start the side Case. A refusal goes to the person who clicked, and to
  nobody else, through the interaction's response URL.
- The starter must be a member with a linked Slack identity and the owner,
  admin or operator role, as for a message. In a DM only the DM's person can
  start it. The starter's authority is the proposing turn's authority for
  this channel, made for the starter and read live with
  `refreshSlackRequestAuthority`. One person starts a proposal, one time.
- Start posts a new top-level message in the parent's channel: the title,
  the brief, a link to the parent thread and the starter. A DM parent gets
  a new thread in the same DM. A side Case in another channel is not
  possible.
- The Connector pins the new thread to a new Case beside the parent's pin:
  the same installation, Organisation connection and routing source. It
  queues the brief as the Case's first work: a copied command, the fixed
  event id `sidecase_<proposalId>` and the starter as the requester. The
  work is deferred work, so `refreshSlackRequestAuthority` reads the
  starter's authority again when it runs. The brief is never read as a goal,
  a configuration answer or a setup request. Replies from people in the new
  thread then reach the new Case.
- The parent thread gets one line with a link to the new thread, and the
  proposal message loses its button and shows the start.
- Each step keeps its result: the three Slack timestamps in the Connector,
  the claim and the new thread in D1. If a step fails, the person is told to
  click again, and the next click finishes the start. Two clicks at the same
  time wait for each other in the Connector, so one start posts one thread.
- Each turn of the new Case admits the proposal's binding and gets the side
  Case instruction for Slack. A Slack thread keeps one Session over its
  turns, so the start of each turn pins the same instruction text as its
  run, and a later turn restores the Session's checkpoint. A Portal chat
  starts each message in a new Session, so it restores no checkpoint, and a
  fork's second turn works (checked on 2026-10-19).

## Information-flow contracts

The title and the brief are model output of the proposing turn. They carry
every restriction of that turn.

- **Source.** The proposal stores the turn's flow binding at the tool
  call. The side Case admits it as an observation (`organisation_record`
  `side_case:<proposalId>`, the binding's label, the content digest) on
  each turn, before inference. This mirrors `admitChatForkInformationFlow`.
- **Card.** The card is native replay. Release it with
  `decideChatFlowDelivery` on the stored binding, for each reader. A
  denied reader sees no card, and no count reveals it.
- **Sidebar.** The child's title is source-derived. The child is private
  to the starter, and the nest shows only when the parent is readable.
- **Start.** The starter must pass the fork rule for the binding
  (`authorizeSideCaseAccess`: the Case read capability and the delivery
  check). Start adds no reader to a label.
- **Read and sharing.** Each read of a side Case chat
  (`authorizeSideCaseChatRead`) and each disclosure check of it
  (`checkConversationDisclosure`) checks the proposal's binding for the
  reader, as a fork's read checks its inherited history. With the turn
  admission, these are three checks; journey 2 fails when all three are
  removed.
- **Slack.** The proposal post goes through `decideCaseConversationSink`
  with the proposing turn's binding; a refusal is a result. The posts of a
  start go through `decideStoredFlowConversationSink` with the proposal's
  binding and the starter's live authority: the same audience check without
  the partition comparison, because the starter's authority is not the
  proposing turn's. Each turn of a Slack side Case admits the binding with
  `admitSlackSideCaseInformationFlow`, after the same check for the turn's
  authority. Start adds no reader to a label: the new thread is in the same
  channel, and in a DM only its person can start.
- **No return path.** The parent shows only the side Case's state, and to
  readers who are not the starter only "Started". Child content never
  enters the parent. The guide forbids a new path that widens a label.

The [IFC guide](../foundation/authority/policy/information-flow/README.md)
lists these entry points.

## Cost

- A proposal costs the output tokens of one tool call, about 100 to 600
  tokens. It runs no turn.
- A started side Case costs at least one turn on the parent's model route.
  Its context is the brief, so its first turn is smaller than the first
  turn of a fork.
- Storage is one D1 row for each proposal.
- A Slack start makes five Slack calls in the click: two permalinks, the
  new thread, the link line and the change of the proposal message.

## Work sequence and exit gates

### Phase 1 — Portal

- [x] Tool definition, selection, handler and limit
      (`actors/harness-side-case-proposal.ts`).
- [x] `side_case_proposal` table and patch script
      (`scripts/plan-74-side-case-d1-patch.sql`).
- [x] Chat read field and the card (`features/chat/side-case-cards.tsx`).
- [x] Start and Dismiss routes, the `side_case` lineage and the Project
      choice (`chat/side-case-start.ts`, `control/routes/chat-side-cases.ts`).
- [x] Observation admission on each turn and the harness instruction.
- [x] Sidebar nesting.
- [x] Parent deletion rule.
- [x] IFC guide entry.

Exit gate passed on 2026-10-19: journeys 1, 2 and 6 pass; journeys 4 and 5
are parts of journey 1; journey 3 was not built (see below).

### Phase 2 — Slack

- [x] Tool selection on Slack thread turns and the proposal post
      (`actors/harness-side-case-proposal.ts`, `actors/connector-side-case.ts`,
      `slack/side-cases.ts`).
- [x] The start control: the Start button and the signed interactions route
      (`slack/interactions.ts`, `slack-ingress/handler.ts`).
- [x] A thread pin for a thread that Satyr starts, and the first Case work
      (`startSlackSideCase`, `slackSideCaseCommand`).
- [x] The link line in the parent thread.
- [x] Rebuild of `side_case_proposal` for both surfaces, and its patch
      script (`scripts/plan-74-slack-side-case-d1-patch.sql`).

Exit gate: journeys 7 and 8 pass (2026-10-19). The live Slack journey passed
in production on 2026-10-20.

## End-to-end acceptance

Each journey records its result in its task metadata. The fake model only
answers calls. Product code must make each asserted outcome.

1. **Propose and start** (`tests/e2e/chat-side-case.test.ts`, passed). A
   turn in a chat in a named Project proposes a side Case. The card shows.
   The person starts it twice, as a double click does. One new chat is in
   the same Project, under the parent in the sidebar. Its first model
   request holds the brief as the person's request and no turn of the
   parent.
2. **Source audience** (`tests/e2e/chat-side-case-ifc.test.ts`, passed).
   An admin edits a shared chat and starts one of its side Cases. The owner
   moves the source chat to a Project that the admin cannot read; the admin
   keeps the first Project. The admin's side Case then does not open and
   takes no message, and the admin cannot start the other proposal. The
   owner, who still reads the source chat, starts it. The source chat and
   the briefs share no word, so the context search does not tie the side
   Case to the source chat. This is the allowed/denied journey of the IFC
   guide. A product read did not serve here: its output carries the chat's
   own audience, and a revoked grant does not change a stored label.
3. **No carried approval.** Not built. Every Portal turn compiles its own
   authority, and no approval carries between turns of any chat, so the
   journey would test that general rule and not side Cases.
4. **Limit and dismiss** (part of journey 1). A fourth proposal returns
   `limit_reached`. A dismissed card stays dismissed after a reload, and a
   dismissed proposal cannot start.
5. **Parent deletion** (part of journey 1). The started side Case stays,
   and its source link becomes unavailable. Open and dismissed proposals of
   the parent are gone.
6. **Browser journey** (`python3 scripts/plan-74/run-browser.py`, passed;
   needs `SATYR_ACCOUNT_WORKER_ARTIFACT`). The Plan 54 harness predates the
   account authority, so this harness follows Plan 42J's: a local Worker
   with its own D1, the built account Worker and a simulated model. The
   card, Start, the nested sidebar row, the side Case's run and the
   "Proposed in" link pass. The run of 2026-10-19 is in
   [`docs/evidence/plan-74/browser/`](https://github.com/seams-tech/pantry-history/tree/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-74/browser/). A drag
   out of the nest is not covered.
7. **Slack start** (`tests/e2e/slack-side-case.test.ts`, passed). A
   proposal in a channel thread. A click with a wrong signature is refused.
   Another member clicks Start twice at the same time through the Slack
   ingress Worker. One new thread in the same channel links to the parent,
   the parent gets one link line, and the proposal loses its button. The
   first turn holds the brief as the request of the member who clicked and
   no turn of the parent. A reply in the new thread runs in the new Case,
   not in the parent. A later click by the first person is refused to that
   person alone.
8. **Slack DM** (`tests/e2e/slack-side-case-dm.test.ts`, passed). A
   proposal in a DM. A click by another member is refused. The DM's person
   starts a new thread in the same DM, and a reply there runs in the new
   Case through the DM's routing.

Not covered: a proposal that the channel may not show (the tool then
answers that it did not propose), and a start whose label stopped reaching
the channel. Phase 1 journey 2 covers the delivery check of a stored
binding.

## Release

Update (2026-11-14): Phases 1 and 2 are released (2026-10-20), and the live
Slack journey passed on 2026-10-20. The text below is the record from before.

Phase 1 is not released. Its D1 patch
`services/platform/scripts/plan-74-side-case-d1-patch.sql` is applied in
production: on 2026-10-19 it ran on `satyr-organisation-apac`, the only
regional database. The table and its index exist with 0 rows, and
`pnpm d1:schema:remote:check` passes on both production databases. Staging
is not patched; it already lacks earlier patches.

Phase 2 is not released. Two of its release steps are done:

1. Done on 2026-10-19: `services/platform/scripts/plan-74-slack-side-case-d1-patch.sql`
   ran on `satyr-organisation-apac`, the only regional database. It rebuilt
   `side_case_proposal` (0 rows) and made both indexes, and
   `pnpm d1:schema:remote:check` passes from this branch. The live Worker
   does not read the table. `source_kind` defaults to `portal_chat`, so a
   release of dev with Phase 1 code alone also keeps working.
2. Done on 2026-10-19: the Interactivity Request URL of the Slack app
   `A0BFVDZLFLM` is
   `https://satyr-slack-ingress.n6378056.workers.dev/slack/interactions`.
   It was set through the manifest API; a readback showed no other change.
   Until Phase 2 is deployed, the ingress Worker answers this address with
   404, and production posts no Start button.

The steps that remain:

3. Deploy the platform Worker and the Slack ingress Worker
   (`pnpm --filter satyr-edge run deploy` deploys both).
4. Run one live Slack journey: a proposal, a click on Start and a reply in
   the new thread.

The local Slack app (`satyr-public-manifest.json`) and the local event
tunnel do not carry the interactions address. A local start needs both.

## Decisions

The user accepted the defaults on 2026-10-19.

1. **Parent deletion: decided.** Started side Cases stay when a person
   deletes the parent (decision 7). The proposal row outlives the parent as
   their evidence. The fork rule, which deletes them with the parent, was
   not chosen.
2. **Slack start control: decided.** A Slack button, with a signed
   interactions route on the Slack ingress Worker. The owner sets the
   Interactivity Request URL in the Slack app settings, and one live
   journey checks it. The Portal link, as for permission requests, was not
   chosen.
3. **Results to the parent: decided.** No result returns to the parent in
   this plan. A later plan can add a release of a side Case summary to the
   parent, with a delivery check for each parent reader.
