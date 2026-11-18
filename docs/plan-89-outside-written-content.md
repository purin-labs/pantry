# Plan 89 — Outside-written content

Status: steps 1 to 6 in production since 11 November 2026 (satyr-edge
`cd1ee9cb`, dev `e3ae6ee39`). Step 7 is checked and needs no code: no agent
read returns that text today. No live check of the writer rule ran. "Built"
below gives the limits.
Date: 11 November 2026.
Owner: Satyr platform and Portal.
Extends: [Plan 27C — Simple information-flow control](plan-27C-simple-information-flow.md).
Touches: [Plan 29 — agent mailboxes](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29-organisation-agent-email-mailboxes.md),
[Plan 83 — one Inbox](plan-83-one-inbox.md) and
[Plan 81 — agent Portal control](plan-81-agent-portal-control.md).

## Goal

Text that a person outside the Organisation wrote must not make the agent do
an action that no member asked for. This attack is prompt injection: an email,
a WhatsApp message or a web page holds text that the model reads as an
instruction.

An agent may read such text, quote it and answer from it. It may not change a
record, send a message or control a device because of it, unless a person
sees the exact action and allows it.

## The gap today

Information-flow control (IFC) answers one question: who may **read** this
content. Plan 27C checks it at each exit. This stops a data leak, also one
that an injected instruction asks for.

IFC does not answer the second question: who **wrote** this content. So these
paths have no control today:

- The Portal chat agent reads mail with `email_mailbox_search`. The same turn
  can then call `order_queue_advance`, `sold_out_mark`, `recipe_save`,
  `supply_cost_save`, `lot_cost_save`, `costs_plan_save`, `supplier_create`
  or `device_pause`. Exit rule 4 lets internal content pass inside the
  Organisation, so none of them asks.
- The mailbox agent can call `email_reply_now` with no person. The limit is
  the model's judgment of "routine", and one code rule: no direct reply after
  an order read.
- The prompts say that email is "untrusted evidence". This is advice to the
  model, not a control.

What protects the paths now: the mailbox and WhatsApp agents have small tool
sets, trusted code fixes the reply target, and each send to another recipient
or outside the Organisation asks a person.

## Decision

1. **One rule in the IFC kernel, not a module in the Inbox.** Email is one
   outside source of several. WhatsApp, fetched pages, connector reads and
   customer notes carry the same risk. Each tool effect already passes
   `evaluateFlowLabelSink` and `toolEffectPassesExit`, so one rule there covers
   every tool, also a Code Mode script and a tool that is added later.
2. **A label says who wrote the content.** A label gets an optional writer
   with one value, `outside`. The kernel sets it for a source whose read
   holds free text from a person outside the Organisation. The join keeps it,
   so it stays through moves, summaries, forks, side Cases and restore, as the
   level does.
3. **An effect with a consequence asks.** In a Session whose label has an
   outside writer, a tool effect that changes a record, sends a message or
   controls a device returns `approval_required`. A person sees the exact
   action and allows that one action.
4. **A turn of no person stays refused.** A mailbox, WhatsApp or scheduled
   turn has nobody to ask. Its consequential effects stay refused, as a level
   block does today. Its own reply path has its own rule (step 5).
5. **No custom interpreter.** Satyr does not build the CaMeL planner and
   interpreter. "Why not CaMeL" gives the reasons.

