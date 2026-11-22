# COM-05 — Merchant operations

Merchant operations are the daily commerce work of a shop in Purin Pantry. A person or a
Sous Chef agent proposes a commerce change. An owner or an admin approves it, and the
selected commerce system runs it and returns a receipt. The outcome goes back to the
Case that asked. Home shows the approvals and the recent activity. The Agents page
configures the agents of an Organisation: areas, definitions, skills, installations,
triggers and limits. Sous Chef answers merchant questions, and it gives an on-demand
brief of failed payments and delayed orders. Purchasing keeps suppliers and a
replenishment queue for low stock. The export catalog places products, such as four
flavored cookie boxes, on the shipping storefront.

## What it does

### Governed actions

Each change names the exact record and the revision that it expects. A delivery
(`receive_stock`) and a new production request expect revision 0
(`kitchen/contract/stock-action.ts`). The action ledger of `OrganisationActor` holds
the change (FND-06). The kinds are in `CommerceActionRequest`
(`services/platform/src/commerce/action-model.ts`):

| Kind                                                       | Who proposes                                         | Runs at             | Slack approval |
| ---------------------------------------------------------- | ---------------------------------------------------- | ------------------- | -------------- |
| `publish_catalog_listing`                                  | The control route, `commerce_propose_action`         | Engine              | Yes            |
| `update_product_description`                               | Portal (FND-10), `commerce_propose_action`           | Engine              | Yes            |
| `cancel_order`                                             | Portal, `commerce_propose_action`                    | Engine or Shopify   | No             |
| `attach_tracking`                                          | Portal (a tracking batch), `commerce_propose_action` | Engine              | Yes            |
| `adjust_offer_price`                                       | The control route, `commerce_propose_action`         | Engine              | Yes            |
| `install_merchant_plugin`                                  | `commerce_propose_plugin`                            | Engine (COM-02)     | Yes            |
| `publish_cafe_menu`                                        | `commerce_propose_menu_publication`                  | Engine (CAFE-01)    | No             |
| `change_menu_price`                                        | `menu_board_propose_price`                           | Engine (CAFE-01)    | Yes            |
| `refund_order`                                             | `commerce_propose_refund`                            | Engine (COM-04)     | No             |
| `stock_operation`                                          | `commerce_propose_stock_action`                      | Engine              | No             |
| `submit_supplier_payout`, `resume_supplier_payout_funding` | The control route                                    | The payout provider | No             |

`POST …/commerce/actions` accepts the first five kinds and the two payout kinds. No
Portal page sends `publish_catalog_listing`, `adjust_offer_price` or a payout kind;
the Portal only shows them. The route refuses the other kinds with
`commerce_action_path_invalid`, so only an agent proposes them. No agent tool proposes
a payout. "Engine" is the commerce engine of Purin Checkout. The lab runs only
`publish_catalog_listing`, `attach_tracking` and `cancel_order` (COM-03), and it
refuses each other kind with `commerce_action_path_invalid`. Shopify runs only
`cancel_order`. A `stock_operation` is a delivery, a count, a new production request,
the advance of a production request or a purchase request update. The tool kind
`adjust_stock` becomes a count (`kitchen/contract/stock-action-plan.ts`).

"Slack approval" is `SLACK_APPROVABLE_ACTION_KINDS`. A Slack Approve makes approval
evidence of kind `slack_verified_link`, and the ledger refuses that evidence for a kind
with "No". For such a kind, the Slack card has only **Review in Portal**, and a Slack
Decline is refused too.

One more kind, `patch_commerce_list_entry` (verb `commerce.list_entry.patch`), is not
in `CommerceActionRequest`. `POST …/commerce/list-entries/:id/patch` makes it when the
Organisation policy requires approval for that verb, and answers 202. It goes through
the same approval and `execute` routes.

1. **Propose.** A Portal proposal makes the Case `case_merchant_action_<digest>`. An
   agent proposal goes to the Case of its turn (`actors/harness-commerce-proposal.ts`).
   The Case accepts it, and the ledger stores it as `proposed`.
2. **Wait.** The Case waits on the approval and refuses a new trigger
   (`case_waiting_for_approval`). An agent proposal in a Slack-bound Case posts a card.
   A Portal proposal posts no card.
