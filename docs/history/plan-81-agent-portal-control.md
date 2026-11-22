# Plan 81 — Agent control of the Portal apps

Status: **Complete (2026-11-03).** Slices 1–8 are on `dev` and live. The owner
approved each slice. See [the closing note](#closing-note) for what stays open.

## Goal

The Portal chat agent (Urk, the chat panel beside every Portal page) can do
what the person can do on the page. Every agent action passes the same typed
policy, authorization, approval, receipt and replay boundaries as the person's
click. An access limit raises an approval prompt in context; it never sends
the person to the Access page.

## Why

In a real chat on the Satyr Kitchen page "Financier morning", the agent said
that it could not run a simulation because its tool set had no run command.
The audit below shows that this was half true:

- The agent could already play, step, restart, seek and change the speed
  (`bakery_surface_control_playback`), and open Workflow, Details and Floor
  plan (`bakery_surface_control_workspace_view`). The tool text said that
  playback "never simulates", so the agent did not use it.
- The agent could not run the shift with new inputs. It could only prepare an
  edit. The operator applied the edit into the input draft and then clicked
  Apply changes.

## Audit

### Satyr Kitchen (BakeryOS simulation)

The agent's Satyr Kitchen tools are `BAKERY_SURFACE_DEFINITIONS` in
`services/platform/src/actors/harness-tool-catalog.ts`. The page offers a
subset in `supportedCommands` (`apps/portal/src/features/workflow-simulator/bakery-surface.ts`,
`supportedSurfaceCommands`). The Platform offers the tools only to owners and
administrators (`authorizedBakerySurfaceCommands` in `agent-session.ts`). Each
call is a signed surface effect with a receipt in the Session outbox
(`bakery-surface-effect.ts`); the chat timeline shows the receipt.

| Operator action on the page                         | Agent before Plan 81                                | Gap                                                                      |
| --------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| Play shift, Pause, Next event, Restart, Speed, seek | `control_playback`                                  | Tool text said "never simulates"                                         |
| Workflow, Details, Floor plan, camera, labels, map  | `control_workspace_view`                            | None                                                                     |
| Edit inputs, then Apply changes (run the shift)     | `prepare_edit` only; the operator applies           | **No run**                                                               |
| Re-run the applied inputs                           | None                                                | **No run**                                                               |
| Select a station, batch, task or resource           | `set_view`                                          | Equipment selection in the 3D view and the Equipment tab is not a target |
| Rotate equipment 90° (R), move equipment            | None                                                | **No layout command**                                                    |
| Details tabs: Inputs, Batches, Workers, Equipment   | Docks only                                          | Tab choice inside Details                                                |
| Compare oven outage, pin a baseline                 | `control_baseline` (production only)                | Shift comparison                                                         |
| Save a scenario copy                                | `prepare_scenario_save` (operator confirms)         | None                                                                     |
| Open a financier production run, Run in browser     | `prepare_run_open`, `simulate_workcell`             | Starting a new production run from the shift                             |
| Apply a reviewed production draft                   | `apply_production` only while no result is accepted | **No approval path after accepted results**                              |
| Persistent oven run: pause, resume, extend          | `prepare_production_control` (operator confirms)    | Oven page has no other agent controls                                    |

### Ecommerce (AgentCommerce)

- The agent reads records and reports (`commerce_entity_context`,
  `commerce_merchant_report`).
- It proposes three governed actions through `commerce_propose_action`:
  `publish_catalog_listing`, `cancel_order` and `adjust_offer_price`. Each one
  passes the capability check, a Case proposal and the action ledger, waits
  for approval, and leaves a receipt.
- `commerce_propose_plugin` covers checkout rules, event handlers and staff
  actions, also with approval.
- Gaps, by value to a pâtisserie owner:
  1. Menus: read only. No item edit, publish, boards or screens.
  2. Refunds other than cancellation: no counter-sale or partial refund tool.
  3. `attach_tracking` and description publish: the backend supports them, but
     the tool does not list them.
  4. Stock, production requests, purchasing and recipes: no write tools.
  5. Price allowance and campaign brief: Slack only; Portal chat staging
     fails.
  6. Checkout profiles, terminals, counter sales, supplier payouts: nothing.
  7. Discounts and customers: only through a plugin.

### Café operations (workspace pages)

- Inbox: search, reply proposals and draft edits, each with approval in the
  Inbox and a receipt.
- Knowledge: `propose_memory`, which a person accepts in Brain.
- Access: `request_permission` raises an Allow prompt in the chat.
- Projects: `propose_side_case` only.
- Gaps, by value:
  1. Agents, Schedules and skills setup: `configuration_propose` exists but
     is Slack only.
  2. Inbox triage: Case status, processing and supplier or customer links.
  3. Knowledge evals and memory edits.
  4. Projects: create a Project, move a chat.
  5. Settings and members: keep these for people.

### Shared mechanism

Only Satyr Kitchen has a page-command bridge: the Platform outbox, the
browser poll, the signed receipt and the page registry. The design is general
(digest-checked effects with deadlines, an idempotent ledger and receipts),
but every type is bakery-specific. Shared draft documents (descriptions,
email, production plan, workflow canvas) are the second path. A menu draft
actor exists, but the agent can only read it.

## Plan, ordered by value

1. **Slice 1 — Satyr Kitchen run controls (done on the branch).** The agent
   runs and re-runs the shift with the same function as Apply changes, then
   plays or steps it. Correct the playback tool text and the chat prompt.
2. **Slice 2 — Satyr Kitchen layout and selection (done on the branch).**
   Equipment selection and Rotate 90° as typed surface commands with the
   floor-plan checks; Details tabs; shift outage comparison.
3. **Slice 3 — Approval in context for destructive Satyr Kitchen work (done
   on the branch).** When `apply_production` meets accepted results, open the
   same replacement review that the person sees; the person confirms in the
   workspace. Start a new financier production run from the shift.
4. **Slice 4 — Menus (done on the branch).** Agent edits on the menu draft
   through the Plan 40B shared draft, and publish as a governed action with
   approval.
5. **Slice 5 — Commerce actions that the backend already has (done on the
   branch).** Add `attach_tracking` and description publish to
   `commerce_propose_action`; add refunds as a governed action; make
   `configuration_propose` and the price allowance work in Portal chat with an
   approval card.
6. **Slice 6 — Stock, production requests and purchasing (done).** Governed
   actions with the same approval and receipt path as the
   person's Portal commands.

7. **Slice 7 — The shop's order queue and sold out today (done).**
   Direct tools with the person's own commands, role check and receipts.
8. **Slice 8 — Recipes and suppliers (done).** The same direct
   tools for the Recipes and Suppliers pages.
9. **Slice 9 — Payments (done).** The direct tool `payments_read` for the
   Payments page.
10. **Slice 10 — The page on the screen (done).** A side chat message
    carries the Portal page that the person has open. Costs & margins is the
    first page.
11. **Slice 11 — Agent labels that a person can see (done).** On a shared
    page, the agent's named label stays on what it changed for 5 seconds.

## Slice 11 — Agent labels that a person can see

The shared pages (Costs & margins, the workflow canvas, production plans,
product descriptions and Inbox reply drafts) show a named agent label on the
cell, node, line or field that the agent edits. The room showed it only while
the write ran, a few milliseconds, so people did not see it.

- **Hold.** After an accepted edit, `collaboration-room.ts` keeps the label on
  its target for `AGENT_ACTIVITY_HOLD_MS` (5 seconds), or until the same agent
  starts its next edit. A refused edit shows no held label. The label grants
  nothing, so the room does not check it again during the hold.
- **Saves on Costs & margins.** `costs_plan_save` and `supply_cost_save` show
  the label on the first cell that the save changed, for each person with the
  sheet open.
- **Limits.** One label per edit: a change of many cells labels the first
  one. Reads show no label. Pages with no shared room (Products, Orders,
  Recipes) show no label.
- **Proof.** `tests/e2e/costs-and-margins.test.ts`: the label is still on the
  edited cell 2 seconds after the edit, then clears; a plan save labels the
  labor cell. A hold of 0 ms fails the journey. The canvas, production plan,
  description and Inbox draft journeys wait for the label to clear.

## Slice 10 — The page on the screen

A person asks the side chat about the page beside it ("what spoil rate do I
have on screen?"). Before this slice the agent read only saved records, so it
could not see unsaved edits, the open tab or the filter.

- **One view per message.** A page registers a capture in
  `apps/portal/src/features/portal-page-view-registry.ts`. When the person
  sends a message, `sendChat` adds the newest page of the Organisation as
  `pageView` (`PortalPageViewV1` in `@satyr/control-api`): titled facts and
  tables, at most 24 KiB. The registry drops table rows to fit and keeps
  `totalRows`, so the model knows rows are missing.
- **Costs & margins.** `features/costs/costs-page-view.ts` sends the open tab,
  the category filter, the search, the selected product, if edits are unsaved,
  the scenario inputs, the plan totals and the rows of the open table.
- **Model input.** The message keeps the view as a `page_view` part. The turn
  prompt shows the view of the current request only, marked as an observation
  that grants no authority. The model reads saved records with tools before an
  action.
- **Audience.** The person saw the page, so the view is their own input, like
  the message text. A shared chat's reply reaches members who may not read the
  page, so a shared chat stores the view but the model does not get it.
- **Limits.** Only Costs & margins registers a view. Other pages send none. A
  message that steers a running turn does not add its view to that turn. The
  Portal does not show the person which view it sent.
- **Proof.** `tests/e2e/chat-page-view.test.ts`: the model gets the Costs view
  with an unsaved spoil rate; a later message from no page carries no stale
  view; a malformed view refuses the message; a shared chat gives the model no
  view.

## Slice 9 — Payments

The Payments page (formerly Failed payments) lists each card payment that the
provider answered, paid or declined, with the tries that follow a decline.

| Person's control on the page | Agent tool      | What it needs                          |
| ---------------------------- | --------------- | -------------------------------------- |
| The payments of a window     | `payments_read` | Commerce context, and the `order` read |

- **One read.** The tool runs the person's read: Underclerk's
  `GET …/reports/payments`, with the person's role and Allow prompt as in
  slice 7. It needs no new capability, so no policy backfill is due.
- **Window.** The agent gives `start` and `end` as ISO 8601 timestamps, at most
  32 days apart. Underclerk has no shop time zone, so the agent asks the person
  for the period when it does not know it. A bad window is refused in words and
  reads nothing.
- **Answer.** The steps of the page, and a `summary` that counts each run once:
  paid on the first try, recovered after a decline, or not recovered, with the
  money that the paid steps took for each currency. It names no buyer.
- **Limits.** A payment that still waits for the provider and a refund are not
  listed. A read lists at most 500 runs and says when there are more. The tool
  reads only: no refund, retry or payment link starts from it.
- **Proof.** `tests/e2e/chat-agent-order-queue.test.ts` (step 10) reads a
  declined card and two paid orders through the tool and through the page, and a
  viewer stays refused. `tests/e2e/order-queue.test.ts` covers the route.

## Slice 8 — Recipes and suppliers

Production and purchasing are daily shop work, and these records hold no money
and no secret.

| Person's control on the page | Agent tool        | What it needs                                                 |
| ---------------------------- | ----------------- | ------------------------------------------------------------- |
| Recipes: the library         | `recipe_read`     | Commerce context, and the `recipe_revision` read              |
| Recipes: New, Edit, Save     | `recipe_save`     | `commerce.recipe.save`, and the `recipe_revision` read        |
| Suppliers: the directory     | `supplier_read`   | Commerce context, and the `supplier_directory` read           |
| Suppliers: Add supplier      | `supplier_create` | `commerce.supplier.create`, and the `supplier_directory` read |

- **One set of commands.** `commerce/recipe-commands.ts` and
  `registerSupplier` in `commerce/purchasing/supplier-creation.ts` hold the work.
  The person's routes and the tools run this code and the same input parsers. A
  supplier's id comes from `supplierIdFromName` in `@satyr/control-api`, on both
  sides.
- **Role.** As in slice 7: a current member with the staff role or higher, read
  at the call. A turn with no person cannot use them.
- **Access prompts.** A refused read raises the Allow prompt in a direct call.
  Each capability brings the read that it needs into one prompt. Both reads are
  for a Portal chat or a direct message only: recipes are the shop's trade
  secret, and the directory holds people's contact details. No text sends the
  person to a settings page.
- **Exit check.** Unlike a queue move, a save carries words from the chat into a
  record that every member reads. So it passes the check of a shared draft
  (`passSharedDraftExit`): a change from a private chat asks once, and the person
  then asks again. A shared chat, a channel and a Project chat do not ask.
- **No approval card (owner's decision, 2026-11-03).** The tools have the
  person's boundaries, and the person has no card. A recipe save makes a new
  revision, and production keeps the revision that it named.
- **Stale edits.** The agent names the revision that it read. A recipe that moved
  is refused in words. A sale that moved only the shop's revision costs a repeat
  and not a refusal.
- **Receipt and replay.** The tools write the person's receipt, with the route and
  the operation of the page and a key from the tool call. After a lost process,
  Pi runs the call again and the receipt answers. If the process was lost before
  the receipt, a recipe that holds this draft at the next revision answers, and a
  supplier's commands replay under their keys.
- **Email contact.** A supplier's email becomes an active contact, as on the
  page. Satyr can then draft email to it, and it can match a sender in the mail
  assistant. A person approves each email. The tool text tells the agent to use
  only details that the person gave, and to show the name and the email first.

### Release

`commerce.recipe.save` and `commerce.supplier.create` are new catalogue
capabilities. Before the release, apply
`node scripts/capability-policy-backfill-sql.mjs` to each regional database. The
schema check and the Access read fail without the rows. No D1 table changes.

Released on 2026-11-03 with the backfill applied. The owner granted the recipe
read on production through the Allow prompt.

### Limits

- `supplier_read` does not list the items that each supplier provides.
- A supplier's name needs a Latin letter or a digit, as on the page.
- Purchasing activation, supplier edits, recipe links and supplier payouts stay
  with people.

### Proof

`tests/e2e/chat-agent-recipes-suppliers.test.ts`. See
[the evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-recipes-suppliers.md).

## Slice 7 — The order queue and sold out today

A shop uses the order queue all day, so a move has no approval card (owner's
decision, 2026-11-02). Plan 40B already records "Sold out today: staff and
agents, no approval".

| Person's control on the order queue page | Agent tool            | What it needs                                    |
| ---------------------------------------- | --------------------- | ------------------------------------------------ |
| The queue                                | `order_queue_read`    | Commerce context, and the `order` read           |
| Start, Ready, Hand over                  | `order_queue_advance` | `commerce.order_queue.advance`, and `order` read |
| The sold out list                        | `sold_out_read`       | Commerce context, and the `product` read         |
| Sold out today, Back on sale             | `sold_out_mark`       | `commerce.sold_out.mark`, and the `product` read |

- **One set of commands.** `commerce/order-queue-commands.ts` holds the walk
  through the queue and the mark. The person's routes and the tools run this
  code, so that the two cannot differ. A hand-over moves no money: Underclerk
  only checks that the payment exists.
- **Role.** Each tool reads the person's role at the call, as the page does: a
  member with the staff role or higher. A turn with no person cannot use them.
  In practice, a Portal chat is for an owner or an admin, and Slack refuses a
  viewer at ingress.
- **Access prompts.** A refused `order` or `product` read raises the Allow
  prompt in a direct call, with `requestDeniedRead`. Inside Code Mode the text
  tells the agent to call `request_permission`. Both new capabilities are
  requestable, so the agent asks for them in place. No text sends the person to
  a settings page.
- **Exit check.** Both capabilities are in `INSIDE_CAPABILITIES`. A move carries
  no chat content: only an id and an action. So a private chat does not ask for
  each move. Another person's private content in the turn still asks.
- **Receipt and replay.** The tools write the person's receipt, with the route
  and the operation of the page and a key from the tool call. After a lost
  process, Pi runs the call again and the receipt answers. If the process was
  lost before the receipt, the queue's stage decides: a step that happened is
  not repeated.
- **Time zone.** Underclerk has no shop time zone, and the page sends the
  device's zone. The agent gives `timeZone` and asks the person if it does not
  know the zone. A wrong zone ends the mark at the wrong midnight.

### Release

`commerce.order_queue.advance` and `commerce.sold_out.mark` are new catalogue
capabilities. Before the release, apply
`node scripts/capability-policy-backfill-sql.mjs` to each regional database.
The schema check and the Access read fail without the rows. No D1 table changes.

### Limits

- The Underclerk receipt names the person who asked. It does not name the agent.
  The chat timeline shows that the agent made the move.
- Boards, screens, prices and deals stay with Plan 40B phase 4.

### Proof

`tests/e2e/chat-agent-order-queue.test.ts` and
`tests/e2e/chat-agent-order-queue-recovery.test.ts`. See
[the evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-order-queue.md).

## Slice 6 — Stock, production requests and purchasing

- **One tool, one action kind.** Tool `commerce_propose_stock_action` with the
  requests `receive_stock`, `count_stock`, `adjust_stock`, `request_production`,
  `advance_production_request` and `update_purchase_request`. One action kind,
  `stock_operation`, with five verbs: `commerce.stock.receive`,
  `commerce.stock.count`, `commerce.production_request.create`,
  `commerce.production_request.advance` and `commerce.purchase_request.update`.
  The tool uses the existing `commerce.action.propose` capability, so there is
  no new catalogue row and no backfill.
- **The person's commands.** Execution sends the same Underclerk commands as the
  Portal routes for deliveries, counts, production requests and purchase
  requests. The client package now owns the purchase request attributes, and
  `commerce/list-entry-commands.ts` owns the list commands, so the two paths
  cannot differ.
- **What the approval signs.** The action path freezes what the card shows,
  a count's position and lot revisions, entry revisions, the list revision and
  the purchase attributes. A count on a shelf that moved fails, with no change.
  A delivery adds to the shelf, so it reads the item, position and merchant
  revisions at execution. A linked delivery reads the purchase request revision
  at execution.
- **Approval.** An owner or admin approves with the Google step-up, in the
  Portal. This is higher than the person's own operator-level click, because
  the agent proposes the change. Slack cannot approve these actions.
- **Reads.** The agent must read a stock position or list entry through
  `commerce_entity_context` first. A `commerce_list` grant now also admits a
  page of that list through the selector of `commerce_entity_context`.
- **Access prompts.** `inventory_position` and `replenishment_queue` are now
  requestable reads, beside `production_requests`. A denied direct read asks
  for the grant. After a denied read in Code Mode, the agent names the read in
  `request_permission`.
- **Replay.** After an uncertain result, a delivery or a count settles from the
  Underclerk receipt. A list command is replayed only when its entry shows that
  it committed. It never runs again when the entry is absent.
- **Left to people.** Production setup, purchasing activation and recipe links.
  Slice 8 adds recipes and supplier creation.
- **Evidence.** `docs/evidence/plan-81-stock-actions.md`.

## Slice 5 — Commerce actions

- **Tracking and description.** `commerce_propose_action` takes
  `attach_tracking` and `update_product_description`. For tracking the agent
  names the fulfillment and the shipment that it read; Platform fills the
  order, the batch and the merchant revision from current records. The agent
  cannot name them wrongly. The person's approval card and execution are
  unchanged.
- **Refunds.** Tool `commerce_propose_refund`, verb `commerce.order.refund`.
  The agent gives an order that it read, a reason, and either the whole order
  or named lines with an optional amount. The proposal freezes the payment,
  the policy, the amount and the allocation in the action path, so an approval
  signs exact money. A refund keeps the Google step-up and cannot be approved
  from Slack. Underclerk checks the order revision and the refundable amount at
  commit. After an uncertain result, the receipt under the action's key decides.
  An order with more than one payment goes to a person.
- **Setup changes and price allowances.** `configuration_propose` now works in
  a Portal chat. The draft shows as a card in the chat, with the action label
  and the consequence. Only the person who asked can confirm or discard it, as
  in Slack, through the same draft store, so one draft applies one time on
  either surface. A campaign brief stays Slack only, because the Portal has no
  card for it yet.
- **Evidence.** `docs/evidence/plan-81-commerce-actions.md`.

### Follow-up: order reads

A live Portal chat on 2026-11-02 asked how many orders were open. The agent had
no order read and told the person to find access controls, with no prompt, against
this plan's goal. Home showed the count, because a person's page does not use agent
grants. The owner decided to let agents ask for four more reads.

- `order`, `payment`, `shipment` and `stock_policy` are requestable, in a Portal
  chat or a direct message only (Plan 27B records the rule).
- A refused `commerce_merchant_report` or `commerce_entity_context` read of one of
  these types raises the prompt by itself.
- Inside Code Mode a refused read cannot pause the script. Its refusal text tells
  the agent to call `request_permission`, and no text sends the person to a settings
  page any more.

Limits: `product_sales` needs variant reads that an agent cannot ask for, so it
keeps the refusal. Proof: `services/platform/tests/e2e/chat-agent-order-read.test.ts`
has a real shop and a real paid order, and a simulated model and Slack. It fails
without this change.

## Slice 1 — Satyr Kitchen run controls

- **Contract.** `run_shift` in `@satyr/bakery-model/bakery-surface`: the
  exact draft reference and 0–8 input edits. No edits re-runs the applied
  inputs.
- **Platform.** Tool `bakery_surface_run_shift`. Owners and administrators
  only, as for the other Satyr Kitchen tools. The receipt check accepts a run
  only when the page reports a shift with a newer draft revision, no pending
  proposal, playback at 06:00 and paused, and a surface epoch one higher. The
  chat timeline shows "Run Satyr Kitchen shift" with the inputs.
- **Portal.** Apply changes and `run_shift` call one function,
  `runShiftInputs` (`workflow-simulator/shift-run.ts`). The page refuses an
  agent run when the draft changed, the recipe is loading, the operator has
  unapplied input changes, the operator has an unsaved operation draft, the
  recipe fixes the input, or a value is out of range. A person's click has the
  same checks; the operator's own unapplied values are never applied or
  discarded by the agent.
- **No approval step.** A shift run is local to the page, like the person's
  click: it saves nothing and changes no record. Saves keep their operator
  confirmation.
- **Evidence.** `scripts/plan-81/run-browser.py` runs the journey
  `browser-kitchen-run.js` against the production Worker routing with its own
  D1, the built account Worker and the Portal from source. The model provider
  is simulated; it only answers with the next tool call of a fixed script.
  See [the evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-kitchen-run-controls.md).

## Slice 2 — Satyr Kitchen layout and selection

Each command does what one click of the person does, through the same reducer
or placement function. None of them saves anything.

| Person's control                                                           | Agent tool                                                   | Command              | Receipt check                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------- |
| A Batches, Workers or Equipment chip in Details, or a click in the 3D view | `bakery_surface_select`                                      | `select_item`        | Details open on the selected item                                                              |
| Details → Inputs                                                           | `bakery_surface_control_workspace_view` (`openDock: inputs`) | existing             | existing                                                                                       |
| Rotate 90° (R)                                                             | `bakery_surface_rotate_equipment`                            | `rotate_equipment`   | The appliance's yaw is the next quarter turn, and the surface epoch is one higher              |
| 3D rotation ring or 2D free-angle handle (`0–359°`)                        | `bakery_surface_set_equipment_angle`                         | `set_equipment_angle`| The appliance's yaw matches the requested degree angle, and the surface epoch is one higher    |
| Drag an appliance or furniture item on the floor plan or in 3D             | `bakery_surface_move_equipment`                              | `move_equipment`     | The appliance's `(xMm, zMm)` coordinates match, and the surface epoch is one higher            |
| Click a door or service window                                             | `bakery_surface_toggle_opening`                              | `toggle_opening`     | The opening's `open` state matches, and the surface epoch is one higher                        |
| Floor plan room switcher                                                   | `bakery_surface_select_floor_plan`                           | `select_floor_plan`  | The active `floorPlan` matches, and the surface epoch is one higher                            |
| Store interior design & materials menu                                     | `bakery_surface_configure_interior`                          | `configure_interior` | `layout.interior` reflects the preset, material, wall height or furnishings; epoch unchanged   |
| Undo, Redo, Reset layout, or Reset to initial                              | `bakery_surface_reset_floor_plan`                            | `reset_floor_plan`   | The floor-plan workspace applies the history or reset action, and the surface epoch increments |
| Compare shifts: Replay normal shift, Compare oven outage                   | `bakery_surface_compare_shift`                               | `compare_shift`      | The chosen run in the open comparison panel                                                    |

- **Context.** The shift context carries `layout`: the open floor plan, each
  appliance's `(xMm, zMm)` position and integer yaw (`0–359°`), interactive
  doors and windows (`openings`), the store interior design (`interior`), and
  undo/redo/custom-layout availability (`history`). Contexts saved before this
  change have no layout or omit optional fields, and they still parse.
- **Platform.** `authorizedBakerySurfaceCommands` admits only `owner` and
  `admin` roles; non-admin roles (`operator`, `viewer`) receive zero
  `bakery_surface_*` tools even through `tool_search`. Equipment moves, turns,
  free angles, opening toggles, room switches and undo/redo/reset pin the
  observed `floorPlan` (and `fromYawDegrees` for quarter turns) from the
  attached context, so an operator edit made after the agent read the page is
  refused as stale.
- **Portal.** Spatial floor-plan commits (`rotate_equipment`,
  `set_equipment_angle`, `move_equipment`, `toggle_opening`,
  `select_floor_plan`, `reset_floor_plan`) defer intermediate workspace
  listener recalculations and recalculate walk times and the shift schedule
  once per command, advancing `surfaceEpoch` by exactly `1`. Obstructed door
  swings and unavailable undo/redo steps are refused as `invalid_edit`.
  `configure_interior` updates the store interior palette or cutaway height
  without bumping `surfaceEpoch`.
- **Browser modules.** The floor-plan modules need a browser, so the route
  supplies the layout reader (`shift-layout.ts`) to the surface module.
  Platform tests that import the surface module stay free of browser types.
- **Evidence.** The browser journey covers quarter-turn rotation, room
  switching to Kinshicho, Parisian Noix interior configuration, corridor door
  opening, equipment coordinate placement, free-angle yaw, undo, reset to
  initial layout, and non-admin refusal. See
  [the evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-kitchen-run-controls.md).

## Slice 3 — Approval in context and new production runs

| Person's control                                                  | Agent tool                                                                                | What happens                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipe catalog → financier production                             | `bakery_surface_start_production` (`start_production`, preset `procedure` or `one-batch`) | The page leaves the shift for Production, as the catalog click does. A new run prepares its native requests. An open financier run reopens unchanged.                                                |
| Apply preview and prepare new requests, with no result in the run | `bakery_surface_apply_production`                                                         | The reviewed draft runs at once as a new run (as before).                                                                                                                                            |
| The same button, with accepted results in the run                 | `bakery_surface_apply_production`                                                         | The page opens "Review production replacement" in Edit scenario, the card that the person's click opens. The run stays unchanged. Only the person can confirm or discard it; no agent tool confirms. |

- **Receipts.** `start_production` must leave Production open two epochs
  later (Recording view, then Production). `apply_production` must either
  start the previewed run on the next epoch, or leave the run on its epoch
  with the open Edit scenario panel and a review of that exact preview over
  the current run. The chat says which: "Applied the reviewed preview as a
  fresh production run", or "The run holds accepted results, so the
  replacement waits for the operator's review in Edit scenario."
- **Refusals.** As before, the agent's apply is refused while a result waits
  for review, a browser job runs or a save is unresolved.
- **Evidence.** The journey opens a financier run from the shift and applies
  an oven-outage draft as a new run (22 of 22 checks on dev). Its
  `--robot-review` variant first simulates and accepts one robot step in
  browser MuJoCo; the apply then opens the review card, and the owner
  confirms it (23 of 23 checks). That variant needs the follow-up below.

### Follow-up closed: stale robot request template

Financier robot steps failed in the browser with "The request model does not
match the pinned browser assets", because new requests copied the model hash
of an older recording. New production and tray-chain requests now derive the
hash from the pinned assets. The four bundled recordings were also recorded
again on the pinned assets, so a cleared preset tray runs in the browser and
accepts a rack edit. Their steps, events and samples did not change. The next
asset rebuild needs another recording of those four files.

## Slice 4 — Menus

An agent changes the shared menu in the room that people edit, and proposes
its publication. An owner or admin approves the exact menu.

### What changes

- `menu_draft_edit` makes one change: rename the menu, add a section, add,
  rename, describe, move or remove an item. It needs the new capability
  `commerce.menu_draft.edit` and a member who can edit. It has no commerce
  effect and never changes a price.
- The edit reaches open Menus pages at once. A repeated operation applies one
  time. A new section or item takes its identity from the operation.
- `commerce_propose_menu_publication` names the draft revision that the agent
  read. A stale revision and an item that the café cannot sell are refused in
  words that the agent can act on. The check uses the same code as the person's
  Publish button (`commerce/cafe-menu-publication.ts`).
- The proposal is the governed action `publish_cafe_menu`
  (`commerce.menu.publish`). Its path carries the exact Underclerk menu and the
  names on the card, so the approval signs what goes live. It uses the Case
  proposal, the action ledger, the step-up approval and the receipt of the
  other commerce actions.
- A draft edit after the proposal stays in the draft. Underclerk checks the
  menu, offer and plan revisions at commit, so an approved publication that the
  shop has overtaken fails and leaves the live menu alone. A publication
  keeps the menu's serving hours; only a person sets new ones.
- After an uncertain result, the receipt under the action's key decides. The
  merchant revision moves after a commit, so a resend alone cannot prove it.

### Plan 27C in a Portal chat

Private content asks, once for each edit, as for each shared draft. A Portal
private chat is private content, so each menu edit from it needs one Allow, and
then the person asks again. A public channel, a shared chat and a Project chat
are internal content, and their edits do not ask.

The first journey of this path found a fault: a Portal chat runs each message
in its own Session, and a pass was stored for one Session, so the second request
asked again and an Allow never helped. A Portal chat's pass now belongs to the
person who asked. A Slack thread's pass stays with its Session. This fix also
covers the other shared drafts and canvas moves from a Portal chat.

### Release

`commerce.menu_draft.edit` is a new catalogue capability. Before the release,
apply `node scripts/capability-policy-backfill-sql.mjs` to each regional
database. The schema check fails without the row.

### Limits

- The agent gives the owner a link to the approval card in Operations. The card
  does not show in the chat.
- Slack cards cannot approve a menu publication. An approval from Slack needs
  the owner's choice, as for the other kinds in
  `SLACK_APPROVABLE_ACTION_KINDS`.
- Boards, screens, prices and deals stay with Plan 40B phase 4. Sold-out marks
  moved to slice 7.

### Proof

`services/platform/tests/e2e/pi-cafe-menu-publication.test.ts` runs on the
production gateway and Underclerk, with a simulated model and Slack.
`scripts/plan-81/browser-menu-edit.js` runs the Portal chat beside the Menus
page. The [evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-menu-controls.md) records both.

## Closing note

The eight slices are the scope of this plan. Each one is on `dev` and live.

These audit gaps have no slice. The agent cannot yet do this work, and no plan
owns it:

- Projects.
- Brain memory edits and evals.
- Terminals.
- Checkout.
- Payment accounts and payouts.
- Vault and API keys.

Two gaps belong to other plans: menu boards go to Plan 40B phase 4, and Inbox
triage goes to Plan 83.

The live check of slice 8 proved `recipe_read` with a real model, and no
`recipe_save` or supplier tool ran with a real model. See
[the evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-81-recipes-suppliers.md).

## Not in scope

Physical robot dispatch stays with Plan 24. Live provider acceptance (a real
model on the deployed Worker) for slices 1–3 is not done.
