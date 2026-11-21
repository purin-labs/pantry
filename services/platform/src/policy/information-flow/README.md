# Information-flow control

This directory decides where an agent's work may go.
[Plan 27C](../../../../../docs/plan-27C-simple-information-flow.md) holds the
rules, and [Plan 27](../../../../../docs/plan-27-ifc.md) holds the history.
Callers supply live authority, and the kernel decides. Grants decide what a tool
may read. Labels decide where the result may go. Keep both at their boundaries.

## Model

- A **flow label** (`labels.ts`) is a set of policies. A **join** is the union of
  two labels, so a label only grows. A label covers a Session, not a field: each
  input that a Session observed applies to each later output.
- A **policy** has an owner and readers. The owner is `platform`, `organisation`,
  `integration_resource` or `recipient_constraint`, which binds the label to one
  verified contact.
- A **level** is `private` or `internal`. A policy states it, or `policyLevel`
  derives it: a policy whose readers are only persons, Portal chats or Slack
  conversations is private. Any other is internal.
- **OAC** (`oac.ts`) records one `ObservationEvidence` for each source revision
  and joins the labels. A `FlowBinding` carries a turn's label across a boundary.
- A **sink** (`sinks.ts`) is an exit: `conversation_delivery`, `native_chat` or
  `tool_effect`. `typesafe_system_one` is a model call and keeps a reader rule.

## What enters a turn

`pac.ts` holds two rules. Everything else enters, and the exit decides.

- `decideContextAdmission`, for a tool read under the turn's grants. A Slack or
  scheduled turn reads it, because its answer can wait for a person. A Portal
  chat, a mailbox or WhatsApp refuses private content that its readers may not
  see, because a stopped answer would stop each later turn of that Session.
- `decideAutomaticContextAdmission`, for Case entries, Memory and Project context.
  Private content stays out unless the audience may see it. Otherwise, each answer
  in the channel would ask for approval.

## The exit rule

1. A policy with a reader in the sink's audience passes. An answer can always go
   back to its own conversation, mailbox or WhatsApp line.
2. A `recipient_constraint` stops an effect that sends to another recipient.
3. Any other `private` policy stops the sink.
4. Any other `internal` policy passes inside the Organisation. A sink that reaches
   outside it returns `approval_required`: a Slack Connect channel
   (`reachesOutside`), a WhatsApp reply, a catalogue publish, an Airtable write or a
   custom connector write.

A write to another company's service (`OTHER_SERVICE_CAPABILITIES`) has no reader
in the audience, so rule 1 does not pass its internal policies. Private content
that names the audience still passes, so a person's own words go with the request.
Internal content that came from the resource that the write targets also passes.

An effect with `readByEveryMember` has every role as its audience, not the person
who acts. A shared draft and a workflow canvas use it, so one person's private
content cannot enter them without a question. An owner or admin can share a
conversation with a draft. That conversation then joins the draft's audience, and
no label changes.

A board edit also shows on the board while the model writes its arguments (Plan
40B phase 7, `agent-tools/drafts/board-draft-preview.ts`). That presence reaches
every member on the board, so it passes the same shared draft exit first, in its
check form: `passSharedDraftExit(..., "check")` asks nobody and takes no approval
pass, and it passes only when the edit itself would pass now. If it fails, no
part of the arguments reaches the room.

A recipe workflow proposal (Plan 84) is not such an effect. Its reason and step
names stay with the person who asked, and no other member can read them. That
person's approval is the decision to show the step names to every member, and the
card says so.

`pnpm lint:ifc-boundaries` refuses a tool effect whose capability is in no class
set in `sinks.ts`. It also refuses a new conversation delivery until a person
adds it to `scripts/check-ifc-destinations.mjs`.

Organisation capability rules (`organisation-authz.ts`) are about tools, not
data. Each `tool_effect` meets them, even with an empty label. Build a check with
`currentFlowSinkCheck`. A label stored with copied tool rules fails restore.

## The writer rule

A label can state a writer, `outside` (Plan 89): a source of the Session holds
free text that a person outside the Organisation wrote. `source-labels.ts`
names the read capabilities of such sources. A join keeps the writer, and only
`acceptedByPersonFlowLabel` removes it, for a record that a person accepted.

After the exit rule and the Organisation's rules, a tool effect of such a
Session returns `approval_required` with the reason `outside_written`, unless
its capability is in `PASSES_AFTER_OUTSIDE_TEXT` (`sinks.ts`): a read, or a
step that has its own review. A new capability asks until a person adds it.
A handler gives `toolEffectPassesExit` its `action`, so that the prompt shows
the operation and its values, and one Allow covers that exact action. Only the
person who asked sees the request. A Portal chat keeps the writer in its
later messages. A commerce read names no buyer today, and Slack ingress admits
only a member, so neither sets the writer. A new read that returns a buyer's
name, an order or customer note, or a message of a person with no membership
calls `outsideWrittenFlowLabel` on its label before it records the
observation; `admitCommerceReadObservation` is the one place for a commerce
read. An effect with two checks, such as a staff page action, asks
for each missing approval before it uses a pass (`settleStaffPageEffect`).

## A block asks

- A Case output waits. `holdCaseOutput` stores a `held_output_request`. Use
  `sinkRefusalAsksPerson` (`sinks.ts`) to tell these refusals from final ones.