3. **Decide.** An owner or an admin approves, and the entry is `signed` (FND-06). A
   rejection (`{ "reason": "merchant_declined" }`) makes it `rejected`. The person who
   proposed a payout destination may not approve a payout to it
   (`supplier_payout_approver_forbidden`).
4. **Run.** The Portal calls `POST …/execute`. A Slack Approve signs and runs in one
   click. A changed record gives 409 `commerce_action_revision_stale` or
   `commerce_action_authority_rebase_required`, and the person proposes again.
5. **Settle.** A receipt makes the entry `confirmed`, `failed` or `indeterminate`. A
   payout run records only `confirmed` or `failed`. An `indeterminate` run answers 503,
   and Pantry does not retry it by itself. **Reconcile approved change** calls
   `execute` again.
6. **Report.** The Case gets one outcome: `provider_receipt`, `merchant_rejection` or
   `execution_failure`, as the output `output_commerce_<nonce>`.
   `deliverCommerceCaseOutput` checks the authority and the flow binding again, then
   the Connector posts it to the Case binding.

An entry expires 15 minutes after the proposal if it is still `proposed`,
`approval_requested` or `signed`. So **Apply change** must run within 15 minutes. An
`executing` entry whose 5-minute lease ends becomes `indeterminate` at the alarm.

The Case wait (`CASE_APPROVAL_WAIT_MACHINE`) does not decide by itself. The Case alarm
reads the ledger each minute for the first 10 minutes of a wait, then each 15
minutes (`actors/case-alarm.ts`). An `expired` entry makes the wait `lapsed`, and the
Case opens again.

### Approvals and activity on Home

The old Operations page is retired: its path opens Home. Home has the section
**Approvals and activity** (`OperationsPage` in `areas/organisation/ui/pages/automation.tsx`):

- **Commerce exceptions** (`CommerceExceptionWorkbench`): a shipment with a label and a
  tracking number, whose fulfillment is still `requested` and has an `expected_by`
  date. Items sort by that date. A person selects 1 to 50 items. Pantry freezes them
  as `tracking_batch_<sha256>` and sends one `attach_tracking` proposal for each.
- **Approvals**: entries in `proposed`, `approval_requested`, `signed`, `failed` and
  `indeterminate`.
- **Recent activity**: at most 8 entries in `executing`, `confirmed` or `rejected`.
- **Expired proposals**: a closed group, with a count.

Home reads the 50 newest ledger entries of all kinds and keeps the commerce ones. So an
older pending approval can drop off Home.

The detail panel (`CommerceActionStatus`) shows **Apply change** for a `signed` entry,
**Reconcile approved change** for an `indeterminate` entry and **Retry Slack
notification** at the end. A Slack card links to `…/operations?commerceAction=<nonce>`,
and the Portal opens that action on Home. A Portal chat shows it as a card.

### Agents and their configuration

The Agents page (`/portal/<org>/<workspace>/agents`, `pages/agent-console.tsx`) lists
the agents and their recent work. An agent detail has Overview, Instructions, Skills,
Tools and access, Triggers, **Run now** and Limits. `?view=schedules` shows the runs of
each scheduled agent. Workspace settings holds **Operational areas**, and Knowledge
shows the skills as "Playbooks".

| Record                        | Meaning                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Operational area              | A responsibility, for example merchant operations. `active` or `archived`                        |
| Responsibility scope          | What an area covers: an entity type, a relationship, a list, a list entry or a saved selector    |
| Agent definition and revision | Role, purpose, instructions, requested capabilities, skill references, a SHA-256 digest          |
| Skill and revision            | A Markdown body, `ordinary` or `sensitive`. A binding attaches a skill revision to an area       |
| Installation                  | One exact definition revision with its granted capabilities. `active`, `suspended` or `archived` |
| Area assignment               | One installation in one area, with a responsibility and scopes                                   |
| Cue binding                   | The installation and instructions for one cue source and event type                              |
| Schedule binding              | An `hourly` window at a minute, or a `daily` or `weekly` window at a time in a time zone         |
| Governance                    | A token cap for each session of the installation                                                 |
| Escalation policy             | A reminder delay and an escalation delay to `organisation_owner`                                 |
| Configuration proposal        | New instructions or skill Markdown from an installation, `open`, `accepted` or `dismissed`       |
| Case assignment pin           | The exact definition revision, policy revision, skills, grants and token cap of one assignment   |

