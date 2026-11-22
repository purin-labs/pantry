# Plan 27C — Simple information-flow control

Status: steps 1 to 5 in production since 31 October 2026 (satyr-edge `5ef7f3b5`).
The Slack repeat passed on 1 November 2026. No release step is left.
Date: 30 October 2026.
Owner: Satyr platform and Portal.
Changes: [Plan 27 — Agent Information Flow Control](plan-27-ifc.md),
[Plan 27B — Permission requests and flow release](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-27B-permission-requests-and-flow-release.md)
and the information-flow parts of [Plan 42J — Brain](plan-42J-brain.md).

## Goal

Information-flow control (IFC) has one job: private information must not go
to a place where other people can read it. Examples of such places are a
Slack channel, an outbound email and a customer conversation.

IFC does not decide what an agent may read. Grants and capability rules do
that, as today. IFC does not decide what a member sees in the Portal.
Ordinary permissions do that.

## Decision

1. **Three levels.** Each piece of content that an agent reads is `private`,
   `internal` or `public`.
2. **One check, at the exit.** Satyr checks the level when an answer, a
   message or a tool effect leaves the Session. Satyr does no check when an
   agent reads a source, and no IFC check in the Portal views.
3. **Private chats and DMs are for their people only.** A Portal private chat
   and a Slack DM with the agent belong to their owner. A Slack group DM and a
   private Slack channel belong to their members. Other members, owners and
   admins included, do not see them in the Portal.
4. **A block asks.** When the exit check fails, Satyr holds the output and
   asks a person for approval in context. It does not fail the work.

## Why

The current system checks in three places:

1. **Agent input.** Before a turn, the turn's audience must include each
   reader of a source. If not, the agent never sees the source.
2. **Portal views.** Brain, the Activity timeline, Memory, Evals and the
   Schedules tab hide each record from a person who is not one of its readers.
3. **Exits.** An output goes out only if the destination's audience includes
   the readers of each policy of the Session's label.

A label is a set of policies. Each policy has an owner and a list of readers.
A reader is one of nine kinds: a person, a role, a Slack conversation, a Case,
a workflow revision, a mailbox binding revision, a WhatsApp binding revision,
a Project or a Portal chat. The kernel has about 3,300 lines. Fifteen E2E
journeys assert its rules.

This gives results that nobody expects:

- A scheduled run named only its schedule as reader, so no person could read
  any run. The fix needed a new reader kind, a D1 column and a backfill
  (Plan 42J, "Scheduled runs and their Project").
- An owner cannot read in the Portal a Case that came from a public Slack
  channel, because its labels name only that channel.
- Titles, counts and previews in the Portal follow label rules. The schedule
  runs view needed an exception for its withheld count.
- An exit block names policy readers that no person can judge, so Plan 27B
  could not turn it into a simple prompt. Plan 27B part B (flow release) was
  designed for this and then cut as low value on 28 October 2026. Today a
  blocked output fails, with no prompt.

## The three levels

A Session's level is the highest level of all that it read. The level goes
up and never goes down, as labels do today. It stays with the content through
moves, summaries, forks, side Cases and restore.

`private` content has an **audience**: the people who may see it. If a
Session read private content from two sources, its audience is the people in
both audiences.

| Level      | Sources                                                                                                                                                                              | Audience                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `private`  | Slack DM with the agent; Portal private chat                                                                                                                                         | The owner                     |
| `private`  | Slack group DM; private Slack channel                                                                                                                                                | Its members, read at the exit |
| `internal` | Public Slack channels of the workspace; shared Portal chats and Project chats; Cases; Memory; orders and other commerce records; files; schedules; agent mailboxes; WhatsApp support | The Organisation's members    |
| `public`   | Published menu and catalogue; public web pages that the agent fetched; product documentation                                                                                         | Anyone                        |

Secrets are not a level. Vault items and card data never enter a Session, as
today (Plan 79).

## The exit check

Each destination has an audience class:

| Destination                                                             | Class                   |
| ----------------------------------------------------------------------- | ----------------------- |
| Slack DM to one person; Portal private chat                             | That person             |
| Slack group DM; private Slack channel                                   | Its current members     |
| Public Slack channel of the workspace; shared Portal chat; Project chat | Organisation            |
| A tool effect that stays inside Satyr (a draft, an internal record)     | Organisation            |
| Slack Connect channel (shared with another company)                     | External                |
| Outbound email; WhatsApp; SMS                                           | External, one recipient |
| A tool effect that publishes (storefront, menu, product text on a shop) | External                |

