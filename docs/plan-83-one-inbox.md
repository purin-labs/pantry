# Plan 83 — One Inbox

Status: Phases 1–4 and Phase 6 are in production since 3 November 2026 and proved on
local journeys ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-83/report.md)). The Phase 5 Gmail gate passed
in production on 3 November 2026: one read thread and one reply in the owner's Chrome.
The approval queue in `pages/whatsapp.tsx` is removed (released 3 November 2026). The real
WhatsApp check waits for Plan 32's Meta gates. Date: 3 November 2026. The owner chose
layout B on 3 November 2026. Decisions D2–D6 use their defaults until the owner changes them.
Owners: Satyr platform and Portal.

Mocks: [One Inbox mocks](https://claude.ai/artifact/MwgQsVfnSUPKyXzsmJdJyx). Board B
is the accepted layout. The last board is the agent setting. Phase 6 mocks:
[Inbox without tabs](https://claude.ai/artifact/N2ofpTd1mDFtrrWCjhPARM). The owner
chose board B, one list in sections, on 3 November 2026.

## Outcome and scope

An operator works email and WhatsApp customer conversations in one Portal page: the
Inbox. A list stands on the left and one conversation on the right. The agent is
optional for each channel: no agent, agent drafts, or agent answers.

In scope:

- One list of Gmail and WhatsApp conversations, in sections (Phase 6).
- One conversation pane, with the agent draft in the reply box.
- Take over and return to agent, on the channels that support them.
- One agent setting for each channel.
- A person-written email reply, which "No agent" needs.

Out of scope:

- Slack, shop chat and commerce approvals in the list. The Inbox redesign named them
  as phase 3. This plan builds the list so that a later source can join it.
- A chat widget for a merchant's website. Satyr builds no merchant websites.
- Assignment to a teammate, which the Intercom screenshots show.
- WhatsApp media, templates and messages outside the 24-hour window (Plan 32).
- A new way to store WhatsApp text. Plan 32's content limits stay.
- "Agent answers" on email (D4).

## What exists today

| Part | Email Inbox (Plan 29-F) | WhatsApp console (Plan 32) |
| --- | --- | --- |
| Portal code | `features/mail-inbox/route.tsx` | `pages/whatsapp.tsx` |
| List source | `GET …/email-reviews`: replies that wait for review | `GET …/whatsapp-replies`: proposals only |
| List text | `headline`, read from Gmail, at most 10 threads for each request | Customer number, no message text |
| Conversation | `conversation.tsx` | Case panel, read from `ConnectorActor` |
| Draft editor | `reply-draft-editor.tsx`, with shared drafts (Plan 40D) | Edit makes a new proposal version |
| Sources | `draft-sources.tsx`, `claim-trace.tsx` | None |
| Read authority | `authorizeMailSource`: the person's grant and label check | The `viewer` role |
| Send authority | The `admin` role | The `admin` role |
| Agent off | `MailAgentState` kind `off`. No reply path remains | No setting. Each topic match sends at once |
| Person reply | None found: a reply starts from an agent draft | `sendHumanReply` after takeover |

The two surfaces share no code path, and neither names the other channel.

## Layout

Board B is the page:

- The Portal sidebar stays open. The list is about 340 px wide. The conversation
  takes the rest.
- The list head holds the search and the channel filter. Phase 6 replaced the three
  tabs (**Needs you**, **Agent**, **Handled**) with sections in one list.
- The list's sections: **Waiting for you** (longest wait first), **The agent answered**
  (only when it has rows) and **Other mail** (the mailbox's newest mail that waits for
  nobody). Each thread shows once. **Done**, **All mail** and **Spam** are views below
  the sections. Mailbox rules stay in the list head's menu.
- A row shows the sender, the wait time, one line of text, the channel and one state.
- The conversation shows the messages as bubbles. The reply box stays at the bottom.
- The agent draft fills the reply box. **Edit** opens the shared draft editor (Plan 40D)
  in the box, and **Save draft** makes the next version. **Approve and send** sends the
  exact version that the person sees. Plan 40D's version rules do not change.
- "Conversation details" and "Sources" stay folded, above the reply box.
- After a send, the next conversation that needs a person opens. This replaces
  **Review all**, which goes after Phase 2 passes (D6).
- At a narrow width, the page shows the list or the conversation, one at a time.

This layout is an exception to the Portal rule of one list and a side drawer. The owner
accepted it for this page only.

The agent menu on the mocks is for the demonstration. In the product, the setting is
the sheet on the last board. An admin opens it from the list head.

## Contract

`packages/control-api/src/inbox.ts` owns one TypeBox contract. Email rows keep the wire
items of `GET …/email-reviews`, so that the Inbox's email model does not change.

```ts
type InboxConversations = {
  ok: true;
  email:
    | { kind: "read"; reviews: unknown[]; unanswered: InboxUnansweredThread[] }
    | { kind: "failed" };
  whatsapp:
    | { kind: "none" }
    | { kind: "failed" }
    | {
        kind: "read";
        conversations: InboxWhatsAppConversation[];
        truncated: boolean;
        // The first number that the person may not read, for the prompt.
        refused: PermissionRequired | null;
      };
};
```

A WhatsApp row has one state: `reply_waiting`, `handoff_requested`, `no_reply_yet`,
`send_uncertain`, `agent_handled`, `person_replied` or `closed`. The pure functions
`whatsappConversationState` and `whatsappConversationTab` decide the state and the tab.

## Read path

`GET /v1/control/organisations/:id/inbox-conversations?tab=&channel=` is one new route
under `services/platform/src/control/routes/`. It reads each source under that source's
own authority and joins the results.

Email:

- A mailbox with no agent lists its newest threads whose newest message is not from the
  mailbox (`unanswered`). One read asks Gmail about at most 10 threads for each mailbox.
- It reuses `listEmailReviewProjections` and `email-review-headlines.ts`. The current
  **Handled** rows come from the same replies, through `handledMailDrafts`.
- `EMAIL_REPLY_HEADLINE_LIMIT` stays 10. A row without a headline says "Open to read".
- `GET …/email-reviews` asks only for the `viewer` role. The new route also runs
  `authorizeMailSource` for each mailbox and each read, and it drops the rows of a
  mailbox that the person cannot read.

WhatsApp:

- A new D1 read lists the open rows of `whatsapp_case_conversation_window`. The index
  `idx_whatsapp_case_conversation_window_open` already exists.
- It joins the proposal projection for the state.
- One new `ConnectorActor` RPC returns the newest customer text for the open Cases of
  its account. The text is decrypted for the response and stored nowhere else.

Both:

- The route uses `no-store`, as the Case panel does.
- Each source is bounded. The first version has no merged cursor. `truncated` makes
  the list say that more exists.
- If one source fails, the list shows the other source and one plain line about the
  failure.
- "Waiting for you" sorts the longest wait first. The Inbox has this rule already.

## Conversation and actions

The conversation pane has one component for each channel, inside one frame.

- Email reuses `conversation.tsx`, `reply-draft-editor.tsx`, `draft-sources.tsx` and
  the existing `email-replies/:id/…` actions. The version, digest and approval rules of
  Plan 40D do not change.
- WhatsApp moves the Case panel and its reply actions out of `pages/whatsapp.tsx`. The
  `whatsapp-cases/:id/…` and `whatsapp-replies/:id/…` routes and the send ladder do not
  change.

`pages/whatsapp.tsx` keeps connection, agent binding, ingress policy and reconnect. Its
approval queue went after the production proof in Phase 5; the page now says that
conversations and replies are in the Inbox, and it no longer reads the reply queue.

## Agent setting

| Setting | Email | WhatsApp |
| --- | --- | --- |
| No agent | Mailbox agent `off`. A person writes each reply (Phase 4) | No cue decision and no agent turn. The acknowledgement still goes |
| Agent drafts | Mailbox agent `on`, as today | New: the reply stops at `awaiting_approval` |
| Agent answers | Locked (D4) | Today's behavior: the cue match sends at once |

WhatsApp changes:

- `whatsapp_ingress_policy_revision` gets `agent_mode`, with the values `off`, `draft`
  and `answer`. The existing rows get `answer`, so that no live behavior changes.
- The change goes in the three D1 baselines, with a patch script for each bound
  database. `pnpm lint:d1-patch` checks this.
- In `draft`, the cue does not select the message, and no automatic acknowledgement goes,
  because the setting promises that a person approves each reply. An agent turn prepares
  one draft, stores the proposal and does not dispatch it. The conversation shows
  under **Waiting for you**. The agent's instructions say that a person approves the reply.
- `draft` starts one model turn for each message, so it costs more than `answer`, where
  a message without a topic match starts none. `daily_agent_token_budget` still limits
  it. When the budget ends, the conversation shows "No reply yet".
- In `off`, the composer does the takeover and the send as one person action. The
  ownership reason stays `operator_takeover`.
- A send refuses a Case that another person owns (`whatsapp_case_not_owned`). The pane
  names that person.
- For email, the Portal type `MailAgentState` has the kind `off`, and the Inbox can turn
  the agent on from it. Phase 3 confirms which action turns it off, or adds one.
- D5 adds a topic list that always waits for a person. It is checked before the cue
  match, and a match forces `draft` for that turn.

The cue match today is a word match in `whatsapp-case-processing.ts`. A question about
an allergy that contains the word "orders" can match. D5 exists for this reason.

## Access and information flow

- A list preview is source-derived content, so it follows the
  [IFC integration guide](../services/platform/src/policy/information-flow/README.md).
- The route reads with the requester's live authority and stores nothing.
- A person without a mailbox grant sees no row from that mailbox.
- A refused source raises the access request modal in the page. It does not send the
  person to the Access page.
- A person without the `admin` role can read a draft, and sees a request for send
  access in place of **Approve and send**.
- A WhatsApp reply stays bound to its Case. The client cannot select the recipient.
- D2 adds one capability for WhatsApp text. New capabilities need the backfill from
  `scripts/capability-policy-backfill-sql.mjs`.
- `pnpm lint:ifc-boundaries` and one allowed and denied journey close this work.
- The grant also guards `GET …/whatsapp-cases/:id` and `GET …/whatsapp-replies/:id`, so a
  viewer cannot read the text through the older routes.

## Model review and consent

Gmail's restricted scopes fall under Google's Limited Use rules. Mail goes to a model
only to answer it, and no one trains a model on it. The Google app for Gmail is "In
production" and not verified yet, so the code holds the rule (D7).

- Purin reviews each model route one time, in code:
  `services/platform/src/mail-inbox/contract/gmail-model-reviews.ts`. A review names
  the route, the terms that it read, who receives the mail, the purpose, `reviewedAt`
  and `reviewExpiresAt` (90 days later). A route enters the list only when its requests
  enforce the rule in code. On Pantry's paid route, every OpenRouter request sets
  `data_collection: "deny"`, and a reviewed model also sets `zdr: true`
  (`pi-model-transport.ts`).
- Reviewed on 2026-11-22: Gemini 4 Hydrogen and Kimi K3 on the paid route. Left off,
  with the reason in the file: Qwen3.7 Flash (no zero-retention endpoint), an
  Organisation's own OpenAI, Anthropic or Gemini key (the provider keeps each prompt for
  an abuse check, and Pantry cannot see the account's terms), a ChatGPT sign-in and a
  Claude account (the person chooses model training in their own settings).
- In the Gmail drawer and in the Inbox sheet, one checkbox above **Turn on** accepts
  that new mail goes to the named model under its terms. Turn on sends
  `POST …/agent-mailboxes/{account}/model-consent` and then the policy, in one press.
  The acceptance and its receipt are one batch in `gmail_inference_eligibility`:
  the review's fields, `consent_reference` (the receipt), `consented_at` and
  `consented_by_user_id`.
- Each dispatch reads the row against the list. A new pinned model, new terms, a route
  that leaves the list or an ended review stops new mail. The drawer then asks for the
  checkbox again, with **Continue** while the mailbox is on. A model that is not on the
  list keeps Turn on disabled, with "Purin has not reviewed this model for email yet".
- Turn off and Remove withdraw each acceptance (`revoked_at`) when no mailbox of the
  Organisation stays on.
- The chat agent cannot give this acceptance. The route admits only an owner or admin
  with a Portal session, and no agent tool or Code Mode capability reaches it. The
  acceptance is a person's own agreement to send the Organisation's mail to a third
  party, so an agent that reads that mail must not give it for them (Plan 81 and
  Plan 89).

## Limits that the product must show

- Satyr keeps WhatsApp text for at most 24 hours, and until the Case closes. A closed
  WhatsApp conversation in **Done** shows the number, the times and the receipt, but
  no text. Board B shows old text on such a row. The product cannot do this (D3).
- Satyr can send a WhatsApp reply only inside the 24-hour window. When the window ends,
  the reply box says so and refuses the send.
- WhatsApp rows show the customer number. Satyr stores no customer name for them.
- `send_indeterminate` stays visible as "We do not know if this reply was sent". It is
  never retried automatically, on either channel.
- WhatsApp has no live Meta evidence. Plan 32's external gates stay open, and an
  organisation without a connected number sees an email-only page, with no channel
  filter.
- When Google refuses a mailbox's sign-in (`invalid_grant`), the first read marks the
  account `reauth_required` (`provider_grant_refused`) with one conditional write. The
  Inbox lists the mailbox as `reconnect_required` for each person with its read grant,
  shows "Reconnect Gmail" in place of the mail, and asks Google no more. A reconnect
  makes the account active again.

## Phases

### Phase 1 — Two panes for email

Move the current Inbox to layout B. It uses the current reads and actions. The
drawer code stays until Phase 2 passes.

Gate: the mail journeys pass, and one browser journey approves a draft and then works
the next conversation, with light, dark and 390 px screenshots.

### Phase 2 — WhatsApp in the list

Add the contract, the route, the actor RPC and the WhatsApp conversation pane. Remove
the drawer and **Review all** after the gate passes.

Gate: the journey in [Verification](#verification), on the fake Graph API.

### Phase 3 — Agent setting

Add `agent_mode`, the `draft` and `off` branches, the always-wait topics, the sheet
and the capability from D2.

Gate: with each setting, one customer message gives the outcome in the table above,
and `off` starts zero model turns.

### Phase 4 — Person-written email reply

Add one email reply with a person as the author:
`POST …/agent-mailboxes/:id/person-reply`. The recipient comes from the thread. The reply
needs the `admin` role and the mailbox grant, and a waiting draft refuses it. It sends once
with a fixed Message-ID. If Gmail does not confirm the send, the route looks up that
Message-ID, answers `send_indeterminate` if it finds nothing, and never sends again. The
mailbox connector's runtime is off in this case, so this route does not use its ladder.

Gate: with the agent off, one real Gmail reply reaches a controlled mailbox, with its
receipt and in the correct thread.

### Phase 5 — Production acceptance

Release. Check one real Gmail conversation in production, in the owner's Chrome. Then
remove the approval queue from `pages/whatsapp.tsx`.

Gate: Gmail passes. The WhatsApp gate stays open until Plan 32's Meta gates pass, and
the status of this plan says so.

Result, 3 November 2026: the Gmail gate passed. The owner sent a test mail from a second
Gmail account; the reply went from the production Inbox, showed in the thread as "From
this mailbox", and the row moved from Waiting for you to Other mail. The approval queue
is then removed from `pages/whatsapp.tsx`.

### Phase 6 — One list in sections

With a real mailbox, the tabs hid normal mail: **Needs you** said that no decision
waited while the mailbox held 20 messages, and normal mail sat behind **Handled** and
**All mail**. Phase 6 removes the tabs:

- One list in sections, each always open, as the Portal's flat-flow rule asks:
  **Waiting for you**, **The agent answered** and **Other mail**. A thread that waits,
  or a thread with a decided draft and no newer mail, does not show again in Other mail.
- The search is always in the list head. A search shows its results in All mail.
- **Done** lists the decided drafts and the closed WhatsApp conversations. Done, All
  mail and Spam are small views below the sections. Back to the Inbox reads the newest
  mail again.
- In the conversation, a web address in mail text shows as a short link: the host, with
  the whole address as the link's title. A sender such as `noreply@` gets the line "This
  sender does not take replies." in place of the reply box.
- Mail from such a sender waits for nobody. For a mailbox with no agent, it is not in
  Waiting for you and does not count in "decisions need you"; it shows in Other mail.
  The real mailbox showed GitHub and Google Payments mail as waiting before this rule.
  The Portal and the server use one rule, `takesNoReplies` in `@satyr/control-api`.
- The app's toolbar keeps its band above the conversation. The list reaches the top of
  the window, as before.

Not in Phase 6: Gmail categories, an archive or "clear" action (it needs a Gmail write
and an agent tool), and Done for a person's own email reply, which stays in Other mail.
The change adds no action, so the Portal chat agent needs no new tool.

Gate: the eight Inbox browser journeys pass, and the One Inbox journey proves the
sections, Done, a no-reply sender and a short link.

## Verification

The fakes for Gmail and Graph only record and answer calls. Product code must produce each
outcome. [The evidence report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-83/report.md) lists each run and its result.

- `tests/e2e/inbox-whatsapp.test.ts`: the refusal and its grant through the Access routes,
  the row, a stale digest, one approved send, takeover, one person reply, the agent setting,
  a send after the window, and a closed row with no text.
- `tests/e2e/mail-inbox.test.ts`, "person-written reply": the unanswered row, the recipient
  from the thread, an unconfirmed send, a repeated request, and a revoked mailbox grant.
- `tests/e2e/mail-inbox-reconnect.test.ts`: Google refuses the sign-in, the reconnect state
  for the owner and an admin, no mailbox for a viewer, one call to Google for four reads, a
  refused reconnect for a viewer, and mail read again after the owner's reconnect.
- `tests/whatsapp-case-processing.test.ts`: each agent setting and the topics that always wait.
- `scripts/mail-inbox/verify-browser-one-inbox.js`: the merged list, the filter, the pane, the
  next conversation, the composer, the sections and Done, a failed source, the prompt,
  the sheet, and a no-reply sender with a short link.
- The seven earlier Inbox browser journeys pass on the two panes.

Run `pnpm --filter satyr-edge check:types`, `check:test-types`, `pnpm portal:build`,
`pnpm lint:ifc-boundaries` and `pnpm lint:d1-patch` before each release.

## Decisions

| ID  | Decision                  | Recommendation                                                                        | Cost                                                                 | Default                             |
| --- | ------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| D1  | Layout                    | B, two panes                                                                          | Accepted by the owner                                                | Accepted                            |
| D2  | Who reads WhatsApp text   | A person grant, as for a mailbox, with the access modal                               | One capability and one backfill. A viewer loses access until granted | Grant                               |
| D3  | WhatsApp text after close | Keep Plan 32's limit                                                                  | **Handled** rows have no text                                        | Keep the limit                      |
| D4  | "Agent answers" on email  | Stay locked                                                                           | Each email waits for a person                                        | Locked                              |
| D5  | Topics that always wait   | Add a list, with allergens as the first value                                         | One policy field and one journey step                                | Add                                 |
| D6  | **Review all**            | Remove it after Phase 2                                                               | One button goes. Auto-next does its work                             | Remove                              |
| D7  | Gmail model gate          | Purin reviews each model route in code; the owner accepts its terms with one checkbox | A review in code every 90 days; mail stops when a review ends        | Accepted by the owner on 2026-11-22 |

## Risks

- `route.tsx` is about 75 KB and holds search, Spam, rules and Review all. Phase 1 moves
  the layout only, so that a fault has one cause.
- Production has no proof of real WhatsApp traffic in this page. The channel filter and
  rows appear only with a connected number.
- A list read makes Gmail and actor calls for each view. Phase 2 measures the read and
  records the time, because the Inbox is a page that people keep open.
