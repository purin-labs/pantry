# INB-01 — One Inbox

The Inbox of Purin Pantry is one Portal page for customer conversations by email
(Gmail) and WhatsApp. A list stands on the left and one conversation on the right. Each
channel has an optional agent: no agent, an agent that drafts, or (on WhatsApp only) an
agent that answers. The mailbox agent drafts Gmail replies as reply proposals. A person
edits a proposal in a shared reply draft and approves the exact version that they see.
Each source is read under its own authority, with the person's live grants, and the page
stores nothing of a WhatsApp message. Pantry never sends an unconfirmed reply again.

## What it does

### The page

- The page has two panes. The list is 348 px wide (`--mail-list-width`) and the
  conversation takes the rest. Below 1159 px, the page shows the list or the
  conversation, one at a time. This layout is the one exception to the Portal rule of
  one list and a side drawer.
- The list head holds the search, the mailbox status menu, the agent setting (owner and
  admin only) and the processing menu. The channel filter (**All channels**, email,
  WhatsApp) shows only when a WhatsApp number is connected. The filter works in the
  Portal; the server always returns both sources.
- One list has three sections, each always open:
  - **Waiting for you**: email drafts that wait for approval, mail with no reply from a
    mailbox with no agent, and WhatsApp conversations that need a person. The longest
    wait is first.
  - **The agent answered**: WhatsApp conversations that the agent owns. It shows only
    when it has rows.
  - **Other mail**: the newest mail of the open mailbox that waits for nobody, one row
    for each thread. A thread that waits, or a thread with a decided draft and no newer
    mail, does not show again here.
- **Done**, **All mail** and **Spam** are views below the sections. Done lists the
  decided email drafts and the closed or person-answered WhatsApp conversations. All
  mail and Spam are pages of Gmail's own folders; a search shows its results in All
  mail. The agent reads nothing in Spam.
- The summary line counts what waits: "3 decisions need you. The oldest has waited …".
  A member who is not an owner or admin reads "3 reply drafts wait for approval." That
  count also holds the waiting WhatsApp conversations and the mail with no reply.
- A row shows the sender, the wait time, one line of text, the channel and one state. An
  email row with no headline shows the thread's message from the loaded page, or "Reply
  draft".
- In a message, a web address shows as a short link: its host, with the whole address as
  the link's title (`linkedText` in `thread.tsx`).
- If one source fails, the list shows the other and one line: "Email could not load.
  Other channels still show here." The WhatsApp line is the same. If more WhatsApp
  conversations exist than the list shows, a line says so.
- After a send, the next conversation that waits for a person opens.

### An email conversation

- The pane shows the messages as bubbles, the "Sources" of a current draft,
  "Conversation details" and the reply box at the bottom. These sections are always
  open.
- A waiting draft fills the reply box as "Suggested reply", with the recipient. The
  actions are **Approve and send**, **Edit** and **Reject**. **Edit** opens the shared
  reply draft in the box, and **Save draft** makes the next proposal version.
- The claim trace marks each run of words that a record supports, with the numbers of
  its sources (`draftClaims` in `claim-trace.tsx`). Other words of a sentence that state
  a detail, such as a number, a day, a price or "free", show as unsourced.
- An owner or admin can select **Correct purchasing link** under a waiting draft. The
  `relationship` action previews a supplier or a purchase request, and `correct` links
  the draft to it as a new version.
- With no draft, an owner or admin writes the reply in a composer with a formatting
  toolbar and files. A sender such as `noreply@` gets the line "This sender does not
  take replies." in place of the reply box (`takesNoReplies`).
- If Gmail does not confirm a send, the pane says "Send not confirmed" and "Purin Pantry
  does not retry it". An owner or admin can select **Check send state in Gmail**.
- When Google refuses the mailbox's sign-in, Other mail shows "Google refused the Gmail
  sign-in for …". An owner or admin gets a **Reconnect Gmail** link to Integrations.
  Another member is told to ask an owner or an admin.

### A WhatsApp conversation