- A revision is never changed. Publish needs the current revision as
  `expectedRevision` and adds the next one. Publish does not change what an
  installation runs. Only `activate_agent_definition_revision` moves it.
- An installation may hold only capabilities that its definition revision requests.
  Publish accepts any requested capabilities. Activation refuses a revision that
  requests a capability that the installation does not hold (`agent_operation_invalid`,
  field `grantedCapabilities`).
- At cue admission, `resolveCueAutomation` (`data/agent-operations/automation.ts`)
  finds the enabled binding and its active installation. A commerce
  `entity_plane_changed` cue matches a binding only when the event matches one of its
  published scopes. Each new assignment gets one pin. A pin takes the skills of the
  definition and the skills bound to its areas. Later turns keep the pinned profile.
  With no matched binding, the cue opens an unpinned Case (FND-03).
- A scheduled run and a manual run also write a pin. A manual run pins only the
  skills of the definition.
- The token cap of an installation can only lower the workspace AI budget (FND-06).
  With no cap, the workspace budget applies.

An agent proposes a setup change with `configuration_propose`. It stages an
`operator_configuration_draft`, not a configuration proposal record. The draft can
carry each of the 18 agent operation commands, a price allowance, a device command, a
workflow change, a Jev switch or a stock level. Only the person who asked confirms it,
in the chat or in Slack. In a Portal chat, each change except a device command needs
an admin. In Slack, each change needs an admin. An agent operation command runs
through the runner of the Portal route (`data/agent-operation-runner.ts`). Each other
change has its own applier (`data/operator-configuration-draft.ts`).

### Sous Chef, the merchant agent

`POST …/agents/urk` (admin) installs Sous Chef (`data/merchant-agent-preset.ts`) with
ordinary commands: the area "Merchant operations", one definition, one installation
and the skills `performance_insights`, `catalog_listings`, `inventory_operations`,
`pricing_and_promotions` and `marketing_campaigns`. A second call completes a half-made
install. The role is `merchant_operator`, and the only grant is
`commerce.entity_plane.context`. The ids keep the old name, for example
`installation_urk_<suffix>`.

**The order attention brief.** A person asks Sous Chef which orders need attention. The
instructions (`data/merchant-agent-skills.ts`) tell Sous Chef to:

- Find candidates with `payment_failures` and `fulfillment_exceptions`. Read
  `lifecycle`, `order_id` and `expected_by`, and join each payment to its order.
- Raise a failed payment only when the order still needs payment, after a check of
  later payments and cancellations. Group repeated failures of one order. List an
  unlinked payment apart. Never call a failure lost revenue.
- Call an order overdue only when `expected_by` has passed in UTC and the work is not
  complete. A delivery exception needs attention with no deadline.
- Put the most urgent item first, with the order reference, the reason, the time, the
  freshness and the next manual step. Give a record link when one is available, else the
  record reference. Never invent a URL.
- Read again at each request, so a resolved problem goes. The brief is advice only.

**Reports.** `commerce_merchant_report` (COM-03) runs a report that
`commerce/entity-plane/merchant-reports.ts` defines. `merchant-report-runner.ts` runs
the graph reports: `open_orders` selects orders that are not `fulfilled` or
`cancelled`, `payment_failures` selects payments in `failed`, and
`fulfillment_exceptions` shipments in `delivery_exception`. A graph report gives a
count and at most 25 records, in no order. `low_stock_exposure`
(`stock-shortage-report.ts`) reads the commerce stock snapshot and gives the count and
at most 25 items that are `low` or `out`. A report with records says when the list is
cut. `product_sales` (`product-sales-report.ts`) gives a sales report for 7 days, with
no count and no record list. `low_stock_exposure` and `product_sales` are `unavailable`
unless the commerce system is Purin Checkout (`builtin_commerce`). If the count and the
records come from different merchant revisions, the answer is `unavailable` with
`consistent_merchant_snapshot`. Then Sous Chef reads again within its budget, or says
that no consistent answer is available. A source with no freshness gives the freshness
`unavailable`.

### Purchasing

The Purchasing page (`/portal/<org>/<workspace>/suppliers`, title "Suppliers", Kitchen
group) shows the suppliers, their items and the Replenishment Queue board. The engine
keeps entity-plane lists in the preset `purchasing`. A supplier is a `trade_partner`
with a `supplier_directory` entry: contacts, lead time, minimum order and notes.
`supplier_inventory_item` links it to each item that it supplies. `supply_cost_terms`
holds its pack prices (KIT-04).