The rule:

1. `public` content goes anywhere.
2. `internal` content goes to every class except External. To External it
   needs approval, with one exception: content that came from an external
   person may go back to that same person. A reply to a customer's email may
   use that email. This replaces the `recipient_constraint` policy.
3. `private` content goes only to a destination whose people are all in its
   audience. Any other destination needs approval from a person in the
   audience.

Organisation capability rules (deny, approval) for tool effects stay as they
are. They are about tools, not content.

Satyr does not know today if a Slack channel is shared with another company.
Step 2 reads `is_ext_shared` from Slack and treats such a channel as External.

## The approval prompt

When the exit check fails, the output waits in the Case outbox. Satyr asks in
context, with the existing Allow prompt and the Plan 27B pending list:

- For `private` content: each person in the audience gets the prompt. One of
  them decides. Example text: "The agent wants to post an answer that uses
  your DM with it in #kitchen. Send it?"
- For `internal` content to External: the person who started the work gets
  the prompt. For a run with no person (a schedule, a mailbox, WhatsApp),
  owners and admins get it through the pending list.

Allow sends that one output. Deny drops it, and the agent and the asker learn
that it was not sent. A prompt expires after seven days, as a Plan 27B
request does. An approval is for one output only. Plan 27B rejected one
approval per use, because each draft edit needed a new prompt. With levels,
internal content goes to internal drafts with no prompt, so that cost is gone.

## What the Portal shows

The Portal uses permissions, not labels:

- A member sees each record of the Organisation: Cases, runs, Memory, Evals,
  timeline events, titles and counts.
- A Case, chat or Memory that came from a private source is visible only to
  its audience. This is a fixed property of the record, from its origin, not
  a label check.
- Roles still limit actions. For example, only admins change grants.

Projects stop being a privacy boundary. They group work. A Project member list
no longer hides a Case from other members.

## What goes away

- The input check (`decideContextAdmission`, PAC) and its callers.
- The nine reader kinds. A label becomes a level and, for `private`, an
  audience.
- The label checks in the Portal reads: `case-execution/access.ts`,
  `case-execution/timeline.ts`, `memory/access.ts`, `evals/access.ts`,
  `chat/conversation-disclosure.ts`, `chat/forks.ts`, `chat/side-cases.ts`.
- The schedule's Project reader and `schedule_binding.project_id` (Plan 42J).
  All members see a scheduled run.
- The `mail_review` sink and `MailReviewGrant`. A reviewer is a member, and
  the mailbox is internal.
- The label widenings for shared drafts (`releaseSharedDraftThreadLabel` and
  the email draft rule). An internal draft takes internal content without one.
- The guide's rules on titles, counts and withheld records.

## Old data

Labels are stored in Case journals, D1 context projections, observations and
flow bindings. An old label converts once, when it is read:

- A policy whose readers are only persons, or a Portal private chat, becomes
  `private` to those persons.
- A policy that names a Slack DM, group DM or private channel becomes
  `private` to its members.
- Any other policy becomes `internal`.

No conversion runs in the background. The conversion lives in one function in
the kernel. It is deleted when no stored label of the old form remains.

## Order of work

Each step lands on its own and keeps Satyr safe.

1. **Portal views use permissions.** Remove the label checks from the Portal
   reads. Hide private records by their origin. This removes most of the
   confusion and needs no change at the exits.

   Built: the Brain reads (Case execution, the Activity timeline, schedule
   runs, Memory and Evals) use `memberMaySee` in `memory/member-view.ts`. It
   reads the stored label once more: a policy is private only when each of
   its readers is another person, a Portal chat that the member cannot open,
   or a Slack conversation that Satyr has not discovered as a public channel.
   This is the read-time conversion of "Old data", used early. Projects no
   longer hide a Case, and a mail reply proposal shows to each member. A Case
   whose triggers are all private to others is absent. Limits of step 1:
   - A Slack direct message, group message or private channel stayed hidden
     from every member, its own people included. Step 2 changes that.
   - Chat moves, forks and side Case starts keep the old check. They move
     content to new people, so they belong to steps 2 and 3.
   - A Project chat still follows chat access, which includes the Project's
     members. Opening such a chat to all members is a chat product change.

