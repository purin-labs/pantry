# Plan 87 — Screen context for the Portal chat agent

Status: complete and in production. Phase 1 since 6 November 2026 (satyr-edge `7389127d`);
phases 2–5 and Phase 1B since the Plan 88 release of 7 November 2026, with the defaults of
D16–D19 and the values of D11–D15. Later fixes in production: the page with no view
(7 November), the stale hint tag (9 November) and the order read text (9 November). The
real TypeSafe check passed in production on 7 and 9 November. D14 was tuned on 10 November
([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-d14-thresholds.md)). The relevance records stay stored with no
view (section 3A, Records). The record pages of Products, Orders and Suppliers fill
`sources` (released 2026-11-10, narrow release of `satyr-edge`). D19 part B, the start of
discovery from the screen, is design only (owner, 11 November 2026). Section 7 holds the
design. Its build waits for Context discovery, a Gmail mailbox and verified contacts in
production.
Date: 6 November 2026. Owners: Satyr platform and
Portal. The foundation is in production since the Refactor 10 release of 6 November
2026 (satyr-edge `bd756c3f`): the page view
([Plan 81](plan-81-agent-portal-control.md) slice 10, `b082b83f1`), the held agent
labels (slice 11, `b643b42c5`) and the Costs hook, inside the Costs redesign
(`c10de39fd`). Phase 1 passed J1, J3, the chip browser check (J2) and the full E2E
suite ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-1.md)). Phase 2 passed J4 and the Kitchen
chat journeys ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-2.md)).

## Outcome and scope

A person asks the chat about what they see, and the agent answers from the same screen.
The person always knows what the agent got: where the chat started, and which page each
message carried. A click on another page never sends that page by accident. Every
Portal page uses one protocol, from the simplest list to the Satyr Kitchen 3D view.

In scope:

- The origin of each chat: the area, the page and the record where it started.
- One observation envelope for every page, with a default observation for each page.
- A composer chip that shows the page that a message carries, and the rule for when it
  is on.
- A Jev suggestion that offers the page on screen when the draft is about it. Jev never
  attaches a page.
- Admission of an observation as a turn context item, with evidence, freshness and a
  flow label, so that one audience rule covers private and shared chats.
- One command path for agent actions on a page, and one agent label for every action.
- An "On screen" entry on Knowledge › Context.

Out of scope:

- Pixels and screenshots. A page describes itself as data.
- Slack. A Slack thread has an origin (its channel) but no screen.
- New authority. An observation grants nothing, and a command runs with the person's
  own controls and receipts.
- A rewrite of the Satyr Kitchen surface. It moves behind an adapter.

## Facts from the code

### Three separate paths show the screen to the agent

| Path | What it does | Where |
| --- | --- | --- |
| Kitchen surface context | A typed snapshot with a surface session and an epoch, the commands that the view supports, agent commands that run in the browser, and a receipt with a fresh snapshot | `packages/bakery-model/src/bakery-surface.ts`, `actors/bakery-surface-effect.ts`, `apps/portal/src/features/bakery-surface-effect-bridge.tsx` |
| Page view | Facts and tables of a page, for reading only. Only Costs & margins sends one | `packages/control-api/src/portal-page-view.ts`, `apps/portal/src/features/portal-page-view-registry.ts` |
| Collaboration rooms | Shared CRDT edits and the agent's held label | `actors/collaboration-room.ts` |

- The Kitchen attachment carries a SHA-256 digest of its context
  (`verifyBakerySurfaceAttachment`). The digest detects a change. It is not a signature.
- An agent command on the Kitchen goes into an Actor outbox (20 s time to live). The
  Portal bridge polls for it every 150 ms while active and every 2–5 s when idle.
- `prepare_context` loads the Kitchen view on demand when a message carried none
  (Plan 42G).
- The turn offers a Kitchen tool only when the view lists its command
  (`selection.kind: "surface"`, 38 tools in `agent-tools/bakery/surface.ts`).

### The screen bypasses the turn context

- The turn context assembly gives each item a flow label, an evidence record and a
  freshness state (`context/assembly`). Memory, Project context, Case entries and files
  use it.
- Both the Kitchen observation and the page view go directly into the prompt text
  (`chat/prompt.ts`). They get no label, no evidence and no freshness.
- The evidence of a chat message (`native_chat_input` in `chat/input-admission.ts`)
  covers its text and files, not the screen.
- So the page view needs a blunt rule: the model gets it only in a private chat. The
  prompt adds the Kitchen observation in every chat. Phase 1 checks if a shared chat can
  carry one.

### The Portal already names every page

`apps/portal/src/route.ts` has a `WorkspacePageDescriptor` for each page: the page key,
the title, the group (`AgentCommerce`, `CafeOS`, `BakeryOS`, `Workspace`, `Agents`,
`Settings`) and the open record (`product`, `customer_order`, `supplier`).
`pageAddress` gives the page beside the open chat. Since `a64458499` the chat stays open
while the page beside it changes, so the page at send time can differ from the page
where the chat started.