1. An admin activates Purchasing. An operator adds a supplier, or an agent uses
   `supplier_create`. A supplier email becomes an operational contact, so Sous Chef
   can draft an email to it that a person approves (`email_operational_propose`).
2. A reconcile runs after activation, after a new supplier, on **Recheck stock** and
   after a delivery that changes stock. It opens an entry in `replenishment_queue` when
   an active `threshold` policy is below its reorder point and exactly one active
   supplier supplies the item. One policy has at most one open entry.
3. The entry starts in `needs_review`, with the available, reorder, target and required
   quantities. An operator records the owner, the expected delivery and notes, and the
   Portal makes the request id `pr-<entryId>`. The entry is `requested`, or `expected`
   with a date. An agent proposes the same change with the kind
   `update_purchase_request` of `commerce_propose_stock_action`.
4. A stock receipt names the entry and its revision (`commerce.receive-inventory.v3`).
   The next reconcile sums the linked receipts and sets `partial`, `received` or `late`.
   A person's board move can also set one of these states, if the expected delivery
   and the receipts allow it.

`PURCHASE_REQUEST_MACHINE` (`packages/commerce-contracts/src/commerce-machines.ts`):

| Event          | From                                    | To                                            |
| -------------- | --------------------------------------- | --------------------------------------------- |
| `request`      | `needs_review`                          | `requested`                                   |
| `expect`       | `needs_review`, `requested`, `late`     | `expected`, if the date has not passed        |
| `run_late`     | `needs_review`, `requested`, `expected` | `late`, if the date passed with no receipt    |
| `receive_part` | Each state except `received`            | `partial`, if receipts are below the quantity |
| `receive`      | Each state except `received`            | `received`, if receipts cover the quantity    |

`received` is the end. The board hides it. A receipt for an entry that receipts already
cover is refused (`resource_relationship_invalid`).

### The export catalog

`POST /v1/admin/merchants/:merchantId/channel-listings`
(`commerce.place-channel-listing.v1`, scope `catalog:write`) puts a new product, a new
variant or an existing variant on a sales channel, with one new offer. A new variant
needs a direct consumption plan that commits on `fulfillment_completed`. On a shipping
channel, the plan needs a `packaging` item, and the variant needs a `physical` shipping
specification for the active profile. One variant has one offer on each channel, so it
can be on the café and export channels at the same time.

`services/commerce/scripts/configure-plan23-flavored-catalog.ts` places four boxes on
`channel_cookie_store_sg`, beside the assorted box. `seed-local-commerce.ts` runs it:

| Box                                   | Price     | Weight  | Customs description                        |
| ------------------------------------- | --------- | ------- | ------------------------------------------ |
| Black sesame (`variant_sesame_box_6`) | JPY 3,600 | 1,250 g | Six black sesame cookies in one retail box |
| Ginger (`variant_ginger_box_6`)       | JPY 3,600 | 1,220 g | Six ginger cookies in one retail box       |
| Taro (`variant_taro_box_6`)           | JPY 3,800 | 1,240 g | Six taro cookies in one retail box         |
| Matcha (`variant_matcha_box_6`)       | JPY 4,200 | 1,210 g | Six matcha cookies in one retail box       |

Each box is 280 × 220 × 100 mm, origin JP, HS code `190531`, on
`shipping_profile_jp_sg`. Its plan uses one box and one `inventory_shipping_carton` at
`location_tokyo_fulfillment`. Its item is lot-tracked with an expiry, with 10 boxes of
opening stock. The script does nothing when the catalog is complete.

The shipping storefront (`/store/shipping`, `apps/storefront/src/storefront.tsx`) shows
one card for each listing. A sold-out box shows "Sold out", and its quantity cannot go
above 0. Each box also needs one `inventory_shipping_carton` in stock
(`checkout-planning.ts`). So the other boxes stay on sale only while cartons remain.
The checkout takes more than one line (COM-04).

### Campaign briefs

`commerce_propose_campaign_brief` stages a marketing brief for a Case. An admin accepts
or dismisses it. An accepted brief sends nothing and changes nothing.

## Contracts

