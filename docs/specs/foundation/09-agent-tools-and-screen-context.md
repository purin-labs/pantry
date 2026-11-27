# FND-09 — Agent tools and screen context

Each action of a Sous Chef agent in Purin Pantry is one tool call. One list holds every
tool. Each tool says when a turn offers it and what a successful call proves. One
executor checks each call: the catalog of the turn, the arguments, the capability and
the exit check. A Code Mode script calls the same tools through the same checks. In a
Portal chat, the agent also works on the page beside the chat. A message carries the
page on the person's screen as a screen observation, and only when the composer chip is
on. A page command runs in the person's browser, with the page's own controls, and
answers with a receipt. An observation grants no authority and proves no saved record.

## What it does

### The tool list

- `TOOLS` in `workers/platform/src/agent-tools/registry.ts` is the one list: 122 tools.
  Each tool is one `defineTool` value in a family module. A family is the set of tools
  that take the same services of a turn, for example `kitchen`, `commerce` or `devices`.
- The order of the list is the order of the model definitions. A Session pins the
  SHA-256 of the definitions of its turn. So a new tool goes at the end of its group.
- The mailbox agent and the WhatsApp agent have their own registries (INB-01). A turn
  can also add tools from data: the operations of a custom connector (INT-01).

| Selection    | A turn offers the tool when                                                    | Tools in the list                                                                     |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `capability` | The turn holds the capability. The call claims it                              | 72                                                                                    |
| `surface`    | The turn is a Portal turn, and the role of the person may use the page command | 47: Kitchen workspace 38, Costs & margins 3, Pastry Bench 2, Register 4               |
| `turn`       | The origin of the turn sets a flag                                             | `propose_memory`, `schedule_follow_up`, `propose_side_case`, `pending_decisions_read` |
| `host`       | The turn runs in the named host                                                | None. The two agent registries hold them                                              |

| Effect      | A successful call proves                                            | Result to the harness                     |
| ----------- | ------------------------------------------------------------------- | ----------------------------------------- |
| `read`      | The call changed nothing                                            | `read`                                    |
| `receipt`   | The call changed something. Its value names the receipt             | `provider_effect`                         |
| `proposal`  | The call staged a proposal. A person confirms the change            | `read`                                    |
| `draft`     | The call changed a shared draft. The room keeps the history         | `read`                                    |
| `scheduled` | The call scheduled a later turn for the same person                 | `read`                                    |
| `surface`   | The call sent a command to a page. Its value names the page receipt | `surface_effect`, `succeeded` or `failed` |

- A `draft`, `receipt` or `scheduled` tool has `prepare` in place of `handler`.
  `prepare` does the live checks and the reads. It returns the effect with its exit
  checks. `pnpm lint:tool-effects` refuses such a tool with no `prepare`.
- Each tool has a rule for a call that a lost process left in flight: `any_caller`,
  `script` or `none` (FND-04). `directOnly` refuses a call from a script. `modelOnly`
  keeps the tool out of the tool list of a script. `structuredOutput` gives a script a
  typed value.
- The turn flags come from `actors/session/turn-tool-offers.ts`. An owner or admin in
  the Portal gets `propose_memory`. A Slack thread turn gets `schedule_follow_up`. A
  Slack thread turn, or a step of a Portal chat, gets `propose_side_case`. A turn that
  may ask a person (the flag `permissionRequest`) gets `pending_decisions_read`.
- `pending_decisions_read` (family `decisions`, `agent-tools/decisions/`) lists what
  waits for the person who asks through the one read of FND-06. It reads as the
  person's Portal sign-in of the turn (`readTurnControlSession`,
  `authorizeOrganisationSession`), so each store applies the check of its own page. The
  list enters the turn with the label of the person's own message. A Slack turn has no
  Portal sign-in and gets a refusal.

### The catalog of one turn

- `selectCatalogDefinitions` gives the definitions in this order: the capability tools,
  the surface tools, the turn tools, `request_permission`, then the tools that the turn
  adds. Each group keeps the order of the list.