### TypeSafe already runs in Satyr

Case context discovery ([Plan 46](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-46-case-context-discovery.md)) and mail
classification call Jev `jev-1.13.0` through `TypeSafeDisclosure`
(`integrations/typesafe/disclosure.ts`). The sink names a purpose
(`case_context_discovery_relationship` or `mail_classification`) and the request
authority, and the flow label of the request must pass it. Each call reserves budget in
the TypeSafe usage store. The Organisation funds TypeSafe with its own key. Plan 46
budgets $0.042 per million input tokens; output tokens are free.
[Plan 88](plan-88-satyr-funded-jev.md) proposes Satyr's own key, an on/off switch for
each Jev feature and a monthly allowance in the subscription.

## 1. Thread origin

When the first message of a chat is sent, the server records its origin from that
message's observation:

```ts
type ChatOrigin = {
  area: WorkspaceNavigationGroupName; // "AgentCommerce", "BakeryOS", …
  page: WorkspaceDetailPage;          // "orders"
  title: string;                      // "Orders"
  record: {
    kind: string;                     // "customer_order"
    id: string;
    label: string;                    // "#1042"
  } | null;
  startedAt: number;
};
```

- The origin never changes. A fork keeps it. A side Case
  ([Plan 74](plan-74-side-cases.md)) takes `From chat: <title>`. A Slack thread takes its
  channel.
- The thread header shows it as chips: `AgentCommerce › Orders › #1042`. The area uses
  its public name, so `BakeryOS` shows as Satyr Kitchen. The chat list shows the same
  label.
- The prompt gets one line: "This chat started on Orders, order #1042." It is a label,
  not page content.
- The origin is not the Project. The Project is where the chat is filed.
- The origin also goes on the Case, so the Brain inspection of a Case can show where the
  work started.

## 2. The observation envelope

One envelope replaces the `surface` part and the `page_view` part of a message:

```ts
type SurfaceObservationV2 = {
  kind: "surface-observation";
  schemaVersion: 2;
  surface: string;               // the Portal page: "costs", "orders"
  area: SurfaceArea;             // its navigation group: "BakeryOS"
  instance: {                    // null for a page view stored before Plan 87
    browserInstanceId: string;
    surfaceSessionId: string;
    epoch: number;
  } | null;
  title: string;
  path: string;
  record: SurfaceRecord | null;  // the open record: kind, id, label
  capturedAt: number;
  view: PortalPageViewSection[]; // what the model reads
  state: null;                   // typed per surface from phase 2
  commands: string[];            // what the agent may do now; empty until phase 3
  sources: SurfaceSource[];      // records on screen, for the audience check
};
```

- **Default observation.** Every page sends one with no page code: the descriptor's
  title, group and path, and the open record. It costs about 100 tokens.
- **Rich observation.** A page that registers a capture adds `view` sections, as Costs
  does now. The limit is 24 KiB, about 6,000 tokens. The Costs margins tab measured
  6.2 KB for 24 products. The registry drops table rows to fit and keeps `totalRows`.
- **Typed state.** A page with commands adds `state`. For the Kitchen, `state` is the
  current `BakerySurfaceContextV1`, and the Kitchen generates `view` from it.
- **Sources.** Each record on screen, by kind, id and revision. The audience check and
  Knowledge read them. An unsaved edit names its record but is not a saved revision.
  A page names its records with `useSurfaceSources`. The record pages of Products,
  Orders and Suppliers name the open record and the records that it links to, such as
  the customer and the products of an order. An observation carries 60 names at most.
- **Digest.** The server computes it with `digestCanonical` when it admits the
  observation, as other sources do. The browser sends none, so it cannot claim one.
- **Stored parts.** A message keeps one `surface_observation` part. Old `page_view`
  parts and old Kitchen `surface` parts are read as v2. New messages write only v2. The conversation response sends only the page name of a message (a `screen`
  part), never its view, because a shared chat has other readers.

## 3. The composer chip and the attach rule

- The composer always shows the page on screen as a chip, for example
  `On screen: Costs & margins`, with a × to remove it.
- **On** by default when the page on screen is the chat's origin page. A different
  record on the origin page counts as the same page, and the chip names the record
  (`Orders › #1043`).
- **Off** by default on any other page. One click turns it on for that message.
- A new chat has no origin yet, so its first message carries the page on screen and sets
  the origin.
- Each sent message shows a small "sent from Costs & margins" mark.
- The prompt names both facts: "The chat started on Orders. This message carries Costs &
  margins." With the chip off, it says that the message carries no page.
- Since phase 2 the chip also replaces the switch that covered only Satyr Kitchen
  (`satyr:bakery-context-excluded`). With the chip off on the Kitchen page, the message
  carries no Kitchen view, and `prepare_context` and the Kitchen browser tools refuse
  it. On any other page the agent can still load the Kitchen on demand (Plan 42G), and
  the person sees it open.

## 3A. Relevance suggestion (Jev)

