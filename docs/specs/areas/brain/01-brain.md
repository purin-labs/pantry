# BRN-01 — Brain

Brain is the area of Purin Pantry where people see and decide what the Sous Chef agents
learn. It has three parts. Memory keeps scoped, evidenced facts and preferences that a
person accepted. Evals test a mailbox agent on reviewed synthetic scenarios, with and
without a candidate Memory. Case execution shows the recorded work of one Case as a
read-only graph. Each part keeps its records in an existing Actor, and each read checks
the stored information-flow label of each record against the reader. Brain adds no
second write path, no Brain Actor and no new authority. An agent can propose a Memory,
but only a person can accept it.

## What it does

### The Portal pages

- The Knowledge page is in the "Agents" navigation group. Its tabs are Overview,
  Knowledge, Skills, Learning, Tests and Context. The Tests tab is the Evals view.
  Activity is the second tab of the Agents page. An old `/brain`, `/activity` or
  `/tests` address opens the page that holds its view (`renderBrain` in
  `surfaces/portal/ui/pages.tsx`).
- The address holds the view, the selected Memory, the state filter, the Eval, the Case
  and the selected record (`view`, `memory`, `state`, `eval`, `case`, `record` in
  `features/brain/address.ts`). A link opens the same view.
- The Knowledge entry of the navigation shows a count on every page when it is more
  than 0: the Memories and the Evals that wait for this person's decision (the Brain
  summary, `useBrainItemsToReview` in `shell.tsx`). The Portal reads it when the
  workspace opens, every 5 minutes while the tab is in view (`REFRESH_MS` in
  `brain-summary.ts`), and after each read of the Brain page or the Evals.
- **Overview**: one status line with the number of items that wait, the items that
  wait (most recent change first) and four counts as filters.
- **Learning**: a flow of boxes for the stages of the loop, each with its count, and a
  log below it, newest event first. The page derives both from the Memory histories
  and the Eval runs that it already reads.
- **Knowledge**: a rail with four kinds (Memory, Evals, Playbooks, Agents) and their
  counts. Each record is a wide row with its scope in words and the time of its last
  change. The browser keeps the rows that the person opened (at most 600, `MAX_OPENED`
  in `seen.ts`), and a changed row that was not opened shows "New". A Memory row opens
  the record in place of the list: applicability, validity, evidence, history, and the
  controls to accept, edit, decline, replace and revoke. Playbooks and Agents are
  read-only rows that link to their owner. A filter by state (`review`, `in_use`,
  `not_in_use`) and a search limit the rows.
- **Teach a fact**: an entry in the Knowledge view for a person who may decide. It
  explains the steps and opens the chat. The page has no form for a new Memory.
- **Tests**: the Evals as rows. An Eval record shows its scenarios with the expected
  result, a scenario editor, and one comparison table for each run: a row for each
  scenario, a column group for each route, and in it a column for each configuration.
  A cell shows "Not run", "Passed", "Failed", "Could not run", "Stopped with an error",
  "Result unknown" or "Cancelled" (`taskStatus` in `evals-model.ts`). While a run is in
  progress, the view reads it again every 4 s (`POLL_MS`).
- Below the table, a person who may manage sees "Accept the proposed memory" when the
  candidate passed on a route that ran and is still the open candidate of its Memory.
- **Activity**: a list of Cases, a timeline of the Cases filed in a window, and the
  graph of one Case (see "Case execution").
- **Context**: links only: "Related Cases" and "On screen" on the Access and data flow
  page, and "Context discovery" on the Integrations page. It adds no read.
- **Skills**: the view of the agents' skills. The Agents operations own its records.

### Memory

A Memory states one reusable `fact`, `preference` or `lesson`. Each revision holds the
statement (at most 2,000 characters), where it applies, when it holds, the evidence and
the Case that it came from.