- The digest covers the definitions and the pins of the added tools. A turn with
  another digest is refused (`embedded_harness_tool_catalog_digest_mismatch`). A surface
  tool or an added tool with no handler also refuses the catalog.
- With Code Mode, a catalog of at most 16 tools and 8 KiB is enabled as a whole. A
  larger catalog starts with `tool_search`, `codemode` and `request_permission`.
  `tool_search` enables 8 matches, or at most 20.
- A Slack thread turn or a Portal chat step that lacks a requestable capability gets
  `request_permission`. Its list names only what the turn lacks. The tool accepts only
  a direct call, with one item or more. It refuses a capability that the turn holds.

### One call

`executeCatalogTool` (`agent-tools/catalog/execute.ts`) runs each call in this order:

1. The tool name must be in the definitions of the turn, and the call must have an id.
2. The input must be JSON.
3. The turn must give a handler. If not, the call fails. The `unavailable` text of the
   tool goes only to the log line `embedded_harness.capability_failed`.
4. `parse` checks the input against the schema, and then `decode` makes the request.
   A `decodeOnly` tool has no full schema check: only the `textLimit` checks of its
   schema run (FND-11), and then `decode` is its check.
5. A capability tool claims its capability. The claim checks the turn lease, the Case
   assignment and the live authority. It also takes one call from the run budget.
6. An effect tool runs `prepare`. Then `settleToolEffect` reads the flow label, runs
   each exit check and calls `run` (FND-07). Any other tool calls its handler.

- A call that fails step 3 or 4 claims nothing.
- A tool that the turn adds goes before a registered tool of the same name.
- A `ToolRequestError` gives its message to the model, so the agent can correct the
  call. Any other error gives a general failure text, or the `unconfirmedFailure` text
  of the tool. A call that the run budget refuses tells the agent not to try again.
- A direct call whose read no grant admits asks a person for the read grant
  (`requestDeniedRead`). The person gets an Allow prompt, not a denial. In a script,
  the refusal text tells the agent to call `request_permission`.
- The result is an envelope. Its `output` field holds the value as text, cut at 24 KiB
  with a note that gives the size. Its `code_mode_value` field holds the whole value.
  A direct call gives the whole envelope to the model, so a successful result can be
  larger than 24 KiB. The text of a failure is cut at 24 KiB.
  `commerce_entity_context` keeps its own result form.

### Code Mode

- `codemode` runs one JavaScript script in the QuickJS VM of the `CodeModeSandbox`
  Worker (FND-02). A turn has one attempt. Only the model calls `codemode`.
- A script calls the tools of the catalog. Each nested call first claims a place in the
  admitted execution. It then runs through `executeCatalogTool` with the kind
  `code_mode`, and it completes with its output size.
- Pantry stores the capabilities that a nested call claimed with its result. When Pi
  runs the script again after a lost process, each recorded result needs current
  authority (`authorizeSources`). A recorded result is not an authorization.
- A script gets the value of a result as text, with no envelope.
  `commerce_entity_context` gives an object. An admission freeze refuses the claim of a
  nested call and stops the script.

### Agent control of the Portal apps

An agent does the work of a page in one of five ways. Each way keeps the checks, the
approval and the receipt of the person's own action on that page.

| Way                    | How it works                                                                                                                                                                                            | Tools                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A step of a staff page | The tool reads the role of the person at the call: operator or higher. It writes the receipt of the page, with the route, the operation and a key from the call. A repeated call gets the first receipt | `order_queue_advance`, `sold_out_mark`, `recipe_save`, `supplier_create`, `supply_cost_save`, `lot_cost_save`, `costs_plan_save`                                                                                  |
| A read                 | The turn needs the capability and a read grant for the record type. With no grant, a direct call raises the Allow prompt                                                                                | `order_queue_read`, `sold_out_read`, `counter_sale_read`, `payments_read`, `recipe_read`, `supplier_read`, `costs_read`, `commerce_entity_context`, `commerce_merchant_report`                                    |
| A proposal             | The tool stages a governed action or a draft. A person approves or confirms it (FND-06)                                                                                                                 | `commerce_propose_action`, `commerce_propose_refund`, `commerce_propose_stock_action`, `commerce_propose_menu_publication`, `commerce_propose_plugin`, `commerce_propose_campaign_brief`, `configuration_propose` |
| A shared draft         | The tool edits the draft in the room that people edit (FND-10)                                                                                                                                          | `menu_draft_edit`, `production_plan_edit`, `product_description_draft_edit`, `move_object`, `costs_sheet_edit`                                                                                                    |
| A page command         | The command runs in the person's browser (see "Page commands")                                                                                                                                          | The 47 surface tools                                                                                                                                                                                              |