The attach rule of section 3 stops a page that the person did not mean to send. It can
cause the opposite error. On Costs, the person asks "why is this margin so low?" with the
chip off, and the model answers without the page. A Jev check on the draft finds this
case and suggests the page. Jev never attaches a page. Only the person's click attaches
it, and the rule of section 3 stays the default.

The design uses three TypeSafe patterns: relevance scores for context selection
([use case map](https://docs.typesafe.ai/concepts/use-case-map)), yes/no questions on
each candidate before the answering model sees it
([RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages)), and
stricter thresholds for riskier actions, with intent kept apart from authorization
([probability routing](https://docs.typesafe.ai/patterns/probability-routing)).

### When the check runs

- Only when the chip is off: the page on screen is not the origin page, and the person
  has not attached it.
- While the person types, after a pause of 500 ms, for a draft of 12 characters or more.
  One check runs at a time. A new pause cancels the old check.
- Never on send. If no answer has arrived when the person sends, the message goes under
  the rule of section 3.
- Not when the chat's audience may not read the page. The route runs the audience check
  of section 4 first. If the check refuses, the route calls no Jev, and the chip shows
  why.
- Only when the Organisation has a TypeSafe authority (its own key, or Satyr's key under
  [Plan 88](plan-88-satyr-funded-jev.md)) and its Screen relevance switch is on.
  Otherwise the rule of section 3 works alone.

### What Jev receives

One request with two yes/no (Noul) questions:

| Question | Meaning | Use |
| --- | --- | --- |
| `about_screen` | The draft asks about, or refers to, something on the page | Sets the band |
| `fits_chat` | The page relates to the topic of the chat | Selects the offer, and goes into the record |

The state holds the draft, the origin label, the last answer of the chat (cut to 1,000
characters), and the default observation of the page with its section titles. It holds no
table rows and no fact values. That is about 500 input tokens, so a check costs about
$0.00002, and 1,000 checks cost about $0.02.

The request goes through `TypeSafeDisclosure` with a new sink purpose
`screen_relevance`, under the sender's request authority. Its flow label joins the
labels of the draft, the chat answer and the page sources. The instructions say that
text in the state is data, and that Jev must ignore instructions inside it.

### Bands

These values were tuned on 10 November 2026 from 48 labelled drafts
([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-d14-thresholds.md)). A new labelled run tunes them again.

| `about_screen` | Composer |
| --- | --- |
| 0.65 or more | **Ask.** On send, the composer shows "Your message seems to be about Costs & margins. This chat started on Orders › #1042, so the page is not attached." with "Send with this page" and "Send without". Enter again sends without the page. The question shows one time for each draft |
| 0.30 to 0.65 | **Hint.** The off chip gets the tag "Looks related to your message". Send works as usual |
| Below 0.30 | **Quiet.** The plain off chip |

When `about_screen` is 0.65 or more and `fits_chat` is below 0.30, the question also
offers "New chat from this page". The draft moves into a new chat whose origin is this
page, so the old chat keeps its topic.

### Records

Each hint or question that the person sees records the two scores, the band, the model
and the person's choice: attached, sent without, new chat or no action. It records no
draft text and no page content. Each completed check, a quiet one too, also writes one
info log event, `chat.screen_relevance_checked`, with the Organisation id, the band, the
two scores, the model, `offer_new_chat` and the latency, and no text, title or person.
A Jev answer never goes into the model's prompt.

No view reads the records, and they do not tune the bands. A labelled run of drafts tunes
the bands, as on 10 November 2026. The records have two limits:

- A quiet check writes no record. If the person attaches the page after a quiet check,
  nothing records it. So the records show false alarms but not missed page questions.
- Only an admin gets the check, and only on a page that is not the chat's origin, so the
  records of one shop are few.

A view of the records waits until a second Organisation turns on Screen relevance. That
view also records a quiet check that the person attaches after all. Brain Evals
([Plan 42J](plan-42J-brain.md)) holds scenario evals that run as Cases, so it is not the
place for these records.

### The agent does not run this check

The check is a feature of the composer only. The Portal chat agent gets no tool for it,
because the check asks about a draft before the person sends it. The agent never sees a
draft: it reads a message only after the send, and then the chip has already decided
which page goes with it. A tool would also let the agent send text to TypeSafe under the
person's authority, and Plan 88 D5 keeps Jev inside Satyr features. The agent can still
read and change the Screen relevance switch with `jev_features_read` and
`jev_features_manage` (Plan 88 section 6).

### Code shape

- **Portal.** The composer runs the check after the pause, through the control client.
- **Platform.** A route `POST …/chat/conversations/:conversationId/screen-relevance`
  parses the draft and the default observation, checks that the person may write in the
  chat, and calls one domain function in `chat/screen-relevance.ts`. The function runs
  the audience check, reserves TypeSafe budget, calls Jev and returns
  `{ kind: "quiet" | "hint" | "ask"; offerNewChat: boolean }`,
  `{ kind: "refused"; reason }` or `{ kind: "unavailable" }`.

## 4. Admission as turn context

**The audience rule (phase 1).** A private chat carries any page, because only the
sender reads it and the sender saw the page. A shared chat carries only a page that
every member of the Organisation may open: `sharedChatMayCarry` in
`@satyr/control-api` lists them (Costs & margins and Menus now). Any other page goes
only to a private chat. The server applies the rule when the message is sent, so a
withheld page is not stored and the message keeps only its text, and again at turn
time, because a chat can be shared later. The chip uses the same list: in a shared
chat it says that the page is not sent. This replaces the private-only rule of slice
10.

Two facts shaped this rule. Costs and Menus have no read capability: their routes
read with the viewer role, so every member may open them. And a flow label whose
readers are roles is `internal`, which passes for every member, so a label from
`createCurrentSourceFlowLabel` cannot refuse a reader inside the Organisation. A page
that needs more than the viewer role joins the list only with a check of each
reader's role or grants.

**Evidence (phase 5).** The observation does not become a turn context item yet. It
enters the prompt beside the message text, as the Kitchen view does today. Phase 5
adds the item, because the Knowledge "On screen" entry needs it:

- provenance `screen_observation`, source kind `portal_surface`;
- an `ObservationEvidence` over the digest, the surface session and the epoch;
- a flow label from `sources`, with `createCurrentSourceFlowLabel`;
- freshness from `capturedAt`: stale after 5 minutes, as the Kitchen view is today.

The new kind must also reach `parseContextProvenance`, the excerpt renderer in
`actors/model-context-prompt.ts` and the bundle materializer.

The chat context panel shows each admitted observation: `Costs & margins · on screen ·
12:29`. A receipt of an agent command replaces it with the fresh observation, as Kitchen
receipts do today.

## 5. Surfaces and commands

- **Portal.** One registry replaces `bakery-surface-registry.ts` and
  `portal-page-view-registry.ts`. A page registers `capture()` and, optionally,
  `execute(command)` with its surface session and epoch.
- **Platform.** Each surface declares its commands in a family module, as `defineTool`
  does, with the selection `{ kind: "surface", surface, command }`. This replaces
  `bakerySurfaceCommands`. A turn offers a command only when the attached observation
  lists it.
- **Effect path.** The Kitchen outbox and bridge become generic. A command targets a
  surface instance and an epoch. The browser runs it with the person's own controls, and
  the receipt returns a fresh observation. `prepare_context` becomes the generic
  `surface_observe` command.
- **Delivery.** A push on the chat signal channel, with the poll as the fallback. This
  removes the 150 ms poll while a command waits.
- **First commands outside the Kitchen** (phase 4): on Costs, open a tab, set the
  category filter and select a product. They change only the view. A save stays a tool
  with its own approval and receipt.

## 6. Agent labels

- Each command declares its target, for example `row:<productId>`. A page marks its
  elements with a `data-surface-target` attribute.
- One overlay draws the agent's named label on the target and holds it for 5 seconds,
  the rule of the rooms (`AGENT_ACTIVITY_HOLD_MS`).
- Room pages keep their room presence. So every agent action on any page shows a label:
  a room edit, a save through a tool, or a view command.

## 7. Knowledge and Brain

- **Knowledge › Context › On screen.** A third entry beside Related Cases and Context
  discovery. For each Case it lists the observations that the agent received: the page,
  the time and the sources. It shows no values.
- **Discovery from the screen.** The sources on screen can start Case context discovery,
  for example "related Cases for the order on screen". Suggestions still need a review.
  TypeSafe runs on the Organisation's own key, so discovery runs only when a person asks.
- **Memory.** A screen observation is never Memory evidence by itself, because it can
  hold unsaved values that the browser supplied. A memory cites saved records.

## 8. Phases, costs and acceptance

Times are estimates in agent days.

| Phase | Result for the person | Agent days | Gate |
| --- | --- | --- | --- |
| 1. Origin and chip | Origin chips, the default observation on every page, the v2 envelope, the chip and its rule, admission as turn context. Costs moves onto it | 4–6 | J1, J2, J3 |
| 1B. Relevance suggestion | The Jev check, the hint, the question, "New chat from this page" and the records | 2–3 | J7 |
| 2. Kitchen adapter | The Kitchen sends v2. One message part. Old parts read as v2 | 3–4 | J4 |
| 3. Command path | The generic outbox, surface tool selection and push delivery | 6–8 | J4, J5 |
| 4. Labels and Costs commands | The label overlay and the first three Costs view commands | 3–4 | J5 |
| 5. Knowledge | The On screen entry, and discovery from the screen on request | 3–4 | J6 |

The total is 21–29 agent days. Phase 1 is useful alone. Phase 1B needs phase 1 and a
TypeSafe authority for the Organisation. Phases 2 and 3 change no behavior that a person
sees; the existing Kitchen journeys are their proof.

### Phase 1 tasks

The work goes on one branch, `plan-87`, in its own worktree. Each verified task lands on
`dev` by fast-forward.

1. **Contract.** `SurfaceObservationV2` and `ChatOrigin` as TypeBox schemas in a new
   `packages/control-api/src/surface-observation.ts`, beside `portal-page-view.ts`. A
   parser reads an old `page_view` part as v2. The Kitchen `surface` part stays until
   phase 2.
2. **Default observation.** A new `apps/portal/src/features/surface-observation.ts`
   builds the default observation from `pageAddress()` and the
   `WorkspacePageDescriptor`: the title, the group, the path and the open record. The
   page view registry becomes the surface registry, and Costs adds its `view` through
   it.
3. **Origin.** The first message sets the origin: `normalizeConversationTimeline`
   derives it from the first user message and keeps it in the conversation state
   (`state_json`), which the chat list already reads. No column and no D1 patch are
   needed. A fork copies the timeline, so it keeps the origin. The thread header and
   the chat list show the chips.
4. **Composer chip.** A new chip component sends the observation only when the chip is
   on, by the attach rule of section 3. The Kitchen switch in
   `apps/portal/src/features/bakery-browser-context.ts` stays until phase 2. Each
   sent message shows its mark.
5. **Admission.** A new `services/platform/src/chat/screen-observation-admission.ts`
   applies the audience rule of section 4 when a message is sent and at turn time. It
   replaces the private-only rule in `chat/application.ts`. The chip shows the same
   rule before a send. The turn context item moves to phase 5.
6. **Prompt.** `chat/prompt.ts` adds the origin line and the "This message carries"
   line.
7. **Proof.** J1, J2 and J3. `tests/e2e/chat-page-view.test.ts` becomes J2 and J3, so
   no journey repeats another. The IFC guide names the new source, and
   `pnpm lint:ifc-boundaries` passes. A browser check shows the chips on Orders and on
   Costs.

Two files may not grow: `services/platform/src/chat/application.ts` (3,588 lines) and
`apps/portal/src/features/chat/route.tsx` (4,433 lines). Each task puts its code in a
new module and leaves only a call in these files, balanced by the lines that it
removes.

### Phase 1B as built

Done on branch `plan-87-1b` ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-1B.md)).

- **Route.** `POST …/chat/conversations/:conversationId/screen-relevance` with
  `{ draft, observation }`, and `POST …/screen-relevance/:checkId/choice` with
  `{ choice }` (`control/routes/chat-screen-relevance.ts`). A reader of a shared chat
  gets `refused` with `chat_read_only`.
- **Domain.** `chat/screen-relevance.ts` runs the audience rule of section 4, then the
  viewing check of the chat for the sender, because Jev reads the last answer. The
  draft, the answer and the page all carry the sender's own label.
- **Organisation Actor.** `jev-features/screen-relevance-check.ts` reads the switch and
  the TypeSafe authority for each check, holds paid use above the free use, reserves
  budget under the new purpose `screen_relevance`, calls Jev and records a hint or a
  question in the Actor table `jev_screen_relevance_record`. No D1 table changes. An
  Actor from before 1B copies `typesafe_evaluation` into a table whose CHECK names the
  new purpose.
- **Limits.** One check sends at most 8 KiB and a draft of at most 4,000 characters. It
  reserves 8,192 input tokens and $0.0004, and waits at most 5 s. A day allows at most
  500 checks and $0.20. A refused reservation, `rate_limited` included, drops the check.
- **Portal.** `features/chat/screen-relevance.ts` runs the check and holds the
  suggestion. The chip shows the tag for a hint and for a question before the send. A
  send records `attached` or `sent_without`; a hint with no send stays `no_action`.
- **Records.** No view reads the records (section 3A, Records). The real TypeSafe check
  of section 8 passed in production on 7 and 9 November 2026.

### Phase 2 — the Kitchen adapter

Done on local dev `51362d13b` ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-2.md)).