| Applicability (`kind`) | A turn is offered it when                                                    |
| ---------------------- | ---------------------------------------------------------------------------- |
| `portal_chat`          | A person started the turn in a Portal conversation                           |
| `skill`                | The turn loaded that skill                                                   |
| `commerce_entity`      | The turn is about that exact entity of that merchant, for example a supplier |

| Evidence (`kind`)         | Names                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| `operator_instruction`    | A `user_message` Case entry with an author, by Case, entry and content digest  |
| `case_observation`        | A Case entry, by Case, entry and content digest                                |
| `proposal_correction`     | A reviewed edit of a mail reply draft: mailbox, proposal, version, body digest |
| `case_context_collection` | A collection revision. The platform refuses it (`memory_evidence_unsupported`) |

- Validity names an IANA time zone, a first date, a last date or none, and the cited
  records that its truth depends on (`dependsOn`). Project placement gives neither
  applicability nor access.
- A revision cites at most 20 records (`MAX_EVIDENCE` in `control-api/src/memory.ts`).
  Each `dependsOn` record must also be in `evidence`.
- A revision is `candidate`, `accepted`, `rejected`, `superseded` or `revoked`. A
  rejection is `declined`, or `revised` with the revision that took its place. A
  superseded revision names its replacement. Acceptance stays on a superseded or
  revoked revision.
- A Memory has at most one accepted revision and one candidate. An edit of an accepted
  Memory proposes a replacement. The accepted revision stays in force until a person
  accepts the replacement.
- A command names its `commandId` and the head revision that the sender saw. A
  repeated command returns its first receipt. A used `commandId` with another request
  is `memory_command_conflict`, and a stale revision is `memory_conflict`.

### How a Memory is proposed

1. **Mail reply correction.** A person edits an agent's mail reply draft on the review
   surface. `editEmailReplyBody` records the correction (`recordEmailReplyCorrection`)
   only when it holds the whole history of that body. It queues a learning turn. The
   Connector alarm runs it (`runDueEmailCorrectionLearning`) while the Gmail draft still
   has the recorded body. The turn (`processEmailCorrectionLearning`) may only call
   `propose_memory` or `no_memory`. It drafts and sends nothing. The candidate applies to
   the supplier that the message's verified contact names. With no such supplier,
   nothing is proposed.
2. **Portal chat.** A person tells the agent a rule. The agent calls `propose_memory`
   with a statement and a kind (`fact` or `preference`). The platform cites the message
   that started the turn (`proposeMemoryForHarness`, `proposeMemoryFromInstruction`).
   That message must be in the agent's own Case (else `memory_evidence_invalid`). The
   candidate has the scope `portal_chat`, shown as "Chats in the Portal".
3. **A person in the Portal.** A Memory command `propose` with `own_input` (private to
   the author) or `shared_review` (an edit of the candidate, or a replacement for the
   accepted revision, for the audience of that revision).

An agent proposal holds the zone `UTC`, a first date of today and no last date. The
reviewer sets the zone and the dates in an edit. The command identity of a mail
correction comes from the cited correction, so a repeated call returns the first
candidate. The command identity of a Portal chat proposal comes from the cited message
and the statement. A repeated call with the same words returns the first candidate,
and a call with other words makes a second candidate. An agent cannot accept, reject
or revoke.

### Memory in a turn

Each turn gives the context assembler a `memoryReader`, and each new context bundle
records one Memory outcome.

| Surface                                               | Reader                                                                | Subjects                                                                  | Deadline |
| ----------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| Portal chat turn                                      | `createTurnMemoryReader` in `chat/turn/run.ts`                        | `portal_chat`                                                             | 250 ms   |
| Mailbox reply turn                                    | `createMailboxTurnMemoryReader` (`mail-inbox/mailbox-turn-memory.ts`) | The pinned agent's skills, and the supplier of a current verified contact | 5 s      |
| Eval task turn                                        | `createEvalTurnMemoryReader`                                          | As a mailbox turn from the scenario's sender                              | 5 s      |
| Slack, WhatsApp, direct Case commands, mail assistant | `turnMemoryReaderWithoutSubjects`                                     | None, so it reads nothing                                                 | —        |