- A step of a staff page has no approval card, as the person has none. The turn must
  also hold the read grant of the records of the page. A turn with no person cannot use
  these tools.
- The reads of a staff page check the person at the call, as its steps do.
  `order_queue_read`, `sold_out_read`, `counter_sale_read`, `payments_read`,
  `recipe_read` and `supplier_read` need a person with the operator role or higher
  (`prepareStaffPageWork`). `costs_read` needs a current member.
- `recipe_save`, `supplier_create` and the three costs saves carry words from the chat
  into a record that each member reads. So they also pass the content check of a shared
  draft.
- `commerce_propose_stock_action` covers deliveries, counts, production requests and
  purchase requests with one action kind, `stock_operation`.
- `configuration_propose` works in a Portal chat: the draft shows as a card, and the
  person who asked confirms it.

### The screen observation

- Each Portal page sends a default observation with no page code: the page name, its
  area, its title, its path and the open record. The full chat page sends none.
- A page that registers a view source adds `view`: titled sections, each with facts
  and at most one table. Costs & margins, Menus, the Register and the Pastry Bench
  register one. The view holds what the person sees, unsaved edits included.
- The Kitchen page sends its current view as `state`. The server checks the state and
  makes `view` and `commands` from it, so a browser cannot send a view that differs.
  A state that names another surface session, epoch or browser refuses the message
  (422). While the Pastry Bench covers the Kitchen workspace, the message carries the
  Pastry Bench view and its two commands, with no state (`screen-send.ts`).
- `sources` names the saved records on screen, each by kind, id and revision. The
  record pages of Products, Orders and Suppliers name the open record and its linked
  records. The Portal sends at most 60 names.
- An observation is at most 24 KiB. The Portal drops the last rows of the largest
  table until it fits. A table keeps `totalRows`, so the model knows that rows are
  absent. A malformed observation refuses the message (422).
- The browser sends no digest. A message stores one `surface_observation` part. The
  conversation response gives only a `screen` part: the area, the title and the record
  label. The Portal shows it as "Sent from Costs & margins" on the message.

### The chat origin and the composer chip

- The first message of a chat sets the chat origin from its observation: the area, the
  page, the title, the record and the time. The origin never changes. A chat whose
  first message carried no page has no origin.
- A row of the chat list shows the origin as one muted line, for example
  `Commerce › Orders › #1042`. The thread header does not repeat it: each message says
  where it was sent from. A fork copies the timeline up to the chosen answer. Its origin comes from the
  first user message of that timeline, so it is the origin of the source chat.
- The composer shows the page on screen as a chip. The chip is on for a new chat, and
  on the page of the chat origin. A different record on that page counts as the same
  page. On each other page the chip is off, and one click turns it on for one message.
- With the chip off on the Kitchen page, the message is `excluded`: the saved read and
  the Kitchen tools then refuse (FND-05).
- The prompt gets one line with two facts: where the chat started, and which page the
  current request carries, or that it carries none. For a page with no view, the prompt
  tells the model not to describe the page.

### Who receives a page

- A private chat carries each page, because only the sender reads the answer.
- A shared chat carries only a page that each member may open: `costs` and `menus`
  (`sharedChatMayCarry`). The chip says that another page is not sent.
- The server applies the rule when the message arrives, so a withheld page is not
  stored. It applies the rule again at turn time, because a chat can become shared.
  The prompt of a workspace canvas chat has no page.

### Page commands