- **Contract.** `state` is a record that its surface types. The Kitchen's state is the
  current `BakerySurfaceContextV1`.
- **Portal.** On the Kitchen page with the chip on, the message carries the Kitchen's
  current view as `state`, and no `view` (`chat/screen-send.ts`). The Kitchen switch,
  its menu entry and its live check in the effect bridge are gone.
- **Server.** `chat/kitchen-observation.ts` checks the state, makes the `view` from it,
  and derives the `BakerySurfaceAttachmentV1` that the Kitchen code uses, with a digest
  that the server computes. A state that names another surface session, epoch or browser
  than the message is refused with 422.
- **One part.** A stored `surface` part, and the `surfaceContext` key of a tab that
  loaded the Portal before phase 2, join the Kitchen's observation. A message that
  carried another page keeps that page and leaves the hidden Kitchen view out.
- **Audience.** The Kitchen follows the shared-chat rule of section 4, in the prompt's
  Kitchen block too. Before phase 2 that block went to every chat. The Kitchen is not on
  the shared list, because some of its reads need the admin role.

Three results that a person can see:

1. In a shared chat the message carries no Kitchen view. The agent can still read the
   Kitchen with its browser tools; phase 3 moves that path onto the envelope.
2. A message from another page no longer carries the Kitchen view that stays mounted
   behind it. The agent loads it on demand, and the Kitchen opens on screen.