- The reader pages through accepted revisions by the applicability index, 32 at a time
  (`TURN_MEMORY_PAGE`). It offers a revision only when the scope matches a subject, the
  rule holds on the turn's date in its own zone, each dependency resolves, the
  destination may receive its label, and the turn's authority admits it.
- An expired rule, a lost dependency or a refused destination excludes the revision
  silently. A failed lookup makes the whole read `unavailable`. Persisted Memory that
  fails verification ends the assembly with `memory_state_invalid`.
- A revision that the turn may not be shown takes no place in the limit. So `limited`
  always means that a permitted revision was left out.
- The outcome is `none`, `admitted` (exact revisions), `limited` (the revisions that
  fit and the reason: `items` or `tokens`) or `unavailable` (`deadline` or
  `read_failed`). Late results do not change the bundle. If the prompt byte budget
  then drops an admitted revision, the Session records what the model was shown as
  `limited` by `prompt_bytes` (`actor-journal/transactions.ts`).
- Memory goes before the other candidates and is exempt from the selection deadline.
  The model reads Memory first. On `limited` or `unavailable`, a fixed limitation line
  tells the model that Memory was withheld (`memoryLimitation`).
- An admitted revision is an `organisation_record` observation named `memory:<id>` at
  its revision, with its stored label. Like each other bundle item, it advances the
  Session's flow context for the turn (`buildContextObservations` in
  `agent-session-information-flow.ts`).
- `session_turn_context` keeps the bundle and its digest. A restore verifies the digest.
  A resume uses the recorded bundle. A new turn reads current Memory. A bundle accepted
  before Memory admission has no outcome, and only `actor-journal.ts` reads it
  (`digestHistoricalContextBundle`).

### Evals

- An Eval tries one agent behaviour: `mailbox_reply` of one mailbox. A revision holds
  a title, up to 6 scenarios (`MAX_EVAL_SCENARIOS`) and the evidence. A scenario is a
  `target` or a `control`, names its sender by an exact contact verification revision,
  holds a synthetic message, and has 1 to 6 criteria (`MAX_EVAL_CRITERIA`). A revision
  needs at least one `target` scenario and at least one evidence item.
- A criterion is `outcome` (`reply_now`, `approval_required` or `no_reply`),
  `reply_includes` or `reply_excludes` (text, compared without case). The scorer
  `pantry_eval_scorer_v1` decides each criterion from the recorded outcome and reply
  text only. No model scores.
- Only the correction learning turn opens an Eval (`proposeEvalFromCorrection`), when
  the agent wrote a test message (`check` of `propose_memory`). The trusted path sets
  the sender, the arrival time and the one criterion. A person has no command that
  opens an Eval. A person's `revise` edits the candidate or proposes a replacement, and
  keeps the subject and source Case of the revision that it inherits from.
- Eval revisions use the Memory lifecycle and the same command rules.
- **A run** tries the accepted revision on 1 to 3 routes (`MAX_EVAL_ROUTES`) and one or
  two configurations: `current` (the accepted Memory) and `candidate` (one Memory's
  candidate revision in place of its accepted one, in that run only). A route is one
  of `claude_oauth`, `codex_subscription`, `organisation_openai_api_key`,
  `organisation_anthropic_api_key`, `organisation_google_api_key` and
  `pantry_platform`.
- A run is one Case. The mailbox's Gmail Connector holds the run while it is in
  progress (`actors/connector-eval.ts`) and drives its tasks one at a time from its
  alarm. Each task is one assignment and one Session: a mailbox reply turn on the
  scenario message (`runTransientEvalTurn`). The mail tool host reads the scenario from
  a fixture. The turn reads no mailbox mail, and nothing is drafted or sent.
- Before the model is asked, the Session checks that the mailbox agent may read the
  Eval revision's label (`decideAutomaticContextAdmission` in
  `prepareTransientEvalTurn`). A label bound to more than one recipient is refused.