| Surface                             | Commands                                                                                                                 | Tools                                                                            | Offered to             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------- |
| `workflow-simulator` (Kitchen)      | The 38 commands of the Kitchen workspace, for example `run_shift`, `control_playback`, `select_item`, `rotate_equipment` | The 38 `bakery_surface_*` tools, one for each command                            | Owner, admin           |
| `costs`                             | `open_tab`, `filter_category`, `select_product`                                                                          | `costs_view_open_tab`, `costs_view_filter_category`, `costs_view_select_product` | Owner, admin           |
| `workflow-simulator` (Pastry Bench) | `configure_pastry_bench`, `prepare_pastry_bench`                                                                         | `pastry_bench_configure`, `pastry_bench_prepare`                                 | Owner, admin           |
| `register`                          | `register_add_item`, `register_update_line`, `register_remove_line`, `register_clear_basket`                             | Four tools with the same names                                                   | Owner, admin, operator |

- A page command saves nothing and moves no money. It changes the page in the person's
  browser, as the person's own clicks do. A save stays a tool with its own receipt or
  approval. In Kitchen, the person confirms a save on the page.
- A Costs & margins command changes only the view. A Register command changes the
  basket, and a Pastry Bench command runs the bench simulation. A Kitchen workspace
  command can change the run on the page: `bakery_surface_accept_candidate` changes
  the current simulation, `bakery_surface_apply_production` applies a new production
  run, and `bakery_surface_run_shift` and `bakery_surface_rotate_equipment`
  recalculate the shift. `bakery_surface_file` can download a file in the browser.
- Only a Portal turn gets page commands, by the role of the person
  (`authorizedBakerySurfaceCommands`). A Slack turn gets none. Each command checks the
  turn lease and the live role again at the call (`requireLiveBakeryAuthority`).
- The tool checks the page when it runs. A Kitchen tool needs the command in the
  `supportedCommands` of the prepared view. A view command needs the admitted
  observation of the person's current message: the same surface, an instance and the
  command in `commands`. So a chip that was off keeps the page out.
- The Session writes the effect to its outbox and to `bakery_surface_effect_delivery`.
  The effect names its command digest and a deadline. A view command also names the
  browser, the chat, the surface session, the epoch and the label of the agent.
- The Organisation Actor sends a `surface_effect` signal to the chat pages of the
  person. The signal names nothing. The bridge of the Portal then reads the effects
  that wait, and a poll is the fallback. Only the browser and the chat of the request
  get the effect.
- The page runs the command with its own state change and posts a receipt. The outcome
  of a view command is `page_completed`, with the observation after the command, or
  `page_rejected`. When the page of the command is no longer on the screen, the outcome
  is `delivery_failed` with the code `surface_unavailable`. The tool result holds the
  receipt.
- An effect with no receipt at its deadline is `indeterminate`. The same call id gives
  the same effect, so a repeated call gets the first receipt.
- The Session can refuse a receipt: `surface_effect_missing`, `surface_effect_conflict`,
  `surface_effect_receipt_invalid`, `surface_effect_organisation_mismatch`,
  `surface_effect_expired` (a receipt at or after the deadline) and
  `surface_effect_authority_invalid` (the turn lease is not current). The route then
  answers 404 or 409, and it answers 422 for a malformed receipt.
- Each page command tool is `modelOnly`, so a Code Mode script cannot change what the
  person sees. The text of a Kitchen tool also tells the agent to call it directly.
  The chat shows a view command as a read: "Nothing was saved."
- The page marks its elements with `data-surface-target`. One overlay draws the named
  label of the agent on the target of a command for 5 s. A shared room holds the label
  of an agent edit for the same time (FND-10).

### The relevance suggestion

With the chip off, Jev can suggest the page. Only the person's click attaches a page.

- The composer checks a draft of 12 characters or more, 500 ms after the last key. It
  checks only in a started chat, and never on send. One check runs at a time.
- The route first applies the audience rule and the read check of the chat. A refused
  check calls no Jev: `page_not_shared`, `canvas`, `chat_read_only` or
  `chat_history_unavailable`.