This is the integrity half of CaMeL (Debenedetti et al., 2025,
[arXiv:2503.18813](https://arxiv.org/abs/2503.18813)), with a label for each
Session and not for each value.

## Shape

```text
read adapter ──► label: readers + writer ──► Session label (join)
                                                  │
tool call ──► evaluateFlowLabelSink ──► decideExit (readers, Plan 27C)
                                    └─► decideWriter (this plan)
                                                  │
                          allow │ approval_required │ deny
                                                  │
                    toolEffectPassesExit ──► passOrAskForExitApproval
                                                  │
                              the Allow prompt, with the exact action
```

Three parts, each at a place that exists:

| Part            | Where                                       | Work                                                                     |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| Source declares | `source-labels.ts`                          | The read capability of a source says if its text is outside-written      |
| Kernel decides  | `sinks.ts`, beside `decideExit`             | A consequence class for each capability, and the writer rule             |
| A block asks    | `toolEffectPassesExit` and the Allow prompt | A third reason, `outside_written`, and a prompt that shows the arguments |

The kernel stays one policy engine. The writer rule runs after the reader
rule, so a private block still wins.

## What counts as outside-written

The rule is about free text. A typed fact (an amount, a date, a status, an
identifier that Satyr matched to a record) cannot hold an instruction, so it
does not set the writer.

| Source                                                                                               | Writer                                 | Phase |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------- | ----- |
| Email bodies, subjects and attachments (`email_mailbox_search`, email Case reads)                    | `outside`                              | 1     |
| WhatsApp customer messages (`whatsapp_support_read`, WhatsApp Case reads)                            | `outside`                              | 1     |
| Fetched pages and documentation (`read_message_link`)                                                | `outside`                              | 1     |
| Free text of commerce records: order notes, customer names, supplier replies                         | `outside`, when a read returns it      | 2     |
| Slack Connect messages from another company's people                                                 | `outside`, when a read returns it      | 2     |
| Data of a service that the Organisation connected with its own account: Airtable, a custom connector | not set (owner's decision, 2026-11-11) | —     |
| A member's own message, screen observation and chip                                                  | not set                                | —     |
| A file that a member attached                                                                        | not set (decision 3)                   | —     |
| Memory that a person accepted                                                                        | not set                                | —     |
| Structured facts of Satyr's own records                                                              | not set                                | —     |

A person's review removes the writer only for what that person accepted as a
new record: an accepted Memory, an approved proposal. The review card must
show that the text came from an outside source, so that the person knows what
they accept. A summary by a model removes nothing.

## Which effects ask

Each capability gets a consequence class in `sinks.ts`.
`pnpm lint:ifc-boundaries` refuses a capability with no class, as it does for
the reader classes.

| Effect in a Session with an outside writer                                                         | Result                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The answer to the turn's own conversation                                                          | Passes. A person reads it.                                               |
| A `read`                                                                                           | Passes. Grants decide reads.                                             |
| A `surface` view command (open a tab, select a product)                                            | Passes. It changes one person's view.                                    |
| A `proposal` (a card that a person confirms)                                                       | Passes. The card names the outside source.                               |
| An email or Slack message proposal, a custom connector write                                       | Passes. Its own review is the approval, and it names the outside source. |
| A `draft` edit that every member reads                                                             | Asks (decision 2).                                                       |
| A `receipt` effect: order queue, sold out, recipes, costs, suppliers, device pause, Airtable write | Asks.                                                                    |
| `schedule_follow_up`                                                                               | Asks. The later turn keeps the writer.                                   |
| A reply to the same verified sender                                                                | Passes the writer rule. Step 5 limits the direct reply.                  |

Two paths need a check, because an answer can also carry data out or carry a
trap in:

- A link or an image in an answer. If the Portal or Slack fetches a URL from
  an answer with no click, the URL can carry data to an outside server. Step 6
  checks this.
- The workspace executor. If its container reaches the network, a script can
  send data out. Step 6 checks this.

## The prompt

A Plan 27C request names the capability, the account and the resource. That
is enough for a privacy question: "may this content go there?" It is not
enough here. The question is "did you ask for this action?", so the person
must see the action.

- The request stores a digest of the tool's arguments. Allow gives one pass
  to those exact arguments. A call with other arguments asks again.
- The prompt shows the action in plain words and names the outside source.
  Example: "The agent read an email from orders@example.com in this chat. It
  wants to mark Croissant as sold out. Allow?"
- Who decides: the person who asked, if their role holds the capability.
  A request of another member's turn does not exist for them, as today.
- Deny and expiry tell the chat or thread and the agent's next turn, with
  fixed text.

In a Slack thread the turn parks and Allow continues it, as Plan 27C built.
In a Portal chat the prompt opens in place.

## Why not CaMeL

CaMeL makes a plan as code from the person's request only. A custom
interpreter runs the plan and tracks the origin of each value. A second model
with no tools reads the outside text. Outside text can never change the plan.

- **It refuses the main Inbox job.** "Read this email and do what is
  necessary" has a plan that depends on the email. CaMeL cannot run it. The
  paper reports about 67% of AgentDojo tasks solved.
- **It is a second execution model.** Pi owns the turn loop, the history and
  the replay. A planner and an interpreter beside it double that work.
- **The Session label gives most of the value.** Satyr's exits already hold
  each effect at one check. The writer rule stops the same attacks there, at
  the cost of more prompts.

The cost of a Session label is precision. One email in a chat marks each later
effect of that chat. CaMeL would mark only the values that came from the
email. Step 9 gives part of that precision back with a reader model that
has no tools.

## Jev's part

Jev already reads mail with no tools: the `mail_classification` purpose of the
`typesafe_system_one` sink classifies an email against the operator's rules.
It can do two jobs here. They have different trust.

**Job 1: a detector.** Jev reads an outside text and answers one typed
question: does this text try to instruct an agent? The answer can only make
Satyr stricter:

- The email goes to a quarantine folder, and no agent turn starts for it.
- The mailbox agent sends no direct reply for that thread.
- The Allow prompt and the review card show a warning.

A detector never removes the writer and never lets an effect pass. It is a
model that reads the attacker's text, so an attacker can write text that it
calls safe. A detector that could clear a label would become the one thing to
attack. Content that Jev calls safe is still outside-written.

**Job 2: the quarantined reader.** This is the reader model of CaMeL, and it
is step 9. Jev reads the outside text and fills a fixed schema. The rule for
its output:

- A typed field sets no writer: an enum, a date, an amount, a boolean, an
  identifier that Satyr matched to one of its own records.
- A free text field (a summary, a quote, a name) keeps the writer.

So the chat agent can ask "which orders does this email name, and what does
the sender want?" and get `{ intent: "delivery_change", orderId, date }` with
no mark on the chat. If the person also wants the body, the read sets the
writer and the exit rule applies.

Both jobs need a new purpose on the sink, a Jev feature switch and a place in
the monthly allowance (Plan 88). With Jev off, job 1 gives no warning and job
2 falls back to the marked read. The exit rule does not depend on Jev.

## Order of work

Each step lands on its own and keeps Satyr safe.

1. **The writer in the label.** Add the optional writer to a policy, the join
   and the digest. A policy with no writer keeps its stored digest, as a
   policy with no level does. No rule reads it yet.
2. **Sources declare.** The phase 1 adapters set `outside`: the mailbox
   search, the email Case reads, the WhatsApp reads and the link read. Extend
   the lint: a new source kind states its writer.
3. **The exit rule and the classes.** Give each capability a consequence
   class. Add the writer rule to `evaluateFlowLabelSink`, with the reason
   `aifc.outside_written`. Until step 4, each caller refuses the result, so
   release steps 3 and 4 together.
4. **The prompt.** Add `outside_written` to `held_output_request.reason`,
   with a D1 patch script for each regional database. Store the arguments
   digest and a short plain description of the action. Show them in the
   Portal prompt and in the Slack card. A pass matches the arguments.
5. **The agents with no person.** The mailbox agent sends `email_reply_now`
   only when two code rules pass: the sender is a verified contact, and the
   turn read nothing but the admitted messages and the playbook. Any other
   reply becomes a draft for approval. Apply the same review to the WhatsApp
   agent's tools. Keep the prompt text; it is no longer the control.
6. **The two checks.** Test if an answer's link or image is fetched with no
   click in the Portal and in Slack. Test if the workspace executor reaches
   the network. Fix each one that leaks, or record why it cannot.
7. **Phase 2 sources.** Checked: no agent read returns the free text of
   commerce records or a Slack Connect message today ("Built" gives the
   proof). The first read that does marks its label in the read adapter, so
   that an order read without its note sets no writer.
8. **The Jev detector.** Add the purpose `injection_detection` and its Jev
   feature switch. A positive answer quarantines the email, stops the direct
   reply and adds the warning to the prompt and the card. Measure it on a set
   of real mail and known attacks before it quarantines anything: a false
   positive hides a customer's email.
9. **The Jev reader (optional).** Add a typed mail read for the chat agent:
   Jev fills a fixed schema, and Satyr matches each identifier to a record.
   Typed fields set no writer, so the chat stays unmarked. Build this only if
   the prompts of steps 3 and 4 are too many in real use.

## Built

Steps 1 to 4 were built first on local dev. Steps 1 to 6 are in production since
11 November 2026 (satyr-edge `cd1ee9cb`); see the status line.

- **The writer is on the label, not on a policy.** A public page has no
  policy, so a policy could not carry it. A label with no writer keeps its
  stored digest.
- **The kernel declares the sources.** `OUTSIDE_WRITTEN_READ_CAPABILITIES` in
  `source-labels.ts` names `email.mailbox.read` and `whatsapp.support.read`.
  A label that is derived again for the same source gets the same writer.
- **An accepted Memory enters a turn with no writer**
  (`acceptedByPersonFlowLabel`). The stored label keeps it.
- **The pass list is short.** `PASSES_AFTER_OUTSIDE_TEXT` in `sinks.ts` names
  the reads and the steps with their own review. Each other capability asks,
  so a new capability asks until a person adds it there. No lint is necessary.
- **Two rules can stop one effect.** A pass for a reader block did not show
  the action, so the writer rule then asks with its own request.
- **One Allow covers one exact action.** The request stores the digest of the
  operation and its arguments, and the values that the prompt shows
  (`agent-tools/effect-action.ts`). The pass matches the digest, not the
  label: a later request can carry more of the person's own context.
- **Only the person who asked sees and decides the request.**
- **A Portal chat keeps the writer in its later messages.** Step 10 of
  `tests/e2e/chat-agent-recipes-suppliers.test.ts` proves it: a chat reads
  outside text, and a later message of that chat saves a recipe only after the
  person allows it. A new chat of the same person has no writer.
- **A staff page action asks before it uses a pass.** Such an action has two
  checks: its own, and the check of content that every member reads. In a
  private chat both can ask. The action asks for each missing approval first
  and uses the passes together, so the person gets two prompts and no loop.
  The second check does not ask the writer question again.
- `tests/e2e/outside-written-effect.test.ts` is the journey: stopped, shown
  with the exact record, refused for another member, allowed one time, asked
  again for another record, and no question with no outside text.

Step 5, on local dev:

- **The mailbox agent's choice of a direct reply is a request.** The Connector
  decides (`mail-inbox/direct-reply.ts`): a direct reply goes only when the
  message came from a verified contact, and the turn read no commerce record
  and no evidence of another thread. Any other reply is a draft for approval,
  and the sender gets the fixed acknowledgement.
- **Only a supplier contact can be verified today.** So each direct reply to a
  customer now waits for a person. Production has no verified contact on
  11 November 2026, so no reply is direct there until a person verifies one.
- **The WhatsApp agent keeps its `answer` mode.** Its tools read only the
  admitted Case, it gets no Memory, and trusted code fixes the recipient. A
  customer cannot be verified, and the operator turns `answer` on for each
  line with the topics that always wait. So the contact rule does not apply.
- The supplier Memory journey in `tests/e2e/mail-inbox.test.ts` proves both
  outcomes: a stranger's message makes the agent choose a direct reply, and
  it becomes a draft that Gmail does not send. The verified supplier's direct
  replies still go.

Step 6, on local dev. The question for each surface: is a link or an image
of an answer fetched with no click? Such a fetch can carry data to the link's
server.

| Surface                | Result                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Portal chat            | No fetch. The answer renderer makes bold, code and `https` links. It makes no image. |
| Slack, streamed answer | No fetch. Slack states that a streamed message has no link or media preview.         |
| Slack, posted message  | **Leak, fixed.** Slack fetched each link of a `chat.postMessage` for a preview.      |
| WhatsApp reply         | No fetch. The send states `preview_url: false`.                                      |
| Email reply            | Plain text, and a person reads each draft.                                           |
| Workspace executor     | No network. The container states `enableInternet = false`.                           |
| Code Mode script       | No network. The QuickJS VM has no network call.                                      |

- **The fix.** Each `chat.postMessage` of Satyr now spreads
  `SLACK_NO_LINK_PREVIEW` (`slack/messages.ts`): the answer that is posted
  whole, the thread notices, the cards and the WhatsApp operator notice. The
  side Case post already refused previews.
- `tests/e2e/slack-held-effect.test.ts` asserts that no post of the journey
  lets Slack make a preview. The Slack fakes read a post through
  `slackPostFields`, which leaves the two flags out.
- **Not checked on real Slack.** The streamed message result comes from
  Slack's documentation. `chat.update` has no preview argument, and Slack
  does not say if an update makes a preview. Satyr updates only cards.
- **A click stays possible.** A link in an answer can carry data in its
  address. The Portal shows the address as the link's text. Slack shows the
  text that the Markdown link gives.

Step 7, checked on 12 November 2026, needs no code. No agent read returns the
text of the two phase 2 sources today:

- **Commerce records name no buyer.** The agent reads commerce through the
  entity graph, the order queue, the payments read and the reports. The graph
  has no customer type. An order, a payment, a fulfillment and a shipment
  hold identifiers, amounts, states and times that Satyr, Underclerk or the
  provider wrote. The pickup queue, the payments read and the failed payments
  read state in their contracts that they name no buyer. The text in the
  graph (a product name, a supplier record, a custom attribute) is text of
  the Organisation's own account, which decision 2026-11-11 trusts.
- **Underclerk stores customer text, and Platform does not read it.** A
  customer record and a draft order have a `note`. No Platform code calls
  those reads.
- **A supplier reply is an email.** Steps 1 to 5 cover it: the mailbox read
  sets the writer, and a fact from a reply becomes a record only when a
  person accepts it.
- **A Slack Connect person cannot reach the agent.** Slack ingress admits a
  message only when its author has an identity link and is a member of the
  Organisation. Satyr reads no thread history and no channel history, and no
  capability reads Slack messages. A message of another company's person
  enters no Case.

The rule for a later change: a read that returns a buyer's name, an order
note, a customer note or a message of a person with no membership calls
`outsideWrittenFlowLabel` on its label before it records the observation, in
the same change. A read that returns only typed facts sets no writer.
`admitCommerceReadObservation` is the one place for a commerce read.

Limits:

- **The journey adds the outside read to the turn directly**, as the Plan 27C
  hold journeys do. No journey reads a real mailbox and then changes a record.
- **The link read sets no writer.** It records no observation today, so it
  needs a source kind first.
- **Shared draft edits, the canvas move and proposals give no action.** Their
  Allow covers one step of the capability, as a Plan 27C pass does.
- **The Slack card links to the Portal prompt**, as each held step does. The
  card does not show the action.
- **A mailbox, WhatsApp or scheduled turn is not marked by its own ingress.**
  Step 5 limits what those agents send.
- `plan-89-held-action-d1-patch.sql` was applied to production
  `satyr-organisation-apac`, the only regional database, on 11 November 2026.
  The schema check passes. Do not apply it again.
- **Released on 11 November 2026, about 09:45 UTC**, as a release of the six
  Workers from dev `e3ae6ee39`. The live version before it was satyr-edge
  `23b8e8b9`, from dev `46b273788`, so the release added only this plan.
  After it: health 200, the live Portal holds the new prompt text, and 75
  seconds of the production log show 20 requests and no exception.
- **Live Slack check, 11 November 2026, 09:45 UTC, in the owner's Chrome.**
  One mention in `#cafe-ops` with the code `live-p89-4d7a` asked for a reply
  with a link. The app gave one reply in 10 seconds, with the code and the
  link, and no second reply in the next 35 seconds. The reply showed no link
  preview. This does not prove the preview setting: the answer was probably
  streamed, and `example.com` gives Slack little to preview.
- **No live check of the writer rule ran.** No signed-in person tried a
  marked chat, and no real email reached a mailbox agent after the release.

## Acceptance

Allowed and denied E2E journeys, one for each outcome. Each one uses the real
adapters and a fake provider that only answers calls.

1. **Chat, injected email.** A mailbox holds an email whose body tells the
   agent to mark a product as sold out. A member asks the chat agent to
   summarise the mailbox. The summary arrives. No product changes, and no
   prompt opens.
2. **Chat, wanted action.** In the same chat the member asks to mark the
   product as sold out. The prompt shows the product and the email's sender.
   Allow changes it once. A second call with another product asks again.
3. **Chat, no outside read.** In a chat that read no outside source, the same
   action runs with no prompt.
4. **Mailbox agent.** An email from an unverified sender that asks for a
   routine answer gets a draft for approval, not a direct reply. A verified
   contact's routine question gets the direct reply.
5. **Persistence.** An email asks the agent to schedule a follow-up and to
   remember a false fact. The follow-up asks. The Memory proposal's review
   card names the email as its source.
6. **Old data.** A Session from before the change keeps its label digest and
   restores.

One live journey before the release: a real email with an injected
instruction to a production test mailbox, read from a Portal chat.

## Cost

Estimates for agent work, with the journeys:

| Step | Estimate |
| ---- | -------- |
| 1    | 1–2 days |
| 2    | 1–2 days |
| 3    | 2–3 days |
| 4    | 3–4 days |
| 5    | 1–2 days |
| 6    | 1 day    |
| 7    | 3–4 days |
| 8    | 2–3 days |
| 9    | 4–6 days |

Steps 1 to 6 are about two weeks and close the gap for email and WhatsApp.

## Risks

- **Too many prompts.** A chat that read one email asks for each later
  consequential effect. A person who allows each prompt without a look gets no
  protection. The exact action in the prompt, a new chat for other work, and
  step 9 reduce this.
- **A source that does not declare.** A new adapter that returns outside text
  and sets no writer is a hole. The lint makes each source state its writer,
  but a person still decides the value.
- **The answer itself.** The agent can repeat a false claim or a bad link from
  an email in its answer. This plan does not stop that. The person reads the
  answer and knows that it used the email.
- **A connected service that holds outside text.** Airtable and custom
  connector data is trusted, because the Organisation connected its own
  account. A base that a public form fills still holds text of outside people.
  This plan does not mark it.
- **A person's own paste.** A member who pastes an email into the chat sends
  it as their own words. The writer is not set.
- **Typed fields are a small channel.** An attacker can still choose an enum
  value or an identifier. Step 9 accepts this, as CaMeL does.

## Decisions for the owner

1. **Where the rule lives.** Recommendation: in the IFC kernel, as above. The
   other choice is a check in the Inbox tools only, which is about 3 days less
   and leaves WhatsApp, links and connectors open. Default: the kernel.
2. **Shared draft edits.** Recommendation: a `draft` edit asks in a marked
   Session, because the menu board shows on shop screens. The other choice is
   that it passes, because a draft keeps its history and a person can undo
   it. Cost of asking: one prompt for each request, with the Plan 40B rule
   "one Allow per request". Default: asks.
3. **Attached files.** Recommendation: a file that a member attached sets no
   writer in phase 1, as the member's own input. The other choice marks each
   attachment, which makes each chat with a supplier's PDF ask. Default: not
   set, and this plan records it as a known limit.
4. **Direct email replies.** Recommendation: keep `email_reply_now` for
   verified contacts only (step 5). The other choice is to remove it, so each
   reply waits for a person. Default: verified contacts only.
5. **The Jev detector.** Recommendation: build step 8 after steps 1 to 6, as
   a warning first and a quarantine only after the measurement. Cost: one Jev
   call for each inbound email, from the allowance. Default: warning only.
6. **The Jev reader.** Recommendation: do not build step 9 now. Decide after
   two weeks of real prompts. Default: not built.
