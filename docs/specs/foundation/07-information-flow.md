# FND-07 — Information flow

Information-flow control decides where the work of a Sous Chef agent may go in Purin
Pantry. Each source that a Session reads has a flow label. The label says who may read
the content, and if a person outside the Organisation wrote it. The Session keeps the
join of all its labels. Pantry checks that label when an answer, a message or a tool
effect leaves the Session. A block asks a person, and it does not fail the work. Grants
and capability rules decide what an agent reads. In the Portal, two rules decide what a
member sees: one for a record with a label, and one for a connected source. The
[integration guide](../../../foundation/authority/policy/information-flow/README.md)
stays beside the code. It tells a developer how to add a source or an output.

## What it does

### Labels and levels

- A flow label is a set of policies and an optional writer. A policy has an owner, a
  list of readers and an optional level.
- A join is the union of two labels. A label only grows, and no step removes a policy.
- A label covers a Session, not a field. Each source that a Session read applies to
  each later output of that Session.
- A Portal chat runs each message in its own Session, and a later message keeps each
  policy and the writer of the earlier ones. The Case journal stores each entry with
  its label, and the next Session admits those entries as context items.
- A fork admits the label of each binding of its history as an observation of the new
  Session (`admitChatForkInformationFlow`). A side Case admits the label of the turn
  that proposed it (`admitSideCaseObservation`).

| Level      | Rule (`policyLevel`)                                                                    | Sources in the code                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `private`  | The policy states it, or each reader is a person, a Portal chat or a Slack conversation | A Slack DM with the agent, a Slack group DM, a private Slack channel, a Portal chat                                                  |
| `internal` | The policy states it, or one reader is of another kind                                  | A public Slack channel, a Project, a cue or a schedule, an agent mailbox, a WhatsApp support line, the sources that every role reads |
| Public     | The label has no policy                                                                 | No source adapter makes this label                                                                                                   |

- The label of a message names one reader (`sourceReaderForAuthority`). A Slack DM and
  a private Portal chat name the person. A Slack channel or group DM, a mailbox and a
  WhatsApp line name themselves. A cue turn or a scheduled turn names its cue or
  schedule.
- A shared Portal chat names the chat as the reader (`nativeChatPolicy`). A public
  Slack channel also states `internal`.
- Every role reads a saved bakery run, the device fleet, a recipe workflow and the
  Bakes page. Every role also reads the Jev settings and a workspace canvas chat.
- Pantry knows a public channel from the newest discovery of the Slack account
  (`slackChannelIsPublic`). A conversation that Pantry never listed is not public.
- The readers of a connected resource (a file, an order, a mailbox) are the subjects of
  the active grants that read it. Its level follows the rule in the table.
- A source label comes from current records, and `createCurrentSourceFlowLabel` can
  refuse it. The grant list holds at least one id and no id twice. The account is
  active and fits the capability's provider. The capability is in the Organisation's
  `allowedTools`, and each grant and its subject are current.
- Secrets are not a level. The levels are `private` and `internal`. FND-08 owns Vault
  items and card data.

### What enters a turn

Grants decide what a tool reads. `pac.ts` adds two rules. All other content enters, and
the exit decides.