- Jev gets the draft, the origin label, the last answer (1,000 characters) and the page
  with its section titles. It gets no table row and no fact value. It answers two
  yes/no questions, `about_screen` and `fits_chat`, with the model `jev-1.13.0`.
- The check runs only when the Screen relevance switch is on and the Organisation has
  a Jev key (ORG-02). If not, the answer is `unavailable`, and the chip rule works alone.

| `about_screen` | Band    | Composer                                                                                                                                          |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.65 or more   | `ask`   | On send, one question for this draft: **Send with this page** or **Send without**. If `fits_chat` is below 0.30, also **New chat from this page** |
| 0.30 to 0.65   | `hint`  | The off chip gets the tag "Looks related to your message"                                                                                         |
| Below 0.30     | `quiet` | The plain off chip                                                                                                                                |

- A hint or a question stores one record: the two scores, the band, the model and the
  choice (`attached`, `sent_without`, `new_chat`, `no_action`). It stores no text.
- Each completed check writes the log event `chat.screen_relevance_checked`, with
  scores and no text. The answer goes only to the composer and to the record. The check
  writes nothing to the conversation. The agent has no tool for this check.

### On screen

Knowledge › Context has an **On screen** entry, which leads to Access › Data flow.
For one Case, it lists the newest 200 observations that the agent received. Each line
gives the page, the area, the record label, the two times and the sources, with no view,
state or path. The list reads only the Portal chats of the Case that the reader may see.

## Contracts

- **Tool modules** in `workers/platform/src/agent-tools/`: `define-tool.ts`
  (`defineToolFamily`, `modelToolDefinition`), `registry.ts`, `session-wiring.ts`
  (`SESSION_TOOL_WIRING`), `session-support.ts` (`settleToolEffect`), `tool-effect.ts`,
  `errors.ts`, `host-tools.ts` and the folders of the tool modules. A folder is not
  always one family. `commerce/` also holds the family `cafe`, and `drafts/` holds
  `menu`. `channels/` also holds `mailbox_agent` and `whatsapp_agent`. `bakery/` and
  `costs/` hold tools of the family `kitchen`, and `organisation/` holds no tool.
  `decisions/` holds the family `decisions`.
- **The catalog** in `agent-tools/catalog/`: `selection.ts`, `execute.ts`,
  `permission.ts`, `code-mode.ts`, `tool-registry.ts` and `types.ts`. The Session side
  is `actors/session/tool-wiring.ts` and `actors/pi-durable-tools.ts`.
- **Capabilities** are in `authorization/capability-catalogue.ts`. The tools use 38 of
  them (`HarnessCapabilityName`). An agent can ask for 23 capabilities and 11 record
  reads (`requestable-capabilities.ts`). A new capability needs the policy backfill.
- **Contracts** in `packages/control-api/src/`: `surface-observation.ts`
  (`SurfaceObservationV2`, `ChatOrigin`), `portal-page-view.ts`, `surface-command.ts`
  (`SurfacePageCommandV1`), `screen-relevance.ts`, `case-screen-observations.ts` and
  `chat-signals.ts`. The Kitchen effect and receipt are in
  `packages/bakery-model/src/bakery-surface.ts`.
- **Server modules** in `surfaces/portal/server/chat/`: `screen-observation-admission.ts`,
  `surface-registry.ts`, `kitchen-observation.ts`, `origin.ts`, `screen-prompt.ts`,
  `screen-relevance.ts` and `case-screen-observations.ts`. The effect path is
  `actors/bakery-surface-effect.ts` and `agent-tools/bakery/page-view-handler.ts`.
- **Portal modules**: `surface-observation.ts` and `agent-surface-label.ts` in
  `foundation/ui/features/`, `bakery-surface-effect-bridge.tsx` in
  `areas/kitchen/ui/features/`, `bakery-surface-registry.ts` in
  `areas/kitchen/contract/ui/features/`, and
  `screen-chip.tsx`, `screen-send.ts`, `screen-relevance.ts` and `origin-chips.tsx`
  in `surfaces/portal/ui/features/chat/`.