- A task ends one time: `assessed` (with a verdict `passed` or `failed`),
  `unavailable`, `failed`, `cancelled` or `indeterminate`. Only an assessed task has a
  verdict. An unavailable reason is `authority_unavailable`, `budget_exhausted`,
  `agent_unavailable`, `fixture_unavailable` or `memory_unavailable`. A task never
  moves to another route. A turn that was interrupted after its assignment began is
  not run again: the task is `indeterminate`.
- A candidate task ends `memory_unavailable` at once when the turn may not be shown the
  candidate, or when a size limit leaves it out of the bundle.
- A cancel settles only the pending tasks of a run as `cancelled`. A running task runs
  to its end. A run with no pending task ends with the results that it has.
- A run is `pending` or `running`, then `cancelled`, `indeterminate`, `failed` or
  `completed`, in that order of precedence (`settledEvalRunState`). `completed` means
  that each task was assessed or unavailable.
- Only the settled run goes to the OrganisationActor (`publishEvalRunResult`,
  `settleEvalRun`). Its label joins the Eval revision's label with the turn label of
  each assessed task. Only an assessed task stores a turn label. A task whose turn ran
  keeps its pins: model, route digest, instruction digest, tool catalog digest, context
  bundle digest and policy version. A task that ended before its turn, or after its
  last claim, keeps no pins.

### Case execution

- The projection of one Case has nine node kinds: `trigger`, `assignment`, `turn`,
  `attempt`, `tool_operation`, `proposal`, `approval`, `effect` and `delivery`. A node
  is `open` or withheld. A withheld node shows its kind and its edges only.
- An edge has a recorded basis: `context_entry`, `assignment`, `turn`, `tool_call`,
  `proposal` or `action`. Timestamps give no edge. The page lists each link that the
  records do not hold as a limitation: `tool_attempt_unrecorded`,
  `effect_attempts_unrecorded`, `delivery_attempts_unrecorded`,
  `mail_proposal_origin_unrecorded`, `proposal_tool_call_unrecorded`,
  `session_unavailable`, `effect_unavailable`, `truncated` or `record_invalid`.
- A turn node carries its Memory result: the kind, the reason and the count of
  revisions, with no Memory text or identity (`unrecorded` when no outcome exists). A
  mail turn or an Eval turn keeps no turn record, so its node is `unrecorded`, from the
  context that its Session recorded for its latest run (`recordTransientTurnContext`).
- A page holds at most 100 nodes (`MAX_CASE_EXECUTION_PAGE`). A page read asks at most
  6 Sessions (`MAX_SESSION_READS`). An edge comes on the page of its later node. An
  edge between two nodes of an earlier part comes on the first page of the current
  part. A cursor holds a keyed `basis` of what the reader sees. If that basis changed,
  or a Session part changed while the cursor is inside it, the next page is refused
  with `case_execution_changed`. A change to a withheld record does not refuse it.
- A node detail returns bounded content (at most 4,000 characters for each piece,
  `MAX_CASE_EXECUTION_CONTENT_LENGTH`) and the Case entries that an assignment was
  given. Model reasoning and an assignment's instruction are never returned.
- The Case list holds at most 50 Cases (`MAX_CASE_EXECUTION_CASES`), newest first.
  The timeline summarises at most 30 Cases in a window (`MAX_TIMELINE_CASES`). The
  schedule run list joins `schedule_dispatch_receipt` with each run's Case, at most 40
  runs (`MAX_SCHEDULE_RUNS`). A run whose Case the reader may not read adds to
  `withheld`. A window is at most 32 days (`MAX_CASE_TIMELINE_WINDOW`).
- The canvas (`execution-canvas.tsx`, layout in `execution-layout.ts`) puts nodes in
  columns by stage (request, assignment, work, proposal, decision, delivery), with one
  lane for each assignment. It uses only recorded edges. It has pan, zoom (0.25 to
  1.5), "Fit to view", a legend and a path back. A stack of more than 6 records
  (`EXECUTION_STACK_LIMIT`) folds. At 760 px or less, the list replaces the canvas.