- The pane reads the Case panel with its text. It shows the 24-hour window ("You can
  reply until the window closes …").
- A waiting proposal has **Approve and send**, **Edit** and **Reject**. **Edit** shows
  the body in a box with **Save draft** and **Close**.
- An owner or admin writes a reply when the Case is `human_owned`, `no_reply_yet` or
  `handoff_requested`, and no draft waits. One select sends `take-over` when the Case
  is not `human_owned`, and then `human-reply`.
- On an open conversation, an owner or admin has the menu "Conversation options":
  **Take over** (or **Return to agent** when the Case is `human_owned`) and **Close
  Case**.
- After a handoff, the pane says "The agent asked for a person: …" with the agent's
  reason. An open conversation shows "Purin keeps WhatsApp text for up to 24 hours."
- When the window ends, the composer goes and the pane says "The 24-hour window has
  ended. WhatsApp does not allow a free reply now."
- A closed conversation shows the number and the times, with no text: "This
  conversation is closed. Purin deleted its text. WhatsApp keeps the full history."
- If another person owns the Case, the send fails with `whatsapp_case_not_owned`, and
  the pane says "Another person owns this conversation. Ask them to return it."
- If the person cannot read a number, the list says "You cannot read this WhatsApp
  number yet." with **Request access**. That opens the access prompt in the page.

The state of a WhatsApp row comes from `whatsappConversationState`, in this order:

| State               | When                                                                                           | Section            |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------------------ |
| `closed`            | The Case closed, or its window ended                                                           | Done               |
| `send_uncertain`    | The proposal is `send_indeterminate`                                                           | Waiting for you    |
| `reply_waiting`     | A proposal is `awaiting_approval` or `approved`                                                | Waiting for you    |
| `handoff_requested` | The agent asked for a person                                                                   | Waiting for you    |
| `person_replied`    | `human_owned`, and the business wrote last                                                     | Done               |
| `no_reply_yet`      | `human_owned` and the customer wrote last; or the customer wrote last and no agent reply comes | Waiting for you    |
| `agent_handled`     | Any other open Case                                                                            | The agent answered |

No agent reply comes when the mode is not `answer`, or when no agent turn is due. A turn
is due when the number is not paused and the Case waits for its next turn, or the turn
runs now (`agentWorks` of `readWhatsAppConversationHeads`). So a customer whose agent
turns ran out, or whose number paused, waits for a person.

### The agent setting

An owner or admin opens the sheet "How should the agent help?" from the list head.

| Setting       | Email                                                                                                  | WhatsApp                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| No agent      | The mailbox agent is off (`disable`). A person writes each reply.                                      | `off`: no agent turn. The fixed acknowledgement still goes.                                                 |
| Agent drafts  | The mailbox agent is on. Each reply is a draft for approval, with one exception (direct reply, below). | `draft`: an agent turn for each message. The reply stops at `awaiting_approval`. No acknowledgement goes.   |
| Agent answers | Not offered for email.                                                                                 | `answer`: a topic match starts a turn, and its reply goes at once. With no match, the acknowledgement goes. |

- In `answer`, the topics that always wait (`always_wait_topics`) are checked first. A
  match holds the reply for a person, as in `draft`. The default list is
  `WHATSAPP_DEFAULT_ALWAYS_WAIT_TOPICS`: "allergy, allergies, allergic, allergen, nut,
  nuts, gluten". The list is at most 2,000 characters.
- The topic match (`decideWhatsAppCustomerMessage` in `whatsapp-case-processing.ts`)
  uses only the newest customer message, after normalization. First, each topic
  matches as a part of the text, so "nut" matches "minute". Then each topic word of 3
  or more letters that is not a stop word matches a whole word. It is not a meaning
  check. The always-wait check (`messageNamesTopic`) matches a one-word topic only as a
  whole word.
- In `draft` and in a held `answer` turn, the agent's instructions say that a person
  approves the reply.
- A number needs message handling turned on in Integrations first
  (`whatsapp_policy_not_enabled`).
- To turn the mailbox agent on from "No agent", the sheet opens the Turn on flow. That
  flow sends `model-consent` and then `policy`.

### The mailbox agent

- Admitted Gmail mail starts a mailbox turn for its email Case
  (`processEmailThreadTurn`). The turn answers the newest admitted message, and a later
  message starts a later turn. The agent reads the Case and its text attachments. It
  ends the turn with one outcome:
  - `email_reply_for_approval`: Pantry saves a Gmail draft and sends the fixed
    acknowledgement `HUMAN_REVIEW_ACKNOWLEDGEMENT`.
  - `email_reply_now`: a direct reply. It goes only when the sender is a verified
    contact and the turn read no commerce record and no evidence of another thread
    (`mailboxReplyDisposition` in `mail-inbox/direct-reply.ts`). Any other choice
    becomes a draft for approval, with the acknowledgement.
  - `email_no_reply`: for mail that needs no answer.
- Only a supplier contact of the same mailbox counts as verified (`verified-sender.ts`).
  So each reply to a customer waits for a person. An owner or admin links a sender to a
  supplier with **Link sender to a supplier** (`sender-links`).
- Gmail reports new mail by a Pub/Sub push. **Refresh** also sends `check`, which reads
  the mailbox's history id and admits it as a push. Only an `enabled` mailbox accepts a
  check.
- A `draft_only` turn saves the draft with no acknowledgement. A `correction_learning`
  turn proposes a Memory from a person's correction (`propose_memory`, `no_memory`).
- Mailbox rules are Jev classifications (`mail-inbox/jev.ts`, model `jev-1.13.0`). The
  menu calls them "Review Inbox rules". The mail assistant proposes a rule or explains a
  saved classification. It has no tools.

### The model gate for Gmail

- Purin reviews each model route in code (`GMAIL_MODEL_REVIEWS`). A review names the
  route, the terms, the recipients, the purpose `email_processing`, `reviewedAt` and
  `reviewExpiresAt`. Only Purin-paid routes on zero-retention models are on the list:
  `google/gemini-4-hydrogen` and `moonshotai/kimi-k3`. Their requests set
  `data_collection: "deny"` and `zdr: true` (`pi-model-transport.ts`).
- The file names each route that is left off, with the reason: Qwen3.7 Flash, an
  Organisation's own OpenAI, Anthropic or Gemini key, a ChatGPT sign-in and a Claude
  account.
- An owner or admin accepts the terms with one checkbox above **Turn on**. The
  acceptance and its receipt are one batch in `gmail_inference_eligibility`
  (`consent_reference`, `consented_at`, `consented_by_user_id`).
- Each mail turn reads the row against the list (`readGmailInferenceEligibility`). A new
  model, new terms, a route that leaves the list, an ended review or a withdrawn
  acceptance stops new mail (`gmail_inference_route_blocked`).
- **Turn off** and **Remove** set `revoked_at` on each acceptance when no mailbox of
  the Organisation stays on.

## Contracts

- `packages/control-api/src/inbox.ts`: `inboxConversationsSchema` and
  `parseInboxConversations`, `whatsappConversationState`, `whatsappConversationTab`,
  `takesNoReplies`, `WhatsAppAgentMode`, `INBOX_PREVIEW_MAX` (200) and
  `WHATSAPP_DEFAULT_ALWAYS_WAIT_TOPICS`. Email rows keep the wire items of
  `GET …/email-reviews`. `refused` is the permission prompt of the first unreadable
  number, typed as unknown.
- Other shapes in `packages/control-api/src/`: `mail-inbox.ts` (accounts, with access
  `readable` or `reconnect_required`), `email-review.ts`, `mail-reply.ts`,
  `mail-reply-document.ts`, `mail-organization.ts`, `mail-assistant.ts` and
  `portal/mail-agent.ts` (`MailAgentState`: `on`, `paused`, `off`).
- `packages/mail-reply-crdt` (protocol `mail_reply_sync.v1`) and
  `packages/inbox-control-api` (Portal frame parsers). `packages/email-draft-crdt` is
  the separate marketing email draft of a Slack thread.
- The Portal: `areas/inbox/ui/features/mail-inbox/` (`route.tsx`, `conversation.tsx`,
  `whatsapp-conversation.tsx`, `reply-draft-editor.tsx`, `reply-composer.tsx`,
  `draft-sources.tsx`, `claim-trace.tsx`, `agent-sheet.tsx`, `turn-on-sheet.tsx`).
  `areas/integrations/ui/pages/whatsapp.tsx` keeps the number's connection, binding, policy
  and reconnect. It says that conversations and replies are in the Inbox.

Control routes under `/v1/control/organisations/:id/`:

| Route                                                                                                       | Role                                         | Purpose                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET inbox-conversations`                                                                                   | Viewer, then each source's grant             | The list (`control/routes/inbox-conversations.ts`)                                      |
| `GET mail-inbox`                                                                                            | Viewer; the grant sets each mailbox's access | The mailboxes                                                                           |
| `POST mail-inbox`                                                                                           | Viewer and the mailbox grant                 | A command: `work`, `reply`, `page` (a Gmail page), `decision` or `classifiedPage` (Jev) |
| `GET mail-inbox/:account/organization`, `GET`, `POST …/assistant`                                           | Viewer and the mailbox grant                 | Rules; the mail assistant                                                               |
| `POST mail-inbox/:account/organization`                                                                     | Admin and the mailbox grant                  | Publish rules                                                                           |
| `GET email-reviews`                                                                                         | Viewer                                       | The draft queue; headlines only for readable mailboxes                                  |
| `GET email-replies/:id`                                                                                     | Viewer and the mailbox grant                 | One draft, its sources and an approval challenge                                        |
| `POST email-replies/:id/{approve,reject,resolve,edit,relationship,correct,draft-save,draft-reload}`         | Admin and the mailbox grant                  | Decide or change a draft                                                                |
| `GET email-replies/:id/draft/socket`                                                                        | Viewer; the room checks the grant            | The shared reply draft                                                                  |
| `POST agent-mailboxes/:account/person-reply`                                                                | Admin and the mailbox grant                  | A person's own email reply                                                              |
| `GET agent-mailboxes/:account`                                                                              | Viewer                                       | The mailbox agent state                                                                 |
| `GET agent-mailboxes/:account/setup`                                                                        | Admin                                        | The setup plan                                                                          |
| `POST agent-mailboxes/:account/{bind,policy,resume,skip-and-resume,reconnect,disable,revoke,model-consent}` | Admin                                        | The mailbox agent                                                                       |
| `POST agent-mailboxes/:account/check`                                                                       | Admin                                        | Look for new mail now                                                                   |
| `POST agent-mailboxes/:account/sender-links`, `…/sender-links/read`                                         | Admin; viewer and the mailbox grant          | Link a sender to a supplier; read the link                                              |
| `GET email-operational/:id`                                                                                 | Admin, or viewer and the mailbox grant       | One outbound mail that the agent proposes, and an approval challenge                    |
| `POST email-operational/:id/{approve,reject,edit,attest-present,attest-absent}`                             | Admin                                        | Decide or change the proposed mail                                                      |
| `GET whatsapp-cases/:id`, `GET whatsapp-replies/:id`                                                        | Viewer and `whatsapp.support.read`           | The Case panel; one proposal                                                            |
| `POST whatsapp-cases/:id/{take-over,return-to-agent,human-reply,close}`                                     | Admin                                        | Ownership and a person's reply                                                          |
| `POST whatsapp-replies/:id/{approve,reject,edit,resolve}`                                                   | Admin                                        | Decide a proposal                                                                       |
| `POST whatsapp-accounts/:account/{select,bind,policy,…}`                                                    | Admin                                        | The number, and `{agent: {agentMode, alwaysWaitTopics}}`                                |

The preview of an operational draft shows the recipient, the subject and the body
(`mayReadOperationalEmailDraft`). An owner or an admin reads it, because they decide
it. Another member needs a grant for the mailbox: on a full mailbox the read of a reply
draft (`authorizeMailSource`), on a send-only mailbox `email.operational.propose` on
that exact account. Any other member gets `email_operational_not_found` (404), as for
an unknown id. The chat approval card reads the same route.

The email reply actions (except `relationship`), the person reply and the WhatsApp
actions replay their receipt for the same `Idempotency-Key`.

**The list read.** `GET inbox-conversations` reads both sources at the same time and
returns `no-store` JSON.

- Email: up to 100 reviews (`EMAIL_REVIEW_LIMIT`), kept only for mailboxes that pass
  `authorizeMailSource`. Headlines come from Gmail for at most 10 waiting threads
  (`EMAIL_REPLY_HEADLINE_LIMIT`). For each mailbox with no agent, it reads the Gmail
  `INBOX` and lists up to 10 threads (`UNANSWERED_THREAD_LIMIT`). A thread lists when
  its newest message is not from the mailbox and its sender takes replies.
- WhatsApp: `{kind: "none"}` with no selected number. For each readable number, up to
  50 windows (`WHATSAPP_WINDOW_LIMIT`), open ones first, and `truncated` when more
  exist. `readWhatsAppConversationHeads` on the `ConnectorActor` decrypts the newest
  customer text of the open Cases (at most 200 characters, `WHATSAPP_PREVIEW_MAX`).
  The response is the only place that holds it. The read takes only the 100 newest
  WhatsApp reply proposals of the Organisation (`WHATSAPP_PROPOSAL_LIMIT`). A Case whose
  open proposal is older than those 100 gets its state with no proposal.

**Records.** The regional D1 baseline is
`workers/platform/migrations-regional/0001_current_schema.sql`:

| Table                                                                             | Holds                                                                                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `email_thread_case`, `email_message_receipt`                                      | The Case of a Gmail thread; each admitted message, with no text                                                              |
| `email_reply_proposal`                                                            | A copy of each reply proposal (`current_version`, `lifecycle_kind`)                                                          |
| `email_operational_proposal_projection`                                           | A copy of each outbound proposal                                                                                             |
| `mailbox_ingress_policy(_revision)`, `agent_mailbox_binding(_revision)`           | The mailbox agent setting (`enabled`, `disabled_by_operator`) and limits                                                     |
| `gmail_inference_eligibility`                                                     | The acceptance of a reviewed model route                                                                                     |
| `contact_endpoint_verification`                                                   | A verified contact endpoint (`verified`, `revoked`)                                                                          |
| `mail_classification`                                                             | Jev rule outcomes (`matched`, `not_matched`, `needs_review`)                                                                 |
| `whatsapp_case_conversation_window`                                               | Each Case: ownership (`agent_active`, `human_owned`), reason (`operator_takeover`, `agent_handoff`), window end, `closed_at` |
| `whatsapp_reply_proposal`, `whatsapp_message_receipt`, `whatsapp_delivery_status` | Proposal copies, message digests, Meta delivery states; no text                                                              |
| `whatsapp_ingress_policy(_revision)`                                              | Limits, topics, `agent_mode` (`off`, `draft`, `answer`; default `answer`), `always_wait_topics`                              |

- The Case Actor owns each email reply proposal (`case_email_proposal`,
  `EMAIL_REPLY_PROPOSAL_MACHINE`). D1 holds a copy. The Connector Actor holds the Gmail
  draft state (`connector_email_draft`) and the sources (`email_proposal_source`), as
  identities and fingerprints, not words.
- The Connector Actor holds the WhatsApp proposals (`connector_whatsapp_proposal`,
  `WHATSAPP_REPLY_PROPOSAL_MACHINE`) and the encrypted text of each open Case.
- The Organisation Actor holds the shared reply draft (`MailReplyDraftRooms`,
  `actors/mail-reply-draft.ts`): `mail_reply_draft`, `mail_reply_draft_author`,
  `mail_reply_draft_operation` and `mail_reply_draft_closed`.

**Lifecycles.**

- Email reply proposal: `draft_creation_indeterminate`, `awaiting_approval`,
  `approved`, `send_indeterminate`. The end states are `sent`,
  `operator_attested_present`, `operator_attested_absent`, `proposal_missing`,
  `invalidated`, `rejected`, `expired`, `superseded` and `revoked`.
- WhatsApp reply proposal: `awaiting_approval`, `sending`, `send_indeterminate`. The end
  states are `sent`, `rejected`, `expired`, `superseded`, `taken_over` and `revoked`.
  Only `awaiting_approval` and `sending` keep the body. From `sending`, a Meta accept
  gives `sent`. A Meta refusal gives `awaiting_approval` while the deadlines are open
  (`provider_rejected`), and `expired` after them. An unknown outcome or an ended send
  lease gives `send_indeterminate`.

**Approval of an email draft.** Approve sends `version`, `snapshotDigest` and an HMAC
`challenge` that binds the proposal, the version, the digest and the person.

1. The shared draft must be saved as exactly that version, with no unsaved text
   (`mailReplyDraftApproval`). Otherwise the result is `email_reply_draft_unsaved`.
2. `dispatchEmailReply` (`actors/connector-email-proposal.ts`) computes the digest again
   from the Gmail body. A difference gives `email_reply_approval_stale`.
3. The Message-ID is fixed for the proposal and version (`dispatchRfcMessageId`). The
   state becomes `send_indeterminate` before the send.
4. A send that Gmail does not confirm stays `send_indeterminate`. A later approve only
   looks for the Message-ID.

**The shared reply draft.** The draft opens from the current Gmail version. An owner or
admin edits; another member with the mailbox grant reads. **Save draft**
(`saveMailReplyDraft`) makes version `currentVersion + 1` through the Connector. When
the draft has one author (`single_editor`), the save records a correction, if each
earlier version has its record. The mailbox agent then runs a `correction_learning`
turn on it. A save with more than one author (`shared`) records no correction. The
body limit is 20,000 characters
(`BODY_LIMIT`). The same rooms back the agent's `email_reply_draft_edit`.

**The person reply.** The route takes the recipient from the thread, not the client.
The body is plain text or a formatted document. Files are at most 10 MiB together
(`MAIL_REPLY_ATTACHMENT_BYTES`), and a blocked file type is refused before the send. A
draft that waits for the thread refuses the reply (`mail_reply_draft_waits`). An
unconfirmed send is looked up by its Message-ID, and the result is
`send_indeterminate` if Gmail does not show it. Nothing sends again.

**Agent tools.** The Portal chat agent's tools are in
`areas/inbox/server/agent-tools/channels/channels.ts` (family `channels`):

| Tool                          | Capability                    | Effect                                                             |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `email_mailbox_search`        | `email.mailbox.read`          | Read, at most 10 messages                                          |
| `email_reply_draft_read`      | `email.mailbox.read`          | Read the shared reply draft                                        |
| `email_reply_draft_edit`      | `email.reply.propose`         | Edit the shared reply draft                                        |
| `email_reply_propose`         | `email.reply.propose`         | Save a reply draft for approval; never sends                       |
| `email_operational_propose`   | `email.operational.propose`   | Propose new outbound mail                                          |
| `whatsapp_support_read`       | `whatsapp.support.read`       | Read up to 20 active Cases                                         |
| `whatsapp_support_reply_send` | `whatsapp.support.reply.send` | Send one reply; the body must appear verbatim in the Slack request |

The mailbox agent (`agent-tools/channels/mailbox-agent.ts`, host `agent_mailbox`) and
the WhatsApp agent (`whatsapp-agent.ts`: `whatsapp_case_read`,
`whatsapp_reply_propose`, `whatsapp_handoff_request`) have their own lists. They are not
in `registry.ts`. The capabilities are in
`foundation/authority/authorization/capability-catalogue.ts`; each needs
`scripts/capability-policy-backfill-sql.mjs`.

## Rules and limits

| Action                                   | Viewer, operator                                    | Admin and owner             | Chat agent                          |
| ---------------------------------------- | --------------------------------------------------- | --------------------------- | ----------------------------------- |
| See the list and the summary             | Yes                                                 | Yes                         | No list tool                        |
| Read a mailbox's mail and drafts         | With an `email.mailbox.read` grant on that mailbox  | With the grant              | `email_mailbox_search`              |
| Read WhatsApp text                       | With a `whatsapp.support.read` grant on that number | With the grant              | `whatsapp_support_read`             |
| Edit a shared draft                      | Read only                                           | Yes, with the mailbox grant | `email_reply_draft_edit`            |
| Approve, reject or save a draft          | No                                                  | Yes                         | No                                  |
| Write and send a person's reply          | No                                                  | Yes                         | No                                  |
| Take over, return, close a WhatsApp Case | No                                                  | Yes                         | No                                  |
| Change the agent setting                 | No                                                  | Yes                         | No                                  |
| Accept the Gmail model terms             | No                                                  | Yes, in a Portal session    | No tool and no Code Mode capability |

- A member without the role sees the draft with no actions.
- The baseline policy leaves `whatsapp.support.read` and the `email.*` capabilities
  off; `whatsapp.support.reply.send` is on.
- **Information flow.** `authorizeMailSource` checks the Gmail product
  (`full_mailbox_pilot`), the person's live grant on `email.mailbox.read` for the
  mailbox, and a label check for `conversation_delivery`. `authorizeWhatsAppSupportRead`
  does the same for `whatsapp.support.read` (scope `active_cases`). Both capabilities
  are in `OUTSIDE_WRITTEN_READ_CAPABILITIES`, so a read gives the label an outside
  writer. After it, an effect with a consequence asks the person who asked (FND-07).
- A WhatsApp reply stays bound to its Case. A send checks again the customer, the
  policy version, the credential and the binding. An agent reply needs `agent_active`
  and a person's reply needs `human_owned`.

| Time limit                         | Value                                                                                 | Constant                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| WhatsApp text and the reply window | 24 hours                                                                              | `WHATSAPP_SERVICE_WINDOW_MS`                                                         |
| WhatsApp proposal                  | 4 hours, and 15 minutes before the window ends                                        | `PROPOSAL_TTL_MS`, `SERVICE_WINDOW_SAFETY_MARGIN_MS` (`whatsapp-case-processing.ts`) |
| WhatsApp person reply              | 60 minutes                                                                            | `WHATSAPP_HUMAN_REPLY_TTL_MS`                                                        |
| WhatsApp send lease                | 60 s, then `send_indeterminate`                                                       | `WHATSAPP_SEND_ATTEMPT_LEASE_MS`                                                     |
| WhatsApp turn retry                | 60 s, 3 attempts                                                                      | `WHATSAPP_TURN_RETRY_MS`, `WHATSAPP_MAX_TURN_ATTEMPTS`                               |
| WhatsApp turn tokens               | 60,000 for each turn, inside `daily_agent_token_budget`                               | `DEFAULT_TURN_TOKEN_ALLOWANCE`                                                       |
| Email proposal                     | 72 hours                                                                              | `PROPOSAL_TTL_MS` (`email-case-processing.ts`)                                       |
| Email turn tokens                  | 100,000 for each turn                                                                 | `DEFAULT_TURN_TOKEN_ALLOWANCE`                                                       |
| Email send check                   | 5 minutes after the last change; a pass that is late waits 1 hour after the last pass | `EMAIL_RESOLVE_GRACE_MS`, `EMAIL_MAINTENANCE_INTERVAL_MS` (`nextEmailMaintenanceAt`) |
| Gmail model review                 | 90 days (2026-11-22 to 2027-02-20)                                                    | `REVIEWED_AT`, `REVIEW_EXPIRES_AT`                                                   |
| Shared draft membership check      | 30 s                                                                                  | `PARTICIPANT_CHECK_TTL_MS`                                                           |

- **WhatsApp text.** Pantry encrypts the text of each open Case in the Connector Actor
  and deletes text older than 24 hours. A close, the deadline sweep, a disable, a
  revoke or an erasure deletes it all. D1 keeps only digests and states. Pantry stores
  no customer name, so a row shows the number.
- **No automatic send again.** An unconfirmed email or WhatsApp send is never retried.
  An email check looks for the Message-ID in Gmail. A WhatsApp `send_indeterminate`
  pauses the number, and a person states if the message went (`resolve`).
- **When the daily WhatsApp budget ends,** the number pauses with `daily_token_budget`,
  and the operator gets one notice for that day. The turn of the Case waits for the end
  of the UTC day. Then the pause ends by itself (`endWhatsAppBudgetPause`), and the
  waiting turns run. A `resume` starts it sooner. A paused number wakes for no turn, and
  only the budget pause wakes at its end.
- **When the agent's turns fail,** the Case tries again after 60 s. After 3 attempts it
  stops, and the operator gets one notice, `turn_attempts_exhausted`, that says the
  agent could not answer. The next customer message starts new attempts.
- **Gmail sign-in refused.** On `invalid_grant`, the first read marks the account
  `reauth_required` (`provider_grant_refused`, `markIntegrationAccountReauthRequired`).
  The write changes only an `active` account with the `updated_at` that the read saw.
  Later reads ask Google no more. The Inbox lists the mailbox as `reconnect_required`
  for each person with its read grant. A reconnect in Integrations makes the account
  `active` again (`finalizeConnectedIntegrationAccount`), and the mail reads again.
- **Out of scope:** Slack, shop chat and commerce approvals in the list; a chat widget
  for a merchant's website; assignment to a teammate; messages outside the 24-hour
  window; "Agent answers" on email; a Gmail archive action and Gmail categories.
  WhatsApp sends text only, with no template path (`whatsapp/graph.ts`). The webhook
  marks each message that is not text `unsupported_message`.
- **Boundaries.** FND-03 owns Cases and Sessions. FND-07 owns labels and the outside
  writer rule. FND-10 owns the collaboration rooms of the shared draft. FND-09 owns the
  agent tool catalog. FND-04 owns model routes. FND-06 owns grants and the access
  prompt. INT-01 owns the Gmail and WhatsApp connections and mailbox setup. BRN-01 owns
  Memory and Evals. ORG-02 owns the Jev switches.

## Open work

- A person without the admin role sees no send request in place of **Approve and send**.
- The WhatsApp composer sends `take-over` and `human-reply` as two requests, not one.
- Done does not list a person's own email reply; that thread stays in Other mail.
- The list has no merged cursor. Each source is bounded.
- The mail assistant needs a `mail_assistant_eligibility` row, and no product code
  writes one. Only patch scripts and a journey do.
- No route moves a Gmail reply to `approved` or `operator_attested_*`. A person cannot
  attest an unconfirmed Gmail reply.
- `whatsapp_support_reply_send` has no exit check yet (Refactor 17, Appendix C).
- WhatsApp is deferred since 23 November 2026: Meta banned the owner's account, so no
  WhatsApp connect, webhook or live check runs until the owner has a working Meta business
  account.

## Sources

- [Plan 83](../../../history/plan-83-one-inbox.md). Where it differs from the code, this spec
  follows the code. Its evidence in the archive:
  [the evidence report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-83/report.md).
  Background: [Plan 89](../../../history/plan-89-outside-written-content.md) and
  [FND-07](../../foundation/07-information-flow.md). Plans 29, 32 and 40D are in
  [the archive](https://github.com/seams-tech/pantry-history/tree/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs).
- E2E journeys in `workers/platform/tests/e2e/`: `inbox-whatsapp.test.ts`,
  `mail-inbox.test.ts`, `mail-inbox-reconnect.test.ts`,
  `mail-reply-shared-draft.test.ts`, `mail-chat-reply-sources.test.ts`,
  `mailbox-setup.test.ts`, `mailbox-check-now.test.ts`, `mailbox-spam-rescue.test.ts`,
  `mailbox-sender-supplier-link.test.ts`, `outside-written-effect.test.ts`,
  `whatsapp-send-attempt.test.ts` and `whatsapp-erasure.test.ts`.
- Browser journeys in `scripts/mail-inbox/`: `verify-browser-one-inbox.js` and
  `verify-browser-claim-trace.js`.