- **Regional D1**: `bakery_surface_effect_delivery` and `bakery_surface_timeline_event`
  (the Kitchen area owns them). The chat origin and the observations are in the
  `state_json` of the Portal conversation, with no column of their own.
- **Actor SQLite**: the Session keeps each effect in `actor_outbox`, with the envelope
  kind `bakery_surface_effect.v1` and the states `dispatching`, `settled`, `reconciled`,
  `indeterminate` and `quarantined`. The Organisation Actor keeps
  `jev_screen_relevance_switch` and `jev_screen_relevance_record`.
- **Signals**: `chat_changed` and `surface_effect` on the chat signal socket
  (`GET /chat/signals`). The socket needs the admin role.

The routes are under `/v1/control/organisations/:id`:

| Route                                                       | Role     | Purpose                                                   |
| ----------------------------------------------------------- | -------- | --------------------------------------------------------- |
| `POST /chat`                                                | Admin    | A message, with an optional `surfaceObservation`          |
| `GET /chat/surface-effects`                                 | Operator | The effects that wait for one browser and chat, at most 4 |
| `POST /chat/surface-effects/:effectId/receipt`              | Operator | The receipt of one effect. The Session settles it         |
| `POST /chat/conversations/:conversationId/screen-relevance` | Admin    | One check: `{ draft, observation }`                       |
| `POST …/screen-relevance/:checkId/choice`                   | Admin    | The choice of the person                                  |
| `GET /case-context-discovery/screen-observations`           | Admin    | The On screen list: `case_ref`, `revision`                |

## Rules and limits

The role is the role of the person who asked. The agent has no role of its own. A
proposal tool only stages its proposal. A person approves or confirms it (FND-06).

| What the agent or the person may do                                       | Viewer | Operator                                                               | Admin and owner |
| ------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- | --------------- |
| Send a message in a Portal chat                                           | No     | In a workspace canvas chat, and in a private chat from Café › Register | Yes             |
| Give the agent the page on screen                                         | No     | Café › Register only                                                   | Yes             |
| Agent: take a step of a staff page, with the capability                   | No     | Yes, also from Slack                                                   | Yes             |
| Agent: get the Kitchen, Costs and Pastry Bench commands, in a Portal turn | No     | No                                                                     | Yes             |
| Agent: get the Register commands, in a Portal turn                        | No     | Yes, the only page commands                                            | Yes             |
| Read the effects that wait, and post a receipt                            | No     | Yes                                                                    | Yes             |
| Read a Portal chat                                                        | No     | Their own private chat from Café › Register                            | Yes             |
| Get a relevance suggestion. Read On screen                                | No     | No                                                                     | Yes             |