- The Portal chat reads the execution of its own Case through the chat route. The
  read adds no copied payload to the conversation timeline.

## Contracts

- OrganisationActor SQLite (`memory/store.ts`, `evals/store.ts`, created in
  `actors/organisation/schema.ts`): `memory`, `memory_revision`, `memory_command`,
  `eval`, `eval_revision`, `eval_command` and `eval_run_result`. Partial unique
  indexes allow one `accepted` and one `candidate` revision for each record.
- Gmail Connector SQLite: `connector_eval_run` and `connector_eval_task`
  (`actors/connector-eval.ts`), `connector_email_reply_correction` and
  `connector_email_correction_learning` (`actors/connector-email.ts`). The Connector
  stores no corrected body, only its digests.
- D1: Brain owns no table. Reads use `case_project`, `portal_conversation`,
  `schedule_dispatch_receipt` and `schedule_binding`. The old `merchant_memory` table
  is gone from both baselines.
- Contracts in `packages/control-api/src/`: `memory.ts`, `evals.ts`,
  `case-execution.ts`, `case-timeline.ts` and `brain.ts` (`BrainSummary`). They are
  TypeScript types with hand-written parsers on the `@purin-labs/std` guards, not
  TypeBox schemas.
- Public files of the area (`scripts/layers.json`): `memory/contract/`,
  `evals/contract/`, `evals/scorer.ts`, `areas/brain/ui/execution-client.ts`,
  `features/brain/api.ts` and `features/brain/address.ts`.
- Entry points: `memory/access.ts` (`readMemoryViews`, `commandMemoryAsOperator`,
  `countMemoriesToReview`, the turn readers), `evals/access.ts` (`readEvalViews`,
  `commandEvalAsOperator`, `commandEvalRunAsOperator`, `readEvalRunViews`,
  `readEvalSenderChoices`, `countEvalsToReview`) and `case-execution/access.ts`
  (`readCaseExecutionPage`, `readCaseExecutionNodeDetail`, `listCaseExecutionCases`).
- The Actors return execution records with their stored labels for this area only:
  `readExecutionRecords` and `readExecutionContent` on the CaseActor and the Session,
  `readCaseExecutionEffects` on the OrganisationActor.

The control routes are under `/v1/control/organisations/:id`:

| Route                                                     | Role   | Purpose                                                                 |
| --------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `GET /brain/summary`                                      | Viewer | The navigation count. Below admin, the summary of an empty Organisation |
| `GET /memories`                                           | Viewer | The Memories that this person may inspect in full                       |
| `POST /memories/commands`                                 | Admin  | `propose`, `accept`, `reject`, `revoke`                                 |
| `GET /evals`                                              | Viewer | The Evals that this person may inspect in full                          |
| `POST /evals/commands`                                    | Admin  | `revise`, `accept`, `reject`, `revoke`                                  |
| `POST /evals/runs`                                        | Admin  | `start` or `cancel` a run                                               |
| `GET /evals/:evalId/runs`                                 | Viewer | The runs of one Eval                                                    |
| `GET /evals/:evalId/contacts`                             | Admin  | Current verified contacts of the Eval's mailbox, at most 50             |
| `GET /case-executions`                                    | Viewer | The Case list                                                           |
| `GET /case-executions/timeline`, `/schedule-runs?from&to` | Viewer | The Cases or the schedule runs of a window                              |
| `GET /cases/:caseId/execution?after&limit`                | Viewer | One page of the projection                                              |
| `GET /cases/:caseId/execution/nodes/:nodeId`              | Viewer | One node detail                                                         |
| `GET /chat/:conversationId/execution`                     | Viewer | The projection of a chat's Case                                         |