| Rule                              | Applies to                               | Result                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decideContextAdmission`          | A tool read under the turn's grants      | A Slack turn, a cue turn and a scheduled turn read each source. A Portal chat, a mailbox turn and a WhatsApp turn refuse `private` content that their readers may not see |
| `decideAutomaticContextAdmission` | Case entries, Memory and Project context | `private` content stays out unless the turn's readers may see it. Content that is bound to one recipient enters only a turn that writes to that recipient                 |

- A Slack answer can wait for a person in the Case outbox. The answer of a Portal chat,
  a mailbox or WhatsApp cannot wait. A Portal chat turn does not run when its binding
  fails the delivery check of the chat
  (`embedded_harness_information_flow_unavailable`).
- Pantry admits each observation to the Session before inference. One
  `ObservationEvidence` names the source, its revision, the content digest and the
  label digest. The same observation again changes nothing.
- Parallel tool calls of one Session admit their observations at the same time. A
  write that another admission overtook is stale. Pantry tries it at most 3 times
  (`STALE_OBSERVATION_ATTEMPTS`).
- Each turn gets a `FlowBinding`: the label and the digests of the Session at that
  revision. An output, a proposal and an action carry the binding of their turn.

### The exit check

| Sink                    | Exit                                                                                       | Audience                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `conversation_delivery` | An answer to a Slack DM or a Slack channel. Also the check of a Portal read for one member | The readers that the destination authority gives                                       |
| `native_chat`           | An answer or an action of a Portal chat                                                    | The person, the role, and each Project and chat of the label that the person opens now |
| `tool_effect`           | A tool call that changes a record, sends a message or controls a device                    | The authority of the turn, or every role for a record that every member reads          |
| `typesafe_system_one`   | A Jev model call                                                                           | The authority of the call. It keeps a reader rule, not the level rule                  |

`decideExit` in `sinks.ts` is the level rule. It reads each policy of the label:

1. A policy with a reader in the audience passes. Thus an answer always returns to its
   own conversation, mailbox or WhatsApp line.
2. A `recipient_constraint` policy stops an effect that sends to another recipient
   (`aifc.other_recipient`).
3. Any other `private` policy stops the sink (`deny`).
4. Any other `internal` policy passes inside the Organisation. A sink that reaches
   outside returns `approval_required` (`aifc.outside_organisation`).

| Class set in `sinks.ts`      | Capabilities                                                                                                                                                                                                           | Effect on the rule                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `INSIDE_CAPABILITIES`        | The shared draft edits, the workflow canvas move, the order queue, sold out, recipes, supply costs, suppliers, device pause, bake run pause, custom connector draft and read, the link read, `commerce.action.propose` | Internal content passes                                                                                      |
| `OUTSIDE_CAPABILITIES`       | `whatsapp.support.reply.send`, `commerce.catalog.publish`, `commerce.catalog.update_description`                                                                                                                       | Internal content needs approval                                                                              |
| `OTHER_SERVICE_CAPABILITIES` | `airtable.api.write`, `custom_connector.write`                                                                                                                                                                         | Internal content needs approval, also when the person's role reads it. Content of the target resource passes |
| `RECIPIENT_CAPABILITIES`     | `email.reply.propose`, `email.operational.propose`, `whatsapp.support.reply.send`                                                                                                                                      | A label that is bound to a recipient passes only that recipient                                              |

- A Slack Connect channel reaches outside. `slackConversationReachesOutside` reads
  `is_ext_shared` from Slack, only when the label holds internal content from another
  source. A channel with no known answer counts as outside.
- An effect with `readByEveryMember` has every role as its audience, not the person
  who acts. Shared drafts and the workflow canvas use it (FND-10). A conversation that
  an owner or admin shared with a draft joins that audience, and no label changes.
- Each `tool_effect` also meets the Organisation's capability rules, also with an empty
  label (`organisation-authz.ts`). A denial wins over an approval rule. A label carries
  no tool rule.
- The Portal chat exit adds a check. `decideChatFlowSink` makes the current label of
  each `integration_resource` policy again. It refuses with `source_policy_denied`
  when that label cannot be made or does not pass the sink. It returns `unavailable`
  when the live authority check fails.
- A Slack answer streams in parts. Each part waits until the turn's current binding
  passes the destination check. A turn whose answer must wait still runs, and its
  stream releases nothing.

### The writer rule

- A label states the writer `outside` when a source holds free text of a person outside
  the Organisation. `OUTSIDE_WRITTEN_READ_CAPABILITIES` names `email.mailbox.read` and
  `whatsapp.support.read`. No other source sets the writer.
- A join keeps the writer. Only `acceptedByPersonFlowLabel` removes it, when a turn
  reads an accepted Memory. The stored label keeps it. A model summary removes nothing.
- The rule runs after the level rule and the Organisation's rules. A tool effect of
  such a Session returns `approval_required` with the reason `outside_written`.
- An effect passes when its capability is in `PASSES_AFTER_OUTSIDE_TEXT`, or when its
  approval is satisfied. A new capability asks until a person adds it to that set.

| Effect in a Session with the writer `outside`                                                                                                                                        | Result                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| The answer to the turn's own conversation                                                                                                                                            | Passes. The rule reads tool effects only                               |
| A custom connector read, the link read                                                                                                                                               | Passes                                                                 |
| An email or Slack message proposal, a marketing email draft edit, a commerce proposal, a custom connector draft or write                                                             | Passes. A person reviews the exact content before it changes something |
| Each other tool effect with an exit check: the order queue, sold out, recipes, costs, suppliers, device pause, bake run pause, an Airtable write, a shared draft edit, a canvas move | Asks the person who asked                                              |

- The mailbox agent chooses a direct reply, and trusted code decides
  (`mailboxReplyDisposition`). A direct reply goes only when the sender is a verified
  contact and the turn read no commerce record and no other thread. Any other reply is
  a draft for approval (INB-01).
- An answer can hold a link that outside text put there. Each `chat.postMessage` of
  Pantry spreads `SLACK_NO_LINK_PREVIEW` (`unfurl_links` and `unfurl_media` are
  `false`), and a WhatsApp send states `preview_url: false`.
- The workspace executor container has no network (`enableInternet = false`).

### A block asks

**A Slack answer waits.** `holdCaseOutput` stores a `held_output_request`, and the Case
marks the output `held` (FND-03). Only a Slack output can wait.

- The reason is `private_source` (a `deny`) or `outside_organisation`.
- Only the refusals `case_flow_sink_deny` and `case_flow_sink_approval_required` hold
  an output (`sinkRefusalAsksPerson`). The refusals
  `case_flow_authority_partition_changed`, `case_flow_destination_invalid` and
  `case_flow_destination_mismatch` are final, and they ask nobody.
- The thread gets one card with fixed text and a **Review in Portal** link. The row and
  the card hold no word of the answer. The decision updates the card.
- Allow sends that one output, and its receipt names the request
  (`approvedOutputDecision`). Deny and expiry drop it. The thread and the next turn of
  the agent learn that Pantry did not send it.
- The Session keeps its label. Thus each later answer in that thread waits too.

**A tool effect cannot wait in its turn.** `toolEffectPassesExit` asks through
`passOrAskForExitApproval`. The request stores the capability, the account and the
resource scope. The tool raises `ExitApprovalRequestedError`, which tells the agent.
The reason is `private_source`, `outside_written` or `outside_organisation`, which
also covers another recipient.

- In a Slack thread, the turn parks and the thread gets a card. Allow continues the
  request in a new turn, only while the Slack authority of the person who asked is
  current (`refreshSlackRequestAuthority`). Deny and expiry tell the thread and the
  next turn.
- In a Portal chat, the permission prompt opens in the chat. The person allows it and
  asks again. The pass belongs to the person, because each message runs in its own
  Session.
- A cue, a schedule, a mailbox, WhatsApp and a Slack follow-up turn cannot ask. Their
  effect stays refused.
- Pantry asks only when the Organisation's capability rules allow the effect. A refusal
  of those rules is final.

**One Allow gives one pass.**

- For `private_source` and `outside_organisation`, the pass covers one call of that
  capability, account and resource. The effect's label must add nothing to the label
  that the request stores, or Pantry asks again.
- For `outside_written`, the request stores the digest of the operation and its
  arguments, and the values that the prompt shows (`heldEffectActionRecord`). Pantry
  writes those values from the typed arguments. The pass matches that digest only.
- For a menu board edit, one Allow covers the later edits of the same turn
  (`heldEffectCoversRequest`, CAFE-01). A later turn needs a new Allow.
- The level rule and the writer rule can stop one effect. Each rule then has its own
  request, and Pantry uses no pass until each pass waits.
- An effect with two checks, such as a staff page action, asks for each missing approval
  before it uses a pass (`settleStaffPageEffect`).

| Reason                 | Who sees and decides the request                                                      |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `private_source`       | A member who passes `memberMaySee` on the stored label                                |
| `outside_organisation` | The person who asked, an owner or an admin. That person must also pass `memberMaySee` |
| `outside_written`      | Only the person who asked, who must also pass `memberMaySee`                          |

To any other member the request does not exist (`held_output_not_found`).

### What the Portal shows

- Two rules decide. `memberMaySee` in `chat/member-view.ts` is the rule for a record
  with a label: the Brain reads and a held request. Under it, a member sees each
  record of the Organisation, with one exception.
- The exception is a record with a policy whose readers are all closed to the member.
  A closed reader is another person or a Portal chat that the member cannot open. A
  Slack conversation is closed when it is not public and the member is not in it.
- For a private Slack channel, Pantry reads the member list from Slack. The linked
  Slack user of the member must be in it. A conversation whose members Pantry cannot
  read stays hidden.
- A Project groups work and hides no Case. As a reader of a label, a schedule, a
  mailbox or a WhatsApp line is open to each member.
- The Brain reads use this rule: Memory, Evals, Case execution, the Activity timeline
  and schedule runs (BRN-01).
- A connected source has the second rule. A member reads a mailbox, a WhatsApp line or
  the supplier payout figures only with an active grant to that member or role. The
  kernel then checks a `conversation_delivery` sink with the member's control
  authority (`authorizeMailSource`, `authorizeWhatsAppSupportRead`,
  `payoutReadAllowed`).
- A chat move, a fork and a side Case start check the label for the new readers
  (`decideChatFlowDelivery`). They refuse and ask nobody (FND-03).

## Contracts

The kernel is `foundation/authority/policy/information-flow/`, in the module
`foundation/authority`. `policy/index.ts` only exports it again.

| File                                                                 | Holds                                                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                                                           | The closed unions: owner, level, writer, source, sink, decision and error                                                           |
| `labels.ts`                                                          | `FlowLabel`, `joinFlowLabels`, `policyLevel`, the audiences of an authority, `outsideWrittenFlowLabel`, `acceptedByPersonFlowLabel` |
| `source-labels.ts`                                                   | `createCurrentSourceFlowLabel`, `createCurrentObservedSourceFlowLabel`, `slackChannelIsPublic`, `OUTSIDE_WRITTEN_READ_CAPABILITIES` |
| `pac.ts`                                                             | The two admission rules                                                                                                             |
| `oac.ts`                                                             | `ObservationEvidence`, `InformationFlowContext`, `FlowBinding`, `advanceInformationFlowContext`                                     |
| `sinks.ts`                                                           | `currentFlowSinkCheck`, `evaluateFlowLabelSink`, `decideFlowSink`, the class sets, `sinkRefusalAsksPerson`                          |
| `organisation-authz.ts`                                              | The Organisation's capability rules for a tool effect                                                                               |
| `native-audience.ts`, `readers.ts`, `source-readers.ts`, `digest.ts` | The Portal chat audience, the reader parser, the reader of an authority, the canonical digest                                       |

- **Owners:** `platform`, `organisation`, `integration_resource` and
  `recipient_constraint`, which binds a label to one verified contact.
- **Readers:** `person`, `organisation_role`, `conversation`, `case`, `workflow`,
  `agent_mailbox`, `whatsapp_support`, `project` and `chat_conversation`.
- **Source label kinds** (`createCurrentSourceFlowLabel`): `ingress`, `native_chat`,
  `integration_resource`, `integration_metadata`, `supplier_payouts`,
  `saved_bakery_run`, `device_fleet`, `recipe_workflow`, `bake_board`, `jev_settings`.
- **Evidence source kinds** (`FlowSource`): `case_entry`, `integration_resource`,
  `organisation_record`, `case_context_collection_evidence`, `project` and
  `chat_conversation`.
- **Decisions:** `allow`, `approval_required` and `deny`. The reason codes are
  `audience_not_permitted`, `flow_rule` and `outside_written`.
- **Source label errors** (`CurrentSourceFlowLabelError`): `source_policy_invalid`,
  `source_policy_unavailable`, `source_subject_inactive`, `source_resource_inactive`,
  `source_capability_disabled` and `source_grant_unavailable`.
- A label is canonical: sorted policies with no duplicate, and a SHA-256 digest. A label
  with no level and no writer keeps the digest that it was stored with.
- `FlowLabel.restore` refuses a policy with another field and a digest that does not
  match. A label that was stored with copied tool rules fails restore.
- The `typesafe_system_one` sink has the purposes
  `case_context_discovery_relationship`, `mail_classification` and `screen_relevance`,
  and the model `jev-1.13.0`. A `public_fixture` accepts only a label with no policy.

The Session Actor keeps the flow state in its SQLite
(`foundation/agent/actors/agent-session-information-flow.ts`):

| Table                                   | Holds                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `session_information_flow_observation`  | One evidence row for each observation digest                                             |
| `session_information_flow_revision`     | The context of each revision: the work label and the observation set                     |
| `session_information_flow_turn_binding` | The `FlowBinding` of each turn                                                           |
| `session_commerce_observation_entity`   | The commerce records that an observation returned. A proposal targets only such a record |

Other records hold a label or a binding as JSON: `case_journal` and the Case outputs
(Case Actor), `memory_revision`, `eval_revision` and `eval_run_result` (Brain), and the
D1 tables `context_projection` and `side_case_proposal`.

Regional D1 (`services/platform/migrations-regional/0001_current_schema.sql`):

- `held_output_request`: one row for each held answer (`subject` `output`) or held step
  (`subject` `effect`). It has the `reason`, the `status` (`pending`, `allowed`,
  `denied`, `expired`), the label, the request authority and the person who asked. A
  held step also has its capability, account and resource, `consumed_at`,
  `consumed_turn_id`, `action_digest` and `action_json` (`data/held-output-request.ts`).
- The id of a held answer is the first 32 hex characters of the SHA-256 of
  `organisationId:outputId`. The id of a held step comes from the Session, the turn,
  the capability, the account, the resource, the reason and the action digest. The
  same request again keeps the first row, and the notice of a held answer keeps one
  delivery id (`delivery_held_<requestId>`).
- `slack_conversation_fact`: what Slack says about one conversation: `is_private`,
  `reaches_outside`, `member_ids_json` and `read_at` (`slack/conversation-facts.ts`).

The control routes are under `/v1/control/organisations/:id/access-control`, in
`control/routes/held-output-requests.ts` and `agent-permission-requests.ts`:

| Route                                    | Role                  | Purpose                                                                                   |
| ---------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `GET /permission-requests`               | Viewer                | The pending list of FND-06. `heldOutputs` holds the held requests that the reader decides |
| `GET /held-outputs/:requestId`           | Viewer who decides it | The reason, the destination, the source, and the answer text or the action                |
| `POST /held-outputs/:requestId/decision` | Viewer who decides it | `allow` or `deny`. It releases the output or the step                                     |

- The decision route returns `held_output_decision_invalid` (422) for another answer,
  `held_output_expired` (409) after the lifetime and `held_output_decided` (409) when
  the stored decision is the other one. The same decision again tries the release
  again.
- The shapes `HeldOutputSummary`, `HeldOutputView` and `HeldEffectAction` are in
  `packages/control-api/src/agent-permission-requests.ts`. The Portal prompt is in
  `apps/portal/src/features/access/` (`held-output-prompt.tsx`,
  `chat-held-step-prompt.tsx`). A Slack card links to `access?heldOutput=<requestId>`.
- This subsystem has no event kind, no capability and no agent tool of its own.
  `settleToolEffect` in `agent-tools/session-support.ts` is the one place that runs the
  exit check of an effect tool. It takes what `prepare` of the tool returns (FND-09).
  `pnpm lint:tool-effects` (`scripts/check-tool-effects.mjs`) refuses a `draft`,
  `receipt` or `scheduled` tool with no `prepare`.

| Work                       | Entry point in `services/platform/src/`                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Turn context               | `context/turn-context.ts` (`prepareTurnContext`, `assembleTurnContext`)                                                    |
| Session observations       | `prepareSessionInformationFlow`, `admitSessionInformationFlowObservation`                                                  |
| Slack delivery             | `actors/case-conversation-sink.ts`, `slack/conversation-facts.ts`                                                          |
| Portal chat                | `chat/information-flow.ts` (`resolveNativeChatAudience`, `decideChatFlowSink`)                                             |
| Held answers and steps     | `actors/case-output-hold.ts`, `actors/harness-follow-up.ts`, `slack/held-output-release.ts`, `slack/held-output-notice.ts` |
| The action of a held step  | `agent-tools/effect-action.ts`                                                                                             |
| Commerce reads and effects | `agent-tools/commerce/read-support.ts` (`admitCommerceReadObservation`), `commerce/provider-execution.ts`                  |
| Mail sends                 | `authorizeEmailReplyReview`, `authorizeEmailProposalFlow`, `mail-inbox/direct-reply.ts`                                    |
| Jev calls                  | `integrations/typesafe/disclosure.ts`                                                                                      |

`pnpm lint:ifc-boundaries` runs `scripts/check-ifc-destinations.mjs` and ESLint import
rules. The script refuses a tool effect whose capability is not in the class part of
`sinks.ts`. It also refuses a new file with a conversation delivery until a person adds
the file to the script. ESLint lets only the boundary owners import the Portal chat
audience factory and the disclosure proof. The same rule covers the raw projection
reader and the raw Memory, Eval and execution stores (`eslint.config.mjs`).

## Rules and limits

| Action                                         | Viewer                            | Operator                  | Admin and owner           | Agent          |
| ---------------------------------------------- | --------------------------------- | ------------------------- | ------------------------- | -------------- |
| See a record of a private source in the Portal | Only its readers                  | Only its readers          | Only its readers          | No Portal view |
| Decide a `private_source` request              | If the member may see the content | The same                  | The same                  | No             |
| Decide an `outside_organisation` request       | Only the person who asked         | Only the person who asked | Yes                       | No             |
| Decide an `outside_written` request            | Only the person who asked         | Only the person who asked | Only the person who asked | No             |
| Share a conversation with a shared draft       | No                                | No                        | Yes                       | No             |
| Make a label, change it or leave it out        | No                                | No                        | No                        | No             |

| Limit                                           | Value                                 | Constant                                         |
| ----------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Lifetime of a request and of its pass           | 7 days from the request               | `HELD_OUTPUT_REQUEST_LIFETIME_MS`                |
| A stored decision that did not reach its output | Tried until 14 days after the request | Two lifetimes, in `listHeldOutputReconciliation` |
| Pending list, reconciliation batch              | 50 requests, 20 requests              | Literals in `data/held-output-request.ts`        |
| Age of a stored Slack fact                      | 5 minutes                             | `FACT_MAX_AGE_MS`                                |
| Member list of a private channel                | 5 pages of 200                        | `MEMBER_PAGES`, `MEMBER_PAGE_LIMIT`              |
| Values that a prompt shows                      | 12                                    | `DETAIL_LIMIT`                                   |

- The scheduled reconciliation (`onboarding-reconciliation-runner.ts`) expires a request
  after its lifetime. It also finishes a decision that did not reach its output.
- A longer member list than the limit gives no list, so the channel stays hidden.
- If Slack does not answer, Pantry uses the stored fact.
- An unavailable authority withholds content and new execution
  (`organisation-access/access.ts`). An earlier success grants no later request.
- An approval permits one output or one pass of a step. Only an `outside_written` pass
  with a stored action digest matches one exact action. An approval removes no reader,
  no policy and no writer.
- A label, a binding, an evidence record or a digest that is missing or invalid fails
  closed at the boundary that reads it.
- A new read can return a buyer's name, an order note, a customer note or a message of
  a person with no membership. It calls `outsideWrittenFlowLabel` in the same change.
- The purge of an Organisation erases both D1 tables (`data/purge-catalogue.ts`).

**Out of scope:** labels for a field or a value; integrity labels other than the one
writer; a release of a policy by an approval or by a model; labels that a model infers
from content; a policy language for users; flows between Organisations; the CaMeL
planner and interpreter; a second policy engine.

**Boundaries:**

- FND-03 owns the Case outbox, the `held` output state, forks and side Cases. FND-04
  owns the turn and the stream. FND-05 owns context assembly and attachments.
- FND-06 owns the request authority, grants, capability rules and permission requests.
- FND-08 owns secrets. FND-09 owns the tool catalogue, `prepare` and the screen
  observation rule. FND-10 owns shared drafts and their rooms.
- BRN-01 owns Memory, Evals and the Case execution views. INB-01 owns the mailbox and
  WhatsApp agents and the verification of a contact. ORG-02 owns the Jev switches.
- CAFE-01 owns the board edit and its preview. KIT-03 owns the recipe workflow
  proposal. DEV-01 owns the `device_fleet` source.
- [Plan 95](../../plan-95-pantry-own-accounts.md) owns accounts and the eligibility
  check of each admission and disclosure.

## Open work

- No sink names a capability of `OUTSIDE_CAPABILITIES`. `whatsapp_support_reply_send`
  runs no exit check, and commerce execution names `commerce.action.propose`. Thus a
  catalogue publish and a WhatsApp reply do not meet rule 4.
- `schedule_follow_up`, `menu_board_archive` and `whatsapp_support_reply_send` run no
  exit check. The proposal tools and the surface tools also run none
  ([Refactor 17](../../refactor-17.md), Appendix C). Plan 89 says that a follow-up asks.
- The link read (`read_message_link`) records no observation, so its text has no label
  and no writer. No source adapter makes a public label for a published menu, a
  fetched page or documentation.
- `outsideWrittenFlowLabel` has no caller. Thus only a label of `email.mailbox.read` or
  `whatsapp.support.read` states the writer. A mailbox, WhatsApp or scheduled turn is
  not marked by its own ingress.
- A turn of no person cannot ask, so its blocked effect stays refused. Commerce
  execution after a signed approval and a custom connector read are also refused, with
  no question.
- Private content of two people has no person who may see both. Such a request expires.
- Pantry holds no `mpim:read` Slack scope. A group DM stays hidden in the Portal.
- The exit does not compare Slack members. Content of a private channel needs approval
  to reach the DM of one of its members.
- A shared Portal chat stays `private` to its readers.
- A prompt reaches a person through the thread's card and the pending list. No code of
  the platform calls `conversations.open`, so Pantry starts no Slack DM for a prompt.
- A held shared draft edit and a held canvas move store no action. Their Allow covers
  one step of the capability. The Slack card shows no action.
- The Jev detector (a purpose `injection_detection`) and the typed Jev mail read are
  not built. A handoff sink and an `artifact_export` sink are not built.
- The nine reader kinds stay in stored labels. `policyLevel` gives a stored policy its
  level at each read, so no background conversion runs.
- The two journeys of the writer rule add the outside read to the running turn
  directly (`raiseLabel` in `tests/e2e/held-exit-support.ts`), and they use fake
  services. They read no mailbox. No file in `services/platform/tests/` holds the
  reason code `aifc.other_recipient`.
- The Slack stream calls and `chat.update` send no preview flag. Their link preview
  was not checked on real Slack.

## Sources

- [Plan 27](../../history/plan-27-ifc.md), the history of the label model. In the archive:
  [Plan 25](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-25-conversation-authority-and-organizational-context.md),
  [Plan 57](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-57-live-delivery.md).
- [Plan 27C](../../history/plan-27C-simple-information-flow.md), the levels and the exit rule.
  In the archive:
  [Plan 27B](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-27B-permission-requests-and-flow-release.md).
- [Plan 89](../../history/plan-89-outside-written-content.md), the writer rule. In the archive:
  [Plan 29](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29-organisation-agent-email-mailboxes.md).
- The sources name no evidence file in the archive. Where a source differs from the
  code, this spec follows the code.
- E2E journeys in `services/platform/tests/e2e/`: `slack-held-output.test.ts`,
  `slack-held-effect.test.ts`, `slack-exit-levels.test.ts`,
  `outside-written-effect.test.ts`, `airtable-exit-approval.test.ts`,
  `slack-streamed-answer-withheld.test.ts`, `slack-context-search-labels.test.ts`,
  `slack-email-draft-label.test.ts`, `project-ifc.test.ts`,
  `chat-side-case-ifc.test.ts`, `pi-menu-board-one-allow.test.ts`,
  `chat-agent-recipes-suppliers.test.ts`, `mail-inbox.test.ts`,
  `memory-access.test.ts`, `memory-admission.test.ts` and `schedule-runs.test.ts`.
- The browser journey of the prompt is
  `scripts/permission-toasts/browser-permission-toasts.js`.