3. An old message with a Kitchen part now shows its "sent from" mark, and a chat that
   started with one gets the origin `Satyr Kitchen › Workflow simulator`.

### Phase 3 tasks

Facts found when phase 3 started:

- A turn offers all 38 Kitchen tools to every owner or admin
  (`authorizedBakerySurfaceCommands`), whatever the message carries. A tool checks the
  prepared view's `supportedCommands` when it runs. Plan 42G needs this: a message from
  another page loads the Kitchen in the same turn.
- The bridge polls the outbox every 2–5 s while no effect waits. The first Kitchen
  command of a turn waits on average about 2.5 s, and at most 5 s, before the browser
  sees it. The chat signal socket has one signal kind, `chat_changed`.
- No second surface has commands yet. Costs gets its first in phase 4.

The tasks, in order, on branch `plan-87`:

1. **Push delivery.** When the Session publishes a Kitchen effect, the Organisation
   Actor sends a `surface_effect` signal to the user's chat pages. The bridge reads the
   outbox at once, and polls at the slow rate while the socket is live. A tab without
   the signal keeps the poll.
2. **Commands per surface.** A surface tool's selection names its surface:
   `{ kind: "surface", surface: "workflow-simulator", command }`. The Kitchen
   observation lists its `commands` (the view's `supportedCommands`), so the model and
   Knowledge read what the agent may do on the page.
3. **Proof.** J4 again, the Kitchen chat journeys, and the push check in the blocked
   browser journey of `portal-chat-finalization.test.ts`: the user's signal socket gets
   `surface_effect` when the Kitchen command is published, and a request with an
   excluded browser sends none.

The generic outbox and `surface_observe` move to phase 4 (D17). The offer rule stays as
it is for the Kitchen (D16). Tasks 1–3 are done ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-3.md)).