Each route also needs the live capability `context.case.read`
(`resolveMemoryViewer`). Without it, `GET /brain/summary` returns the summary of an
empty Organisation, and the other routes refuse. A missing Memory or Eval is 404, a
conflict or a full store is 409, a body that is not JSON is 400, and an invalid
command is 422.

| Agent tool                                                              | Where                    | Selected by                                                                   | Effect                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `propose_memory` (`memoryProposal`, `agent-tools/turn/turn.ts`)         | Portal chat              | A signed-in owner or admin (`turnMayProposeMemory`), with no capability grant | Proposal. Statement of at most 600 characters, kind `fact` or `preference`. Direct calls only, not from a script |
| `propose_memory`, `no_memory` (`agent-tools/channels/mailbox-agent.ts`) | Correction learning turn | The `correction_learning` turn policy                                         | Proposal. `check` holds an optional test message                                                                 |

The agent has no tool to read or decide a Memory or an Eval.

## Rules and limits

| Action                                       | Viewer and operator                                      | Admin and owner                                             | Agent                           |
| -------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------- |
| Read Memories, Evals, runs, Case execution   | With `context.case.read`, only records whose labels pass | Same                                                        | No                              |
| See a count in the navigation                | Always zero                                              | Count of records that wait                                  | No                              |
| Propose a Memory                             | No                                                       | Yes, Portal command                                         | `propose_memory`                |
| Accept, reject or revoke a Memory or an Eval | No                                                       | Yes                                                         | No (`memory_reviewer_required`) |
| Revise an Eval, read sender contacts         | No                                                       | Yes, if the Eval is open to them in full                    | No                              |
| Start or cancel an Eval run                  | No                                                       | Yes, if the Eval and the candidate are open to them in full | No                              |

| Limit                                                              | Value             | Constant                                                            |
| ------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------- |
| Memory read deadline, interactive and background turn              | 250 ms, 5 s       | `INTERACTIVE_MEMORY_DEADLINE_MS`, `BACKGROUND_MEMORY_DEADLINE_MS`   |
| Memories, revisions of one Memory                                  | 500, 200          | `MAX_MEMORIES`, `MAX_REVISIONS` (`memory/store.ts`)                 |
| Evals in use or under review, Evals in all states, revisions       | 200, 2,000, 100   | `MAX_EVALS`, `MAX_EVAL_RECORDS`, `MAX_REVISIONS` (`evals/store.ts`) |
| Settled runs kept for one Eval                                     | 50, the oldest go | `MAX_RUN_RESULTS`                                                   |
| Open runs in one mailbox                                           | 4                 | `MAX_OPEN_EVAL_RUNS`                                                |
| Tokens for one task, for one run                                   | 40,000, 400,000   | `EVAL_TASK_TOKEN_ALLOWANCE`, `EVAL_RUN_TOKEN_BUDGET`                |
| Task claims before the task settles, task lease                    | 6, 6 minutes      | `EVAL_TASK_MAX_CLAIMS`, `EVAL_TASK_LEASE_MS`                        |
| Eval turn wall time, retry delay                                   | 5 minutes, 30 s   | `TURN_MAX_WALL_MS`, `RETRY_DELAY_MS` (`eval-task-processing.ts`)    |
| Published run rows in the Connector, deleted when a new run starts | 7 days            | `PUBLISHED_RUN_RETENTION_MS`                                        |

Tokens of an Eval task come from the mailbox's daily budget through the existing
reservations. After the last claim, a deferred task settles with the outcome that its
last try named: `indeterminate`, `failed` or `unavailable`.

- **Withheld means absent.** A Memory or an Eval with any hidden revision or cited
  record is absent from the list. A hidden record and a missing record give the same
  answer. Labels are never returned. A denied Brain summary equals the summary of an
  empty Organisation.
- **The Portal rule.** Each read decides a label with `viewerMayRead`, which applies
  `memberMaySee` (`chat/member-view.ts`). A policy is private only when each of its
  readers is private. A record that stored no label shows to nobody. A Slack Case from
  a private conversation opens to a member whose linked Slack user is in it now.