- **OrganisationActor SQLite:** `action_ledger` (`actors/action-ledger.ts`, FND-06).
  **Case SQLite** (`actors/case-schema.ts`): `case_commerce_proposal` and
  `case_commerce_approval`.
- **Regional D1** (`services/platform/migrations-regional/0001_current_schema.sql`):
  `operational_area`, `agent_responsibility_scope`, `agent_definition`,
  `agent_definition_revision`, `agent_installation`, `agent_area_assignment`, `skill`,
  `skill_revision`, `skill_binding`, `cue_binding`, `schedule_binding`,
  `schedule_dispatch_receipt`, `agent_installation_governance`, `escalation_policy`,
  `agent_configuration_proposal`, `case_assignment_pin`, `operator_configuration_draft`
  and `campaign_brief`.
- **Engine** (`services/commerce/src/plugins/purchasing/`): the preset, the
  reconcile and the receipt check. The routes `…/entity-plane/purchasing-preset` and
  `…/purchasing-reconcile` need `entity_plane:write`. The public ids are in
  `packages/commerce-contracts/src/entity-plane-purchasing.ts`.
- **Main files** in `services/platform/src/`: `action-model.ts`, `actions.ts`,
  `provider-execution.ts`, `case-*.ts`, `operations-workbench.ts` and `purchasing/`
  in `commerce/`; `data/agent-operations/`; `slack/commerce-approval.ts`. The Portal
  shapes are in `@purin-labs/commerce-control-api` (`portal/commerce-actions.ts`).

The control routes are under `/v1/control/organisations/:id/`. An "admin" route also
admits an owner.

| Route                                                                       | Role          | Purpose                                                                     |
| --------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| `GET commerce/actions/:nonce`                                               | Viewer        | Read one action                                                             |
| `POST commerce/actions`                                                     | Admin         | Propose a Portal kind or a payout                                           |
| `POST commerce/actions/:nonce/approval`, `/rejection`, `/execute`           | Admin         | Decide and run (FND-06)                                                     |
| `GET commerce/actions/:nonce/plugin-preview`                                | Admin         | Preview a plugin while it waits                                             |
| `POST commerce/operations/tracking-batches/preview`                         | Viewer        | Freeze a tracking batch                                                     |
| `GET operations`                                                            | Viewer        | The configuration, the active Cases, the ledger and the commerce exceptions |
| `POST operations`                                                           | Admin         | One of 18 agent operation commands                                          |
| `GET operations/(definitions\|skills)/:id/revisions`                        | Viewer        | At most 50 revisions, newest first                                          |
| `POST agents/urk`                                                           | Admin         | Install Sous Chef                                                           |
| `GET campaign-briefs?caseId=`, `POST campaign-briefs/:id/(accept\|dismiss)` | Viewer, admin | Read or decide briefs                                                       |
| `POST commerce/purchasing/activate`                                         | Admin         | Publish the purchasing preset                                               |
| `POST commerce/purchasing/reconcile`, `POST commerce/suppliers`             | Operator      | Recheck stock, add a supplier                                               |
| `POST commerce/list-entries/:id/patch`                                      | Operator      | Change a purchase request (COM-03)                                          |

A mutation route needs an `Idempotency-Key`. A replay gives the stored answer, and the
same key with another body gives 409 `idempotency_key_conflict`. The campaign brief
decision is the exception: it takes `expectedRevision` in the body, and a stale
revision gives 409 `campaign_brief_conflict`. The 18 agent operation commands are in
`packages/control-api/src/agent-operation-commands.ts`.

The proposal tools are in `services/platform/src/agent-tools/commerce/proposals.ts`,
except `menu_board_propose_price` (`agent-tools/drafts/`). `commerce_merchant_report` is
in `agent-tools/commerce/reports.ts`. `supplier_read` and `supplier_create` are in
`agent-tools/kitchen/suppliers.ts`. Each proposal tool needs `commerce.action.propose`
and has the effect `proposal`. `supplier_create` needs `commerce.supplier.create`.

## Rules and limits