### Phase 4 tasks

The generic command path comes with the first Costs commands (D17). It reuses the
Kitchen outbox, its delivery rows, its receipt route, its recovery and the push signal of
phase 3, and adds one surface-neutral command kind to it.

1. **Contract.** `@satyr/control-api` gets `SurfacePageCommandV1`: the surface, the
   target instance (surface session and epoch), the command and the agent's label. The
   Costs commands are `open_tab`, `filter_category` and `select_product`. The effect
   envelope accepts it as `page_command`, and a receipt answers it with
   `page_completed` (a fresh observation and the target) or `page_rejected`.
2. **Costs page.** The Costs view source runs the three commands with the page's own
   state changes, lists them in its observation, and marks its rows and tabs with
   `data-surface-target`.
3. **Label overlay.** One overlay draws the agent's label on the target of a command and
   holds it for 5 seconds (`AGENT_ACTIVITY_HOLD_MS`).
4. **Bridge.** The bridge runs a `page_command` on the page whose observation instance it
   names, and answers with the fresh observation.
5. **Server.** Three Costs tools in `agent-tools/costs/view.ts`, with the selection
   `{ kind: "surface", surface: "costs", command }`. A turn offers them to an owner or
   admin, as the Kitchen tools (D16): the browser's command routes need the admin role,
   and an offer that follows the message would change the pinned tool catalog of a turn
   after a recovery. The tool reads the person's current message as it was admitted, and
   refuses when it did not carry Costs with the command, so a chip that was off still
   keeps the page out. The tool result is the fresh observation.
6. **Proof.** J5, J4 and the Kitchen chat journeys.

Tasks 1–6 are done ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-4.md)).

### Phase 5 tasks

The On screen entry reads the observations as each message stored them after its
admission (D18). It needs no new store and no new turn context kind.

1. **Contract.** `CaseScreenObservationView` in `@satyr/control-api`: the page and its
   area, the open record's label, the time of capture and of the message, and the sources.
   It has no view, no state and no path.
2. **Server.** `chat/case-screen-observations.ts` reads the Portal chats of one Case that
   the reader may see, and lists the observation of each message. The route is
   `case-context-discovery/screen-observations?case_ref=&revision=`, beside the
   Related Cases inspector, with its authorization.
3. **Portal.** An On screen section on Access › Data flow, with the same Case choice as
   Related Cases, and a third entry on Knowledge › Context that leads to it.
4. **Proof.** J6, with a reader who may not see the chat, and the IFC guide.

Discovery from the screen (D19) has its input: the record pages fill `sources`, and the
On screen entry lists them. The start of a discovery from an entry is designed below and
not built.
Tasks 1–4 are done ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-5.md)).

### The start of a discovery from the screen (design, not built)

The owner chose on 11 November 2026 to write the design and to build no code.

**Why it waits.** A read of production on 11 November 2026 found no verified contact
(`contact_endpoint_verification`: 0 rows) and no admitted email (`email_message_receipt`:
0 rows). A discovery from an order finds its candidates through the verified contact of
the order's customer, so each start in production answers "no candidates" today.

**Conditions to start the build.** All three must be true in production:

1. Context discovery is on for the Organisation, with a Gmail mailbox that admits email.
2. One verified contact or more has a `customer_contact` target, and its customer has an
   order.
3. That contact has one admitted email or more in the last 30 days.

**What a person does.** On Access › Data flow, an On screen entry lists a
`customer_order` source. The person selects "Find related Cases". The suggestions go to
Related Cases of the chat's Case, and a person reviews each one, as with email.

**The steps of one start.**

1. A new route, `POST case-context-discovery/screen-discoveries`, takes the Case, the
   message and the source (`kind`, `id`). It uses the authorization of the On screen
   read, and it refuses a source that no observation of that Case holds.
2. The server reads the order with the person's own commerce read. The order gives the
   customer and the anchor evidence: the order number, the lifecycle and the line items,
   with a limit of 1,800 bytes. It gives no payment data.
3. The verified contacts of that customer with a Gmail endpoint give the mailbox and the
   sender address. If there is none, the start ends with `no_verified_contact`.
4. The Gmail `ConnectorActor` reads the candidates, because only it holds the mailbox
   token. It uses the rules of the email discovery: the receipts of the last 30 days,
   the same sender, one candidate for each Case and a maximum of five.
5. The Organisation Actor runs `evaluateCaseContextDiscovery` with the issue kind
   `order_issue` and the order as the issue instance. Jev compares the anchor with each
   candidate. The budget, the rate limit and the receipts stay as they are.

**What Plan 46 must change first.** Today each selection is an admitted email, the anchor
included. A commerce anchor needs a change in each of these places:

- `case-context-discovery/source.ts`: `resolveCaseContextCollectionSelectionVerification`
  refuses a source that is not `gmail`. A commerce selection must prove the verified
  contact, and that the order belongs to that customer at that revision.
- `actors/organisation/case-context-collection.ts`: the source access of the anchor is
  a mailbox binding. A commerce anchor needs the person's commerce read authority and
  its flow label.
- `case-context-discovery/metadata.ts`: the Related Cases view reads each selection as
  `trigger:trigger_email_<id>` of its Case, with a mailbox grant. The anchor must read
  the chat message that held the observation, with the commerce read capability.
- `actors/organisation/organisation-policy.ts` (two places) and
  `actors/email-case-context-collection-evidence.ts`: the checks and the context load
  for an attached relationship take an email anchor.
- The IFC guide gets a new source, with an allowed and a denied journey.

**Smaller choice that was not taken.** A list of the customer's email Cases with no Jev
call needs no anchor. It needs the sender link on each admitted email, because a receipt
gets its contact only when a discovery runs. The owner did not choose it.

**Proof when it is built.** One journey: a person with the right starts a discovery from
the order on screen and sees one suggestion in Related Cases; a person who may not read
the chat is refused; a source that was never on screen is refused; a customer with no
verified contact gives `no_verified_contact` and no Jev call.

### E2E acceptance journeys

Each journey writes a repeatable artifact in `docs/evidence/plan-87-*`. A fake model may
only record and answer. Product code produces each asserted outcome.

- **J1 — Origin.** A chat starts on Orders with order #1042 open. The header shows
  `AgentCommerce › Orders › #1042`. The person moves to Costs, and the origin stays. The
  model's input names the origin.
- **J2 — No accidental page.** With that chat open, the person moves to Costs and sends
  a message. The model gets no Costs view. The person turns the chip on and sends again.
  The model gets the Costs view, and the message shows "sent from Costs & margins".
- **J3 — Audience.** In a chat shared with a Project, the model gets the Costs view,
  because every member may open Costs. The same chat leaves Orders out: the model input
  says that the request carries no page, and the stored message keeps only its text. A
  private chat carries the page, an old tab's v1 page view still reads as v2, and an
  observation that breaks the contract refuses the message.
- **J4 — Kitchen parity.** The existing Kitchen chat journeys pass on the v2 envelope.
  A stored conversation with old `surface` parts still opens and continues.
- **J5 — Command and label.** The person asks the agent to show the Matcha financier on
  Costs. The page selects that row, the label stays on it for 5 seconds, and the receipt
  carries a fresh observation. A viewer's chat gets no command.
- **J6 — Knowledge.** Knowledge › Context › On screen lists the page, the time and the
  sources for the Case, and no values.
- **J7 — Suggestion.** A fake TypeSafe only records and answers. In a chat that started
  on Orders, the person drafts a Costs question on Costs. The Jev request holds the draft
  and the section titles, and no table row. The person picks "Send without", and the
  model gets no Costs view. On the next draft the person picks "Send with this page", and
  the model gets the Costs view. In a shared chat with a reader who may not read costs,
  no Jev request goes out. With the feature off, no Jev request goes out, and section 3
  applies. Every member may open Costs (section 4), so the journey uses Orders for
  the shared chat: its readers may not receive that page.

One real journey runs before a release: a Portal chat in production on Costs & margins,
with the chip on and off. For phase 1B it also sends three drafts to the real TypeSafe:
one about the chat, one about the page and one mixed. The records show the band of each.