- **Case execution.** A Case that a chat presents follows the chat's own access
  (`authorizeConversation`). Each other Case belongs to the whole Organisation,
  whatever its Project. A Case whose triggers are all withheld is absent. A node is
  open only when its label passes and each record that it follows from is open. Node
  identities and the page `basis` are digests keyed from `SESSION_TOKEN_SECRET`.
- **Labels.** A proposal label joins the author's label and the label of each cited
  record, and the author must be able to read each cited record. The OrganisationActor
  refuses a shared edit whose label drops a policy of the revision that it inherits
  from. Only `memory/access.ts` and `evals/access.ts` assemble a label.
- **Raw stores.** `eslint.config.mjs` refuses an import of the raw Memory and Eval
  stores outside `actors/organisation.ts`, `actors/organisation/organisation-*.ts`,
  `memory/access.ts` and `evals/access.ts`. The raw execution record readers are also
  open to `actors/case.ts`, `actors/agent-session.ts` and `actors/session/`.
- **Acceptance adds no authority.** An accepted Memory gives no permission and no
  policy override. Action policy still applies.
- **Neighbours.** FND-03 owns Cases, assignments and Sessions. FND-05 owns context
  assembly and its item and token limits. FND-07 owns flow labels and sinks. FND-09
  owns the tool catalog. INB-01 owns the mailbox, the reply review surface and contact
  verification. COM-05 (Plan 16) owns playbooks and agent configuration: a correction
  that changes how work is done becomes a playbook revision there, not a Memory.
- **Out of scope:** automatic prompt or policy changes, autonomous promotion of a
  candidate, a business measure card, a setup interview for a new agent, discovery and
  ingest of connected systems, workflow authoring, the Slack review card and a Files
  view. The Activity graph cannot schedule work, edit edges or change approvals.

## Open work

- A fact taught in a Portal chat does not reach mail replies. That needs a new rule
  that releases a person's words to a mailbox at acceptance.
- CaseContextCollections are refused as evidence until each revision records its
  complete provenance.
- A Memory that cites a mailbox Case entry, and no reviewed reply, has no review
  surface in the Portal.
- An Eval tries only `mailbox_reply`. A person cannot open an Eval.
- The execution records lack fields: the attempt that ran a tool operation, each try of
  an effect and of a delivery, and the turn or tool call of a mail reply proposal.
- The Evals journey has not run on the real Codex route, and no execution journey holds
  every step in one Case.

## Sources

- [Plan 42J — Brain](../../../history/plan-42J-brain.md) and
  [Plan 42K — Brain interface](../../../history/plan-42K-brain-ui.md). Where they differ from
  the code, this spec follows the code. Their evidence in the archive:
  [B1a](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42J-brain/README.md),
  [B1b](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42J-brain/b1b-evals.md),
  [B2](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42J-brain/b2-execution.md),
  [the interface](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42K-brain-ui/README.md)
  and [the browser captures](https://github.com/seams-tech/pantry-history/tree/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42J-brain/browser/).
- The [IFC integration guide](../../../../foundation/authority/policy/information-flow/README.md)
  and [FND-07](../../foundation/07-information-flow.md).
- E2E journeys in `workers/platform/tests/e2e/`: `memory-access.test.ts`,
  `memory-teaching.test.ts`, `memory-admission.test.ts`, `memory-commands.test.ts`,
  `eval-commands.test.ts`, `mail-inbox.test.ts` (filters `gives the mailbox agent the
accepted Memory` and `compares the accepted and a candidate Memory`),
  `chat-execution.test.ts`, `chat-shared-runtime.test.ts`,
  `portal-chat-finalization.test.ts`, `pi-sdk-effect.test.ts`,
  `pi-sdk-combined-proposal.test.ts`, `slack-case-title.test.ts`,
  `commerce-lab.test.ts` and `schedule-runs.test.ts`.
- The browser journey of the Brain pages: `scripts/plan-42J/run-browser.py`.