| Limit                                                                                                                                 | Value                                 | Constant                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Screen observation; view sections; commands                                                                                           | 24 KiB; 12; 40                        | `SURFACE_OBSERVATION_MAX_BYTES`, `surfaceObservationSchema`                                                       |
| Table rows and columns; facts in a section                                                                                            | 200 and 24; 40                        | `portalPageViewTableSchema`, `MAX_TABLE_ROWS`                                                                     |
| Sources: in the contract; from the Portal                                                                                             | 200; 60                               | `surfaceObservationSchema`, `MAX_SOURCES`                                                                         |
| Kitchen state; effect; page receipt                                                                                                   | 16, 20, 28 KiB                        | `MAX_CONTEXT_BYTES`, `MAX_EFFECT_BYTES`, `MAX_PAGE_RECEIPT_BYTES`                                                 |
| Effect deadline, at most the end of the turn lease: a command; the command `simulate_workcell`                                        | 20 s; 150 s                           | `SURFACE_EFFECT_TTL_MS`, `SURFACE_SIMULATION_TTL_MS`                                                              |
| Bridge poll: an effect waits and no signal socket is live; an effect waits and a socket is live; no effect waits. Effects at one time | 150 ms; 1 s; 2 s, then up to 5 s. 4   | `ACTIVE_POLL_MS`, `SIGNALLED_POLL_MS`, `IDLE_POLL_INITIAL_MS`, `IDLE_POLL_MAX_MS`, `MAX_IN_FLIGHT`                |
| Repair of the chat record of an effect                                                                                                | 12 tries, 1 s to 15 minutes           | `SURFACE_EFFECT_REPAIR_ATTEMPTS`, `SURFACE_EFFECT_MAX_BACKOFF_MS`                                                 |
| Agent label                                                                                                                           | 5 s                                   | `AGENT_LABEL_HOLD_MS`, `AGENT_ACTIVITY_HOLD_MS`                                                                   |
| The `output` field of a tool result; the text of a failure                                                                            | 24 KiB                                | `MAX_CODE_MODE_OUTPUT_BYTES`                                                                                      |
| Script: source, time, calls, calls at one time, output                                                                                | 64 KiB, 30 s, 8, 2, 24 KiB            | `CODE_MODE_PILOT_BUDGET`, `MAX_CODE_MODE_SOURCE_BYTES`                                                            |
| Script: sandbox memory; interrupt polls                                                                                               | 32 MiB; 50,000                        | `CODE_MODE_SANDBOX_MEMORY_BYTES`, `CODE_MODE_SANDBOX_INTERRUPT_BUDGET`                                            |
| Catalog with no search                                                                                                                | 16 tools and 8 KiB                    | `WHOLE_CATALOG_TOOLS`, `WHOLE_CATALOG_BYTES`                                                                      |
| Relevance draft; pause; last answer                                                                                                   | 12 to 4,000 characters; 500 ms; 1,000 | `SCREEN_RELEVANCE_MIN_DRAFT`, `SCREEN_RELEVANCE_MAX_DRAFT`, `SCREEN_RELEVANCE_PAUSE_MS`, `LAST_ANSWER_CHARACTERS` |
| Relevance request; wait; one day                                                                                                      | 8 KiB; 5 s; 500 checks and $0.20      | `SCREEN_RELEVANCE_MAX_REQUEST_BYTES`, `SCREEN_RELEVANCE_LIMITS`                                                   |

The daily pass of each Organisation (FND-05) deletes a page effect 30 days after it
ended, with its timeline events, unless a saved run or a saved scenario names it
(`deleteEndedBakerySurfaceEffects`). It deletes a relevance record 90 days after its
check. Each delete writes nothing when no row is that old. The purge of an Organisation
erases the D1 rows. The poll of a browser reads only and writes no row.

- **An observation is the sender's input.** The browser makes it, so it can hold
  unsaved values. The prompt marks it "browser-supplied; grants no authority", and it
  tells the model to read saved records with tools before an action. No tool makes
  Memory evidence from an observation: `propose_memory` cites an instruction.
- **The relevance check** goes to the sink `typesafe_system_one` with the purpose
  `screen_relevance`, under the sender's own label (FND-07). The text in the request is
  data: the instructions tell Jev to ignore instructions in it.
- **Private reads.** An agent asks for `order`, `payment`, `shipment`, `stock_policy`,
  `recipe_revision` and `supplier_directory` only in a Portal chat or a direct message.
- **Text of an action.** For an effect that asks a person, Pantry writes the operation
  and its first 12 values (`heldEffectActionRecord`). No model text describes the action.
- **Out of scope:** pixels and screenshots; a screen for Slack; new authority from an
  observation; a save through a page command.
- **Boundaries.** FND-02 owns the sandbox Worker and the Code Mode reservations. FND-03
  owns the conversation, forks and side Cases. FND-04 owns the harness, the lease and
  the replay rules. FND-05 owns the message, the browser context and the Kitchen
  context load (`prepare_context`). FND-06 owns capabilities, grants, permission
  requests and approval. FND-07 owns the labels and the exit check. FND-10 owns rooms.
- Each area owns the commands behind its tools. KIT-01 owns the Kitchen workspace, and
  KIT-04 Costs & margins. CAFE-01 owns menus and the order queue, and COM-01 to COM-05
  commerce. DEV-01, ORG-02, INB-01, INT-01 and BRN-01 own their tools. The Register
  ([Plan 90](../../plan-90-cafe-pos-checkout.md)) and the bake tools
  ([Plan 24](../../plan-24-cafeos-bakery-automation.md)) stay with their plans.