| Action                                                   | Viewer | Operator | Admin and owner | Agent                                         |
| -------------------------------------------------------- | ------ | -------- | --------------- | --------------------------------------------- |
| See approvals, activity and the configuration            | Yes    | Yes      | Yes             | No tool                                       |
| Propose a commerce change                                | No     | No       | Yes             | Proposal tools                                |
| Approve, reject or run a change                          | No     | No       | Yes             | No                                            |
| Change agents, skills, triggers and limits               | No     | No       | Yes             | `configuration_propose`                       |
| Install Sous Chef, accept a campaign brief               | No     | No       | Yes             | Proposes a brief                              |
| Activate Purchasing                                      | No     | No       | Yes             | No                                            |
| Add a supplier, recheck stock, change a purchase request | No     | Yes      | Yes             | `supplier_create`; a proposal for the request |

| Limit                               | Value                                       | Constant                                                                            |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Action expiry                       | 15 minutes                                  | No constant: `15 * 60_000` in each proposer                                         |
| Step-up sign-in, Slack approval     | 10 minutes, 60 s                            | `APPROVAL_STEP_UP_MAX_AGE_MS`, `SLACK_APPROVAL_WINDOW_MS`                           |
| Execution lease                     | 5 minutes                                   | `ACTION_EXECUTION_LEASE_DURATION_MS`                                                |
| Case wait check                     | 1 minute for 10 minutes, then 15 minutes    | `APPROVAL_READ_FIRST_MS`, `APPROVAL_READ_FIRST_WINDOW_MS`, `APPROVAL_READ_LATER_MS` |
| Ledger entries that Home reads      | 50                                          | A literal in `control/agent-operation-activity.ts`                                  |
| Configuration draft, campaign brief | 1 hour                                      | `OPERATOR_DRAFT_TTL_MS`                                                             |
| Report records                      | 25                                          | `POPULATION_LIMIT`                                                                  |
| Revision list                       | 50                                          | `REVISION_HISTORY_LIMIT`                                                            |
| Commerce exceptions                 | 500 records, 100 a page; 1 to 50 in a batch | `INBOX_RESULT_LIMIT`, `INBOX_PAGE_LIMIT`; a literal                                 |
| Recent activity                     | 8                                           | A literal in `automation.tsx`                                                       |
| Mutation receipt of a control route | 24 hours                                    | `MUTATION_RECEIPT_TTL_MS` (FND-06)                                                  |

**Retention.** No timer deletes a record of this spec. An `expired` or `rejected` ledger
entry, an `expired` draft or brief and each revision stay. The Organisation purge
erases the D1 rows (`data/purge-catalogue.ts`, action `erase`).

- **No authority from an agent.** An agent proposes. It never approves, rejects or
  runs a change. An approval needs the session or the verified Slack link of a person.
  No agent tool in `agent-tools/` reads the action ledger (`getAction`,
  `readActionActivity`) or the agent records of this spec. A turn gets only the
  pinned profile of its Case assignment.
- **One record at a time.** A run starts only if no other entry on the same account
  and record is `signed`, `executing` or `indeterminate`. Otherwise the run gives 409
  `resource_busy` (FND-06), and the entry stays `signed` until it expires. Nothing
  waits in a queue.
- **The run grant.** The run checks the grant of `commerce.action.propose` for the
  account and the record (`commerceActionCapability`), and the capability activation
  of the system (COM-01).
- **Information flow.** The ledger keeps the flow binding of each action. The outcome
  passes the destination check before the Connector posts it (FND-07). A report record
  name passes `normalizeUntrustedCommerceText`.
- **Agent setup stays proposal-only.** An agent cannot publish its own instructions,
  grants, budget or approval rules. A configuration proposal may target only the
  instructions of its own definition, or a skill bound to one of its areas
  (`configuration_proposal_target_forbidden`).
- **Purchasing is a record of work.** It changes no stock. Stock changes only through
  the receipt commands of the engine (COM-02).
- **Out of scope:** automatic purchase orders, supplier scoring, invoice matching,
  scheduled briefs, and payment collection or customer messages by an agent.

Neighbours:

- **FND-06** owns the ledger states, the step-up sign-in, the Slack card rules and the
  pending decisions. **FND-03** owns Cases and the dispatch of cues and schedules.
  **FND-09** owns the tool catalog and the chat cards. **FND-10** owns the description
  draft. **FND-02** and **FND-04** own the Actor-owned history and its erasure.