- A tool effect cannot wait inside its turn. `toolEffectPassesExit` asks through
  `passOrAskForExitApproval`. Allow gives one pass to that capability, account and
  resource of that Session. A Slack turn continues in a new turn. A Portal chat
  opens the permission prompt in place, and the person allows it there and asks
  again. A turn of no person stays refused.
- One Allow covers one request (Plan 40B phase 7). The turn that uses a pass
  stores its id in `consumed_turn_id`, and its later calls of the same effect
  use the same pass, also when two calls run at the same time (one update
  decides). Each use, the first one too, passes only when the effect's
  label joined to the label stored with the request keeps that label's digest:
  an effect with more private content asks again. A later turn needs a new
  Allow. Only a board edit uses this rule (`heldEffectCoversRequest`); other
  effects use one pass for each call. The prompt's view names the rule in
  `covers`, so that its text says what the Allow covers.
- Who decides: for `private_source`, a person who passes `memberMaySee` on the
  label. For `outside_organisation`, also the starter or an owner or admin. To any
  other member the request does not exist.
- Deny and expiry tell the thread and the next turn. The notices are fixed text.

## Portal views

Permissions decide what a member sees, with one rule: `memberMaySee` in
`chat/member-view.ts`. A member sees each record of the Organisation, unless each
reader of one of its policies is another person, a Portal chat that they cannot
open, or a Slack conversation that they are not in. A stored label converts when it
is read, so no background job runs. A schedule belongs to the whole Organisation.

## Rules for every surface

- An unavailable authority withholds content and new execution. A prior success
  grants no later request.
- Admit an observation to the Session before inference and before the model sees
  its content. Create the evidence for the exact source revision and digest.
- Moves, summaries, forks and restore keep every contributing policy. Do not add
  a reader to a label, and add no second policy engine.
- An approval permits one exact action. It removes no reader.

## Add a source

1. Extend the source's trusted read adapter, and validate external records there.
2. Get the label from `createCurrentSourceFlowLabel` in `source-labels.ts`.
3. Admit the read with `decideContextAdmission`. Then record the evidence.
4. Add one allowed and one denied E2E journey through the real adapter.

## Add an output

1. Use an existing sink kind. Build the check with `currentFlowSinkCheck`.
2. Give a new tool effect's capability a class in `sinks.ts`.
3. Check the cumulative binding immediately before release. Use
   `toolEffectPassesExit` or `holdCaseOutput`, so that a block asks.
4. Add one allowed and one denied E2E journey.

## Where it lives

| Work                     | Entry point                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| Turn context             | `prepareTurnContext`, `assembleTurnContext` in `context/`         |
| Portal chat              | `chat/information-flow.ts`, `resolveNativeChatAudience`           |
| Session observations     | `prepareSessionInformationFlow`                                   |
| Slack delivery           | `actors/case-conversation-sink.ts`, `slack/conversation-facts.ts` |
| Held outputs and effects | `actors/case-output-hold.ts`, `actors/harness-follow-up.ts`       |
| Decisions in the Portal  | `control/routes/held-output-requests.ts`                          |
| Mail sends               | `authorizeEmailReplyReview`, `authorizeEmailProposalFlow`         |
| Brain reads              | `memory/access.ts`, `evals/access.ts`, `case-execution/access.ts` |
| Placement                | `OrganisationExecutionScope`                                      |

A screen observation (Plan 87) is the sender's own input, as the message text
is: the person saw the page, and the composer chip sent it. A private chat
carries any page. A shared chat carries only a page that every member may open
(`sharedChatMayCarry` in `@purin-labs/control-api`), because its reply reaches the
other readers. `chat/screen-observation-admission.ts` applies the rule when the
message is sent, so a withheld page is not stored, and again at turn time. The
conversation response sends only the page name of a message, never its view.
A page joins the shared list only after its control route is checked; a page
that needs more than the viewer role first needs a check of each reader.
Since phase 2 the Kitchen view is the `state` of its observation
(`chat/kitchen-observation.ts`), so the same rule covers it, in the prompt's
Kitchen block too. The Kitchen is not on the shared list, because some of its
reads need the admin role. With the chip off on the Kitchen page, the message
also refuses the Kitchen browser tools. A Costs & margins view command (phase 4)
runs only for a message whose admitted observation is Costs, and its receipt
brings the page as the browser shows it after the command into the turn as a
tool result. Knowledge › Context › On screen (phase 5,
`chat/case-screen-observations.ts`) lists the pages of a Case's chats that
the reader may see, as each message stored them after its admission: the
page, the time and the records, with no view, state or path.

The Jev relevance suggestion (Plan 87 phase 1B, `chat/screen-relevance.ts`) has one
source and one sink. The source is a draft that the sender has not sent yet, with the
chat's origin label, its last answer and the section titles of the page on screen. The
sink is `typesafe_system_one` with the purpose `screen_relevance`, under the sender's
control authority. The audience rule of Plan 87 section 4 runs first, so a page that the chat's
readers may not receive sends nothing. Then the chat's viewing check must pass for the
sender, because Jev reads the last answer. The draft, the answer and the page are what
the sender typed, read and saw, so the request carries the sender's own label
(`ingress`). Jev gets no fact value and no table row, and its answer never enters a
prompt.

## Checks

Run `pnpm lint:ifc-boundaries`, the platform type checks and the affected journeys.
`tests/e2e/slack-held-output.test.ts` and `slack-held-effect.test.ts` are the
reference journeys, and `outside-written-effect.test.ts` for the writer rule. Change this guide when the kernel, a sink or a rule for every
surface changes.