2. **Levels in labels.** Add the level and audience form and the read-time
   conversion. Give each destination its class, with Slack Connect detection.
   Replace the reader check at each exit with the level rule.

   Built: a policy has an optional `level`. A policy with no level gets one
   from its readers, so old labels keep their digests and need no conversion.
   A public Slack channel states `internal`. `decideExit` in
   `sinks.ts` is the level rule. `slack_conversation_fact` holds what Slack
   says about a connected conversation: private or not, Slack Connect or not,
   and the members of a private channel. Limits of step 2:
   - The reader kinds stay. The input check (PAC) and `memberMaySee` still read
     them, so they go in step 4 and step 5, not here.
   - An exit that needs approval returns `approval_required`, and each caller
     refuses it, because the prompt comes in step 3. Today this stops internal
     content from reaching a Slack Connect channel, a WhatsApp reply and a
     catalogue publish with no approval. Release steps 2 and 3 together.
   - Until step 4 the input check stops a channel turn from reading other
     internal content. So a real channel turn cannot reach the Slack Connect
     rule yet. The `slack-exit-levels` journey calls the exit directly.
   - A shared Portal chat stays private to the chat's readers. Its side Cases
     still close for a person who loses the chat. It becomes `internal` with
     the chat product change in step 1's last limit.
   - Satyr does not hold the Slack scope for group DM members (`mpim:read`). A
     group DM stays hidden in the Portal, and its answers go back to it. A new
     scope needs each workspace to install the app again.
   - A private source goes only to a destination that names it as a reader.
     Slack members are not compared at the exit, so a private channel's content
     does not reach a member's DM without approval. The cost is more prompts.
3. **Approval at the exit.** Hold a blocked output in the Case outbox. Ask
   through the Allow prompt and the pending list. Send, drop or expire it.

   Built: `held_output_request` holds where an output goes, why it waits and
   its label. It holds no agent text, because the answer stays in the Case
   outbox. A level refusal in `deliverAndSettleCaseOutput`, in the direct paths
   and in `deliverCommerceCaseOutput` holds the output. A turn that starts
   blocked now runs, and its stream releases nothing. The thread gets fixed
   text with a Portal link. Allow posts that one output, below any part that
   the stream showed. Deny and expiry drop it, and a Case journal note tells
   the agent's next turn. Limits of step 3:
   - A tool effect of a person's turn asks too, as "Tool effects" below says.
     The start of a side Case and a Portal chat action are still refused.
   - Private content from two people has no person in both audiences. Nobody
     can decide such an answer, so it expires.
   - The prompt reaches a person through the thread's link and the pending
     list. Satyr sends no direct message to a person who is not in the thread.
   - An owner or admin may also decide internal content that would leave the
     Organisation, so a request does not wait for one absent person. This adds
     to "The approval prompt" above.
   - An approval is for one output, and the Session keeps its level. So each
     later answer in that thread waits too.
   - Before the release, apply `held-output-request-d1-patch.sql` to each
     regional database.

   Tool effects: a running turn cannot wait for days, so a blocked effect does
   not wait inside it. `passOrAskForExitApproval` stores a request with the
   effect's capability, account and resource, and the tool tells the agent. In
   a Slack thread the turn parks as a permission request does, and Allow
   continues it in a new turn. That turn's effect uses one pass. A second effect
   asks again. Deny and expiry tell the thread and the agent's next turn. This
   covers Slack and email proposals, Airtable writes, shared draft edits and
   workflow canvas moves. Limits:
   - The request names the capability, not the tool's arguments. The person
     allows one such step, and the agent then writes it. A Slack or email
     proposal still waits on its own card or review.
   - In a Portal chat there is no parked run. The request waits in the pending
     list, and the person asks again. A private source that the chat's readers
     cannot see still stops the chat's own answer.
   - A turn of no person (a schedule, a mailbox, WhatsApp) has no later turn of
     its Session, so its effect stays refused. Commerce execution after a signed
     approval and custom connector reads also stay refused.
   - In a thread that holds private content, the step and each answer ask
     separately.
   - The Slack path ran in a journey. An email to another recipient uses the
     same code, and no journey ran it. The Portal chat path ran in the Plan 81
     menu journey, which found that a pass never matched, because a chat runs
     each message in its own Session. A Portal chat's pass now belongs to the
     person who asked, so any of that person's chats can use it once.