- **COM-01** owns the action kinds and the capability activation. **COM-02** owns the
  engine, its plugins and its state machines. **COM-03** owns the read copy, the report
  and stock tools and the lab. **COM-04** owns payments, refunds and the cancel
  threshold. **CAFE-01** owns menus and the order queue. **KIT-04** owns supply costs.
- **INT-01** owns the integrations page. **BRN-01** owns the Activity view and Knowledge.
  [Plan 24](../../../plan-24-cafeos-bakery-automation.md) owns the cobot bake path.

## Open work

- Only a test calls `submitAgentConfigurationProposal`: the agent tool makes a draft.
- No code acts on an escalation policy. It sends no reminder and no escalation.
- No command archives an area, a definition or an installation, changes the grants of
  an installation or adds a second area. A skill binds only to an area.
- The Portal does not call `agents/urk` or the campaign brief routes.
- `cancel_order` records `refundGovernance`, but no code acts on it.
- Of the step-up policies, only the Google step-up makes approval evidence. A
  `webauthn_step_up` or `seams_nep413` policy is always reported as not ready.
- The commerce query routes `commerce/summary`, `products` and `orders` are not built.
- Only the mock-shop journey `order-attention` covers the brief. No journey runs it on
  a real shop.
- A purchase request never goes from `partial` to `late`.
- No `package.json` script runs the flavored catalog script.

## Sources

- [Plan 16](../../../history/plan-16-merchant-console-commerce-operations.md),
  [Plan 23](../../../history/plan-23-flavored-export-catalog.md),
  [Plan 31B](../../../history/plan-31B-supplier-and-purchasing-operations.md) and
  [Plan 39](../../../history/plan-39-urk-merchant-agent-parity.md). Where they differ from the
  code, this spec follows the code. Their evidence in the archive:
  - Plan 16:
    [integrations browser](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-16-mc1-integrations-browser-acceptance-2026-08-18.md),
    [read-only browser](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-16-browser-readonly-2026-08-09.md),
    [local loop](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-9-16-local-commerce-loop-2026-08-04.md),
    [fixture manifest](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-9-16-ck0r-fixture-manifest-2026-08-08.json),
    [history and CK4](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-14-nf9-mc0-ck4-local-2026-08-06.md),
    [Shopify production](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-9-ck4-shopify-production-acceptance-2026-08-08.md).
  - Plan 23:
    [lab](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-23-flavored-catalog-acceptance-2026-08-17.md),
    [production](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-23-production-acceptance-2026-08-17.md).
  - Plan 39:
    [selective integration](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-selective-integration-2026-09-27.md),
    [baseline](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-cafeos-baseline-2026-09-08.md),
    [start](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-start-2026-09-30.md),
    [production release](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-production-release-2026-09-30.md),
    [runtime follow-up](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-runtime-followup-2026-10-01.md),
    [latency](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-latency-fixes-2026-10-01.md),
    [follow-up preparation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-followup-preparation-2026-10-01.md),
    [overlapped start](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-overlap-initialization-2026-10-01.md),
    [mock shop](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-39-mock-shop-2026-10-01.md).
- E2E journeys in `services/platform/tests/e2e/` (`.test.ts`):
  - Actions: `slack-commerce-approval`, `pi-commerce-actions`, `portal-order-cancel`,
    `slack-offer-price-change`, `pi-cafe-menu-publication`, `pi-merchant-plugin`,
    `pi-commerce-description`, `commerce-propose-permission`,
    `commerce-propose-switch-on`, `commerce-propose-unbound-channel`,
    `commerce-write-permission` and `action-mutation-origin`.
  - Agents: `proposal-staging-origin`, `slack-agent-activation-mid-thread` and
    `schedule-runs`.
  - Brief and reports: `order-attention`, `chat-agent-stock-report` and
    `chat-agent-order-read`.
  - Purchasing: `inventory-operations`, `pi-stock-actions` and
    `chat-agent-recipes-suppliers`.
- Engine tests in `services/commerce/tests/`: `purchasing-replenishment.test.ts`,
  `commerce-authority.test.ts` (the flavored placement and quotes),
  `punter-acceptance.test.ts`, and the fixture
  `fixture-worker/journeys/order-attention-fixture.ts`.
- Scripts: `pnpm plan9:16:local`, `pnpm frontend:journeys` (the `/store/shipping`
  journeys) and Punter `scenario:shipping` with `PUNTER_SHIPPING_SCENARIO=matcha_export`.