### Risks

- A page can show data that the turn's audience may not read. Admission as turn context
  (section 4) is the control, so phase 1 must ship it together with the chip.
- A large page can fill the prompt. The 24 KiB limit and row trimming bound it.
- A command can move the person's view while they work. Commands change only the view,
  every command shows a label, and phase 4 starts with three commands on one page.
- The Kitchen path is large and proven in production. It moves behind an adapter, and
  the old path stays until the new one passes in production.
- A wrong high Jev score asks a person who did not mean the page. The question shows one
  time for each draft, Enter sends without the page, and a labelled run raises the
  threshold. A wrong low score leaves the rule of section 3, as with no Jev.
- The draft goes to TypeSafe before the person sends it. The sink purpose
  `screen_relevance` puts this flow under the disclosure check, and the feature is off
  until an admin turns it on (D15).

## Decisions

The cost column states what the recommendation costs beyond the phase, or what it gives up.

| ID | Decision | Recommendation | Cost | Default |
| --- | --- | --- | --- | --- |
| D1 | Default observation | Every page sends its title, group, path and open record | About 100 tokens for each message | Recommendation |
| D2 | Attach rule | On for the origin page, off on other pages, one click to attach | One click when the person wants another page | Recommendation |
| D3 | Another record on the origin page | Counts as the same page; the chip names the record | A person who does not read the chip can send the wrong record | Recommendation |
| D4 | Audience | A flow label from `sources`, checked by the turn's audience check | Until phase 1 ships, shared chats get no page view | Recommendation |
| D5 | Agent commands outside the Kitchen | Reading only first; three Costs view commands in phase 4 | The agent cannot move other views before phase 4 | Reading only |
| D6 | Command delivery | Push on the chat signal channel, poll as the fallback | One more message kind on the signal channel | Recommendation |
| D7 | Discovery from the screen | Only when a person asks | No related Cases appear by themselves | Only on request |
| D8 | Memory | A screen observation is never Memory evidence by itself | A memory must cite a saved record | Recommendation |
| D9 | Kitchen code | An adapter, no rewrite; keep the old path until production proof | Two paths for one release | Recommendation |
| D10 | Size | One observation for each message, at most 24 KiB | A very large table is cut; `totalRows` says so | Recommendation |
| D11 | Relevance suggestion | Jev suggests; only the person's click attaches | One TypeSafe call for each typing pause, about $0.00002 | Recommendation |
| D12 | What Jev receives | The draft, the origin, the last answer, the title and the section titles; no rows or values | Jev can miss a question about one value | Recommendation |
| D13 | Page off the chat's topic | Offer "New chat from this page" when `fits_chat` is below 0.30 | One more button; about half an agent day | Recommendation |
| D14 | Thresholds | Ask at 0.65, hint at 0.30 (tuned on 10 November 2026; the start values were 0.80 and 0.45); a new labelled run tunes them again | A question on send for most page questions; a page question that Jev scores under 0.30 gets no tag | Tuned values |
| D15 | Consent | Off until an admin turns on the Screen relevance switch (Plan 88) | Nothing happens until an admin acts one time | Recommendation |
| D16 | Which Kitchen commands a turn offers | As now: all Kitchen commands to an owner or admin, checked against the prepared view when they run. The observation rule of section 5 applies to pages that cannot load on demand, from Costs in phase 4 | The 38 Kitchen tool definitions stay in every admin turn, as today. Offering by observation would break Plan 42G loading in one turn | Recommendation |
| D17 | Generic outbox and `surface_observe` | Build them in phase 4 with the first Costs command, so that the generic shape has two users | Phase 3 has no generic outbox; phase 4 grows by about 2 agent days | Recommendation |
| D18 | Where On screen reads from | The observations as each message stored them after its admission; a turn context item waits until a consumer needs its evidence or freshness | The chat context panel shows no "on screen · 12:29" entry yet; no new store or context kind | Recommendation |
| D19 | Discovery from the screen | Wait until pages fill `sources`; then a person starts it from an On screen entry | The record pages fill `sources`. The start of a discovery from an On screen entry is designed (section 7) and not built: production has no verified contact and no admitted email (11 November 2026) | Recommendation |

## Effect on other plans

- **Plan 81:** slices 10 and 11 are the foundation of this plan. Phase 1 replaces the
  page view part and the private-only rule.
- **Plan 42G:** `prepare_context` becomes the generic `surface_observe` command.
- **Plans 42J and 42K:** Knowledge › Context gets the On screen entry, and the Memory rule
  of section 7 applies.
- **Plan 74:** a side Case takes its origin from its chat.
- **Plan 46:** the TypeSafe sink gets the purpose `screen_relevance` (section 3A).
- **Plan 40C:** rooms keep their presence. The overlay of section 6 covers pages with no
  room.
- **Plan 86:** Costs & margins is the first rich surface and the first page with view
  commands.
- **IFC guide:** `services/platform/src/policy/information-flow/README.md` adds the
  screen observation as a source when phase 1 ships.