4. **Remove the input check.** Only after step 3. Without the prompt, an agent
   that reads more would fail more sends.

   Built: the check that kept internal content from a turn is gone. Two narrow
   rules stay in `pac.ts`, because the plan's "no check at a read" would harm
   these cases:
   - A tool read under the turn's grants: a Slack or scheduled turn reads
     anything, and its answer can wait. A Portal chat, a mailbox and WhatsApp
     have no wait for their own answer, and a stopped answer would stop each
     later turn of that Session. So they still do not read private content that
     their readers may not see. They do read internal content.
   - Automatic context (Case entries, Memory, Project context): private content
     stays out unless the turn's readers may see it. If it entered, each answer
     in the channel would ask for approval. Internal content enters.

   Grants still decide what a tool reads. A channel's read grant names the
   channel, so its label already allows the channel. So Acceptance 1 does not
   happen in a real turn today: no tool gives a channel turn another person's
   DM. The hold journeys add such a read to the Session directly. Internal
   content from elsewhere now reaches a channel turn, and a Slack Connect channel
   asks for it.
5. **Clean up.** Remove the schedule Project reader, `mail_review` and the
   draft widenings. Rewrite the IFC guide in one page. Update Plans 27, 27B
   and 42J. Change `pnpm lint:ifc-boundaries` to check that each new
   destination has a class.

   Built: a schedule names no Project, and `schedule_binding.project_id` goes
   after the release. `mail_review` had no caller after step 1, so it is deleted.
   A shared draft and a workflow canvas move now use `readByEveryMember` and the
   prompt of step 3. Internal content enters them. Limits:
   - A sharing rule stays: a turn whose work some role may not read edits a draft
     only from a conversation that an owner or admin shared with it. This is about
     who may edit from where, not about content.
   - The share is the approval for the shared conversation: it joins the draft's
     audience, so that conversation's words enter with no prompt, also from a
     private channel. No label changes. Without this, each edit in a connected
     thread would ask, which breaks the production plan flow that passed in
     production. Private content from anywhere else asks, once for each edit.
   - The nine reader kinds stay in stored labels, and `policyLevel` reads them. The
     conversion function of "Old data" stays until no old label remains.
   - Airtable writes and custom connector writes reach outside the Organisation
     (owner's decision, 2026-10-31). Internal content asks, also when the acting
     person's role or the conversation may read it, because neither reads it at
     that service. Private content that names the audience passes, so a person's
     own words go with the request. A custom connector write already waits for a
     person's review, and that review is the approval. Custom connector reads
     stay inside. Internal content from the base that an Airtable write targets
     goes with no question, because it does not leave that base. Other internal
     content asks: a pass is good for one write, and a turn of no person stays
     refused.

## Acceptance

Allowed and denied E2E journeys, one for each outcome:

1. A Slack DM: the agent in a public channel uses what an owner said in a DM
   with it. The answer waits. The owner gets the prompt. Allow posts it once.
   Deny posts nothing, and the asker learns that it was not sent.
2. Email: a reply to a customer uses that customer's email and goes with no
   prompt. A message to a supplier that uses the customer's email waits for
   approval.
3. Portal: a member sees a scheduled run and a Case from a public channel. A
   member does not see another member's private chat or DM Case. Its owner
   does.
4. Slack Connect: an internal answer to a shared channel waits for approval.
5. Old data: a Case from before the change keeps its privacy. A DM Case stays
   with its owner, and a channel Case becomes visible to members.

Review the fifteen journeys that assert the old rules. Keep each outcome that
still holds. Delete each one that asserts a removed rule.

## Cost

Estimates for agent work, with the journeys:

| Step | Estimate |
| ---- | -------- |
| 1    | 2–3 days |
| 2    | 4–6 days |
| 3    | 3–4 days |
| 4    | 1–2 days |
| 5    | 1 day    |

The total is about two to three weeks. Step 1 alone gives most of the
benefit for the Portal.

## Risks

- **More content reaches the agent.** Without the input check, a turn can read
  a DM if its grants allow it. The exit still stops that content. The cost is
  more prompts, not a leak.
- **Projects no longer hide work.** A team that uses a Project to keep work
  from other members loses that. A private Project can come later as one more
  `private` audience.
- **Private channel members change.** The exit reads the live member list, so
  a person who leaves the channel stops being part of the audience at once.
- **Model providers.** Content still goes to the model provider of the turn.
  This plan does not change that.

## Decisions for the owner

1. **Projects as privacy.** Recommendation: Projects do not hide work. Default:
   as recommended.
2. **Private Slack channels.** Recommendation: `private` to their members, as
   DMs are. The other choice is `internal`, which is simpler but shows a
   private channel's Cases to all members. Default: `private`.
3. **Old data.** Recommendation: convert at read, as above. The other choice
   is to delete stored work from before the change. Default: convert.