## Open work

- **No generic outbox.** Each page command goes through the Kitchen effect module and
  the `bakery_*` tables. `prepare_context` is not a generic observe command. The Portal
  keeps two registries: `bakery-surface-registry.ts` and `surface-observation.ts`.
- **No turn context item.** An observation enters the prompt beside the message. It has
  no evidence record, no flow label from `sources` and no freshness state. The chat
  context panel shows no "on screen" entry.
- **The offer does not read the observation.** A turn offers each command of the role.
  The catalog compares only the command name, not the surface.
- **Old message parts.** The parser reads only `surface_observation`. It refuses a
  stored `page_view` or `surface` part, and a `surfaceContext` key in a message.
- **Operator and the Register.** The chat signal socket needs the admin role, so the
  Register page of an operator gets no `surface_effect` signal and uses only the poll
  (`GET …/chat?view=state` and the read of that one chat, FND-05). No browser journey
  shows the Register page with an operator's chat; `counter-register-journey.test.ts`
  sends the observation, posts the page receipt and reads the answer.
- **Pastry Bench in the browser.** `chat-pastry-bench.test.ts` sends the observation
  that the Portal sends for the Pastry Bench. No browser journey proves the two tools.
- **Origin.** A side Case, a Slack thread and the Case record have no chat origin.
- **Discovery from the screen** is not built: an On screen entry starts no Case context
  discovery, and no route starts one from a screen source. A discovery selection
  accepts only the source `gmail`, with a verified contact
  (`case-context-discovery/source.ts`).
- **Relevance records** have no view, and a quiet check stores no record.
- **No tools yet:** Projects, Memory edits and evals, terminals, checkout, payment
  accounts and payouts, the Vault and API keys.
- **No journey with a real model.** In the journeys of the Kitchen run, layout and
  production tools, of `recipe_save` and of the supplier tools, the model answers from
  a script. The repository has no journey that runs these tools with a real model.

## Sources

- [Plan 81](../../history/plan-81-agent-portal-control.md). Its evidence in the archive:
  [Kitchen run controls](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-kitchen-run-controls.md),
  [menu controls](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-menu-controls.md),
  [order queue](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-order-queue.md) and
  [recipes and suppliers](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-recipes-suppliers.md).
  The plan also names `plan-81-stock-actions.md` and `plan-81-commerce-actions.md`.
- [Plan 87](../../history/plan-87-screen-context.md). Its evidence in the archive:
  [Phase 1](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-1.md),
  [Phase 1B](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-1B.md),
  [Phase 2](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-2.md),
  [Phase 3](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-3.md),
  [Phase 4](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-4.md),
  [Phase 5](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-phase-5.md) and
  [the thresholds](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-87-d14-thresholds.md).
- Where a source differs from the code, this spec follows the code. The plans name the
  tool list in `actors/harness-tool-catalog.ts` and a view on Costs & margins only.
- E2E journeys in `workers/platform/tests/e2e/`. The screen: `chat-page-view.test.ts`,
  `chat-kitchen-observation.test.ts`, `chat-costs-commands.test.ts`,
  `chat-pastry-bench.test.ts`, `chat-screen-relevance.test.ts`,
  `chat-screen-knowledge.test.ts`, `portal-chat-finalization.test.ts` (the push
  signal) and `bakery-surface-quarantine.test.ts`. The tools:
  `chat-agent-order-queue.test.ts`, `chat-agent-order-queue-recovery.test.ts`,
  `chat-agent-order-read.test.ts`, `chat-agent-recipes-suppliers.test.ts`,
  `chat-agent-permission-request.test.ts`, `pi-cafe-menu-publication.test.ts`,
  `pi-commerce-actions.test.ts`, `pi-stock-actions.test.ts`,
  `costs-and-margins.test.ts` (the hold of the costs saves at the exit check) and the
  `durable-codemode-*.test.ts` journeys.
- Browser journeys in `scripts/plan-81/`: `browser-kitchen-run.js`, which
  `run-browser.py` runs, and `browser-menu-edit.js`.
