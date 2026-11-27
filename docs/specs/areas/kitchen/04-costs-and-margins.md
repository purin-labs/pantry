# KIT-04 — Costs and margins

The Costs & margins page of Purin Pantry is one shared workbook of an Organisation, in the
Kitchen navigation group. It prices the supplier packs of each stock item and plans the
units of each product for each weekday. It enters the fixed daily labor and rent, and it
shows the net margin of each product after waste, channel fees and included consumption
tax. It also shows the operating profit and the break-even volume, a comparison of the
plan with the shop's real orders, and a 12-week profit and cash forecast. Each person
with the page open sees the same draft cells and the cursors of the others. **Save
changes** writes the draft to the commerce engine and to the regional D1 database. Sous
Chef agents read the same model, edit the same draft and save through the same stores,
with the person's role checks and receipts. One deterministic engine in
`@purin-labs/kitchen-control-api` computes every number for the page and for the agent.

## What it does

### The workbook

- The Portal page is `costs` (`foundation/ui/route.ts`), with the title "Costs &
  margins". Its tabs are **Menu**, **Supplies**, **Actuals** and **12w Cash**. The Menu
  tab has two views: **Margins** (one day) and **7d** (Monday to Sunday). The workbook
  tab values are `margins`, `weekly`, `actuals`, `forecast` and `supplies`
  (`CostsSheetTab`).
- **Margins** has one row for each product. The columns are `Units / d`, `Spoil`,
  `Price`, `COGS`, `Waste`, `Tax & fee`, `Unit net`, `Margin` and `Net / day`. A person
  types a number to set a value, or a formula that starts with `=` (see "Formulas").
- **7d** has one cell for each product and weekday. These cells drive the 7-day batch
  runs and the bulk tier unlocks.
- **Supplies** has one row for each stock item that is not a finished good: pack
  quantity, pack unit, pack price, the 7-day bulk tier, the lot cost, the stock coverage
  and the count of products that use the item.
- A strip above the grid shows the daily revenue, COGS and fees, the contribution, the
  fixed overhead (labor and rent), the operating profit and the break-even units for
  each day.
- An assumptions popover sets the shelf spoilage, the prep reject loss, the channel fee,
  the included tax, the bulk tiers on or off, and the lot cost basis.
- A scenario preset writes draft cells for all weekday units: `weekend` multiplies the
  saved units by 1.5, and `rainy` by 0.7 (`changesForMultiplierPreset`).
- The product drawer (`CostsBomDrawer`) shows the recipe bill of materials (BOM) of one
  product. It shows each line from the supplier pack to the unit cost, with a link to
  Kitchen › Recipes. The BOM lines are read-only on this page.
- The lots drawer (`CostsLotsDrawer`, a `SideDrawer`) shows the lots of one stock item,
  their invoice costs, the on-hand coverage, the lot variance and the price
  sensitivity. Its product rows open the Margins tab with that product.
- **Reset** clears all draft cells. **Undo** (`Ctrl+Z` or `Cmd+Z`) and **Redo**
  (`Ctrl+Shift+Z`, `Cmd+Shift+Z`, or `Ctrl+Y`) step back and forward through this
  person's own unsaved draft edits, including **Reset**. Keystroke edits within one
  focused cell coalesce into one step; pressing undo while typing an uncommitted
  formula or back-solve cancels that text before undoing earlier committed steps.
  **Save changes** shows only to a person who can edit. If a person who is not an
  owner or an admin changes a price, the page marks the price as what-if and does not
  save it.

### The cost model

`calculateBakeryCostsAndMargins` (`packages/kitchen-control-api/src/costs.ts`) computes
the model from the commerce snapshot, the saved plan and the draft cells.

- **Units.** The engine converts `gram` and `kilogram`, and `milliliter` and `liter`.
  `each` converts only to `each`. Other pairs are incompatible, and a save with an
  incompatible unit is refused.
- **Demand.** Each product has seven weekday units. With no saved plan, the engine
  spreads a default daily figure over the week with the weights `0.75, 0.8, 0.85, 0.95,
1.1, 1.35, 1.2` (Monday to Sunday).
- **Stocked bakes.** A `stocked` recipe bakes whole batches. The raw need is the demand
  divided by the shelf factor and by the reject factor. Each day with demand bakes at
  least one batch: `ceil(raw / batchYield)`.
- **Prepared drinks.** An `immediate` recipe makes one serving for each order. It adds
  only the prep reject loss and has no shelf spoilage.
- **Bulk tiers.** When the 7-day usage of an item in its pack unit reaches
  `min7dQuantity`, the bulk pack price applies. The engine reports the daily saving.
- **Tax and fees.** The included tax of a price is `round(price × taxBps / (10000 +
taxBps))`. The channel fee is `price × channelFeeBps / 10000`. The unit net is the
  price less COGS, waste, tax and fee.
- **Fixed costs.** The daily fixed cost is labor plus rent. The break-even volume is
  `ceil(fixed / (daily contribution / daily units))`. It is `null` when the
  contribution is not positive, and 0 when the fixed cost is 0. A month has 26
  operating days (`operatingDaysPerMonth`).
- **Back-solve.** A target margin gives a price (`backSolveGrossPriceMinorForMargin`). A
  target unit net gives a price (`backSolveGrossPriceMinorForUnitNet`). A target net
  for each day gives the daily units (`backSolveDailyUnitsForNetDay`).
- **Stock coverage.** `daysOfSupply` is the on-hand quantity divided by the daily usage.
  `reorderSuggested` is true below 4 days. `tenPctHikeWeeklyImpactMinor` is the weekly
  cost of a 10% price rise. `skuImpacts` lists each product that uses the item.

The default assumptions come from `defaultCostAssumptions`:

| Assumption       | Default                                                  | Range in the engine                    |
| ---------------- | -------------------------------------------------------- | -------------------------------------- |
| Shelf spoilage   | The measured 30-day shelf waste, capped at 45%, else 7%  | 0 to 95%                               |
| Prep reject loss | The measured 30-day batch reject, capped at 30%, else 2% | 0 to 95%                               |
| Channel fee      | 320 bps                                                  | 0 to 5,000 bps                         |
| Included tax     | `defaultIncludedTaxBps` of the overview                  | 0 to 10,000 bps                        |
| Bulk tiers       | On                                                       | —                                      |
| Lot cost basis   | `standing`                                               | `standing`, `fifo_lot`, `weighted_lot` |

`detectIncludedTax` (`commerce/cost-commands.ts`) sets `defaultIncludedTaxBps` and
`includedTaxSource`. It takes the first tax-included order, rounded to 50 bps
(`orders`), then the active checkout profile (`checkout_profile`), then 800 bps for
`JPY` (`jpy_food_default`). Otherwise it gives 0 (`none`).

`COST_SCENARIO_LIMITS` (`costs-formulas.ts`) holds these ranges. The draft cells,
`costs_read` and `costs_sheet_edit` accept the same ranges, so a value that a person or
the agent enters is the value that the margins use.

The measured waste uses the last 30 days (`WINDOW_DAYS`). It reads the `waste` and
`damage` movements, the expired finished-good lots, and the planned and actual yield of
the production batches.

### Lot costs from purchase invoices

- A person records the invoice of one received lot: the invoiced quantity and unit, the
  total, the supplier's invoice reference and an optional supplier. The row goes to
  `bakery_lot_invoice_cost`.
- `lotCostLineProblem` (`kitchen-control-api`) holds the limits of that row
  (`LOT_INVOICE_LIMITS`): a reference of 1 to 120 characters, a supplier id of at most
  128 and a lot or item id of at most 160. The save route and the sheet save refuse
  another value with a reason, `lot_cost_save` refuses it as an argument the agent can
  correct, and the lots drawer asks for the reference before it saves.
- A lot save refuses an unknown lot, a lot of another item and a lot of a finished good
  with `lot_cost_invalid`. It refuses an invoiced unit that does not convert to the
  base unit of the item with `lot_cost_unit_mismatch`.
- If a lot has no such row, and its receipt movement names a `replenishment` purchase,
  the read takes the cost from the matching `supplier_payable` row that is not `void`
  (`source: "supplier_payable"`).
- `fifo_lot` takes the active priced lots in the order of receipt and covers the 7-day
  usage. A part that no lot covers uses the standing or bulk rate. `weighted_lot`
  averages the active priced lots by remaining quantity.
- The cost source of each item is `standing_pack`, `bulk_tier`, `fifo_lot`,
  `weighted_lot` or `unpriced`.

### Plan versus actuals

- `readCostsOverview` gives `actuals` for 7 and 30 days, with no extra table. It counts
  the orders that are not `cancelled` in the main currency, split into point-of-sale and
  online. It reads gross sales, the included tax, completed refunds, credits and price
  adjustments, and the units of each product. It also reads the production batches, the
  finished-good waste, the supply losses and the supplier payable totals.
- `calculateBakeryPlanVsActuals` (`costs-actuals.ts`) compares the plan with these
  actuals. With orders, the mode is `orders_and_costs`; with none, it is
  `costs_and_waste_only`. It ranks the drivers of the margin gap: `lot_invoice`,
  `product_waste`, `supply_loss` and `volume_mix`.
- The Actuals tab has a 7-day and 30-day `Select`. Each driver chip opens the supply
  lots or selects the product row.

### The 12-week forecast

`calculateBakery12WeekForecast` (`costs-forecast.ts`) runs 12 weeks
(`FORECAST_HORIZON_WEEKS`).

- Each week scales the weekday demand by its demand percentage and runs the cost model
  in `weekly` mode, so a busy week can unlock a bulk tier.
- The demand curves are `steady`, `seasonal_holiday`, `growth_ramp`, `winter_dip` and
  `custom` (`PRESET_FORECAST_DEMAND_CURVES`). A week is 10% to 500%.
- If the demand of a week is at or above `extraShiftThresholdPct` (101 to 400), that
  week adds `extraShiftWeeklyMinor` of labor.
- Rent of 28 days goes out in weeks 3, 7 and 11. `cod` pays supplies in the same week
  and the open supplier payables in week 1.
- `net_15` pays the purchases of a week two weeks later. For the purchases before the
  horizon, weeks 1 and 2 each pay one baseline week of supplies. Week 2 also pays the
  open supplier payables.
- `net_30` pays the purchases in weeks 3, 7 and 11. Week 3 also pays two baseline weeks
  of supplies and the open supplier payables.
- `capexMinor` goes out in week 1. The result gives the lowest cash, its week and reason,
  and `capexPaybackWeeks`.
- The default plan (`defaultCostForecastPlan`) is `seasonal_holiday` and `net_30`, with
  a 125% shift threshold and no capex. Opening cash is 6,400,000 and the shift is
  116,000 in a zero-decimal currency such as `JPY`; else 4,500,000 and 80,000.

### Formulas

`costs-formulas.ts` evaluates a cell that starts with `=`. A formula can name the row
values (`UNITS`, `PRICE`, `BOM`, `INGR`, `PACK`, `COGS`, `WASTE`, `TAX`, `FEE`,
`UNIT_NET`, `MARGIN`, `NET_DAY`, `BATCHES`, `YIELD` and others) and a cell such as `D4`,
with a column letter from `B` to `J`. The saved model and `costs_read` read a cell of any
row as the same column of the current row. Only the formula bar preview in the Portal
reads the named row. The functions are `ROUND`, `CEIL`, `FLOOR`, `MIN`, `MAX`, `SUM`,
`AVG`, `ABS` and `IF`. An error is `syntax_error`, `division_by_zero` or `unknown_ref`.
The columns that take a formula are `COST_FORMULA_COLUMNS`: `units`, `spoil`, `price`,
`cogs`, `waste`, `unitNet`, `margin` and `netDay`.

### Multiplayer

- The draft is one Yjs document for each Organisation. Each cell is a sparse string
  override over the saved baseline, in the `cells` map of the document. Edits to two
  cells merge. For one cell, a later edit replaces the earlier one. For two edits to one
  cell at the same time, the Yjs map keeps one value, the same on each replica.
- `CostsSheetClient` (`costs-sheet-client.ts`) opens the socket. It sends the pointer
  and the selected `{ sheet, cellKey }` of the person. It sends the selection only when
  the socket has `edit` access, and the room shows a reader as viewing. It also keeps
  at most 100 local undo and redo steps (`HISTORY_LIMIT`) as inverse cell updates, so
  undo reverses only this person's own draft edits and syncs the reversal to the room.
  A saved baseline (`meta:savedAt` change or completed **Save changes**) or a room
  generation replacement clears both stacks.
- `costs-sheet-presence.tsx` shows the pointer and name of each other person, a colored
  border on the cell that each person selected, dots on the tabs and the collaborator
  chips. A pointer hides after 5 s with no move (`COLLABORATION_POINTER_IDLE_MS`).
- A save removes the cells that it committed. It keeps the other draft cells, such as a
  scenario cell, and stamps `meta:savedAt`. Each open tab then reads the saved baseline
  again. A save whose price writes all saved also removes every draft price cell.
- A refused **Save changes** can name the prices and supplier packs that saved before
  the refusal (`saved` in the answer). The page then reads the saved baseline again and
  says what saved. The other changes stay in the draft, so the next save sends only
  them.
- An agent save settles its own cells as a best effort. It skips the settlement when
  the person is no longer a live member, and it never removes the draft price cells.

### Agents

The tools are in `areas/kitchen/server/agent-tools/kitchen/costs.ts` and
`areas/kitchen/server/agent-tools/costs/view.ts`.

| Tool                                                                             | Capability or selection         | Effect  | What it does                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `costs_read`                                                                     | `commerce.entity_plane.context` | Read    | The model, as the page shows it, with optional what-if values. It changes nothing            |
| `supply_cost_save`                                                               | `commerce.supply_cost.save`     | Receipt | Saves the pack price, unit and bulk tier of one stock item                                   |
| `lot_cost_save`                                                                  | `commerce.supply_cost.save`     | Receipt | Saves the invoice cost of one lot                                                            |
| `costs_plan_save`                                                                | `commerce.supply_cost.save`     | Receipt | Saves labor, rent, the weekday units, the spoilage and the forecast plan                     |
| `costs_sheet_edit`                                                               | `commerce.supply_cost.save`     | Draft   | Edits at most 100 draft cells, with the agent's cursor on the first cell                     |
| `costs_view_open_tab`, `costs_view_filter_category`, `costs_view_select_product` | The `costs` page surface        | Surface | Open a tab, filter by category or select a product on the person's screen. They save nothing |

- `costs_read` gives `actuals` when the call passes `actualsWindowDays` (7 or 30). It
  gives `forecast` when the call passes `forecast`. One to 8 `dailyTargets` focus the
  products and add the BOM lines and the supply coverage. It also gives the non-empty
  draft cells and the lots of each item with a priced lot.
- No Costs tool changes a buyer-facing price. The agent proposes a price change with
  `menu_board_propose_price` or `commerce_propose_action` (`adjust_offer_price`).
- `CostsPageViewSource` (`costs-page-view.ts`) gives the page to the Portal chat agent:
  the tab, the filter, the expanded BOM rows, the reorder count, the coverage and the
  product reach.

## Contracts

- Regional D1 (`workers/platform/migrations-regional/0001_current_schema.sql`), owned
  by `areas/kitchen` in `scripts/layers.json`:
  - `bakery_cost_plan`: one row for each Organisation, with `revision`,
    `daily_labor_minor`, `daily_rent_minor` and `forecast_json`.
  - `bakery_cost_product_plan`: one row for each product, with `mon_units` to
    `sun_units`, `spoil_bps` (0 to 9,500), `cogs_override_minor`, `waste_override_minor`
    and `formulas_json`.
  - `bakery_lot_invoice_cost`: one row for each lot, with `revision`, `currency`,
    `invoiced_quantity`, `invoiced_unit`, `invoice_total_minor`, `invoice_reference`
    (1 to 120 characters, not null) and `supplier_id`.
  - The patch scripts for deployed databases are
    `workers/platform/scripts/plan-86-costs-plan-d1-patch.sql`,
    `plan-86-costs-formulas-d1-patch.sql` and `plan-86-lot-costs-d1-patch.sql`.
- The read uses `supplier_payable` (COM-05) and writes it never.
- The commerce engine keeps the pack prices in the `supply_cost_terms` list
  (`SUPPLY_COST_TERMS_LIST_ID`) of the purchasing preset
  (`services/commerce/src/plugins/purchasing/purchasing-preset.ts`). It is a
  `unique_entity` list over the system `inventory_item`.
- `OrganisationDO` keeps the draft in Actor SQLite table `costs_sheet_draft`
  (`areas/kitchen/server/actors/costs-sheet-draft.ts`). It has one row
  (`singleton_id = 'costs-sheet'`), schema `costs_sheet_crdt.v1`, and a state of at
  most 262,144 bytes. `CostsSheetRooms` holds the `CollaborationRoom` of route kind
  `costs_sheet` (FND-10). The RPC methods are `readCostsSheetDraft`,
  `editCostsSheetDraft` and `settleCostsSheetDraft`.
- `@purin-labs/costs-sheet-crdt` (`packages/costs-sheet-crdt`) defines the cell keys,
  the value checks and the sync protocol `costs_sheet_sync.v1`.
- `@purin-labs/kitchen-control-api` holds the TypeBox contracts and the engines:
  `costs.ts`, `costs-formulas.ts`, `costs-actuals.ts` and `costs-forecast.ts`.
- `areas/kitchen/server/cost-commands.ts` reads the overview and saves the
  pack prices. `cost-plan-store.ts` reads and writes the three D1 tables and the offer
  prices.
- The Portal code is in `areas/kitchen/ui/features/costs/`.

| Cell key                                                        | Value                                               |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `overhead:dailyLabor`, `overhead:dailyRent`                     | Minor units, 0 to 10,000,000,000                    |
| `scenario:preset`                                               | `saved`, `weekend`, `rainy`, `custom`               |
| `scenario:bakeShelfWastePct`, `scenario:prepRejectPct`          | 0 to 95                                             |
| `scenario:channelFeeBps`, `scenario:includedTaxBps`             | 0 to 5,000; 0 to 10,000                             |
| `scenario:applyBulkTiers`, `scenario:lotCostBasis`              | `true` or `false`; a lot cost basis                 |
| `product:<id>:daily`, `product:<id>:day:<0..6>`                 | Units, 0 to 100,000 (0 is Monday)                   |
| `product:<id>:spoil`                                            | `default` or 0 to 9,500 bps                         |
| `product:<id>:price`, `:cogs`, `:waste`                         | Minor units; `cogs` and `waste` also take `default` |
| `product:<id>:fx:<column>`                                      | `default` or a formula of at most 160 characters    |
| `supply:<itemId>:<field>`                                       | The six pack and bulk tier fields                   |
| `lot:<lotId>:invoiceReference`, `lot:<lotId>:invoiceTotalMajor` | Text of 1 to 120 characters; a decimal              |
| `forecast:<field>`, `forecast:week_idx:<0..11>`                 | The six forecast fields; 10 to 500%                 |
| `meta:savedAt`                                                  | The time of the last save                           |

The control routes are under `/v1/control/organisations/:id/commerce/costs`
(`control/routes/costs.ts`, `control/routes/costs-sheet.ts`,
`control/admission/costs-sheet.ts`):

| Route                           | Role                                       | Purpose                                                                            |
| ------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `GET`                           | Viewer                                     | The `CostsOverview`: recipes, items, products, measured waste, plan, lots, actuals |
| `POST`, `kind: "save_sheet"`    | Operator; owner or admin for `priceWrites` | Saves the price, supply, lot and plan writes of **Save changes**                   |
| `POST`, `kind: "save_lot_cost"` | Operator                                   | Saves the invoice cost of one lot                                                  |
| `POST`, no `kind`               | Operator                                   | Saves the pack terms of one stock item                                             |
| `GET /sheet`                    | Viewer                                     | The draft snapshot                                                                 |
| `GET /sheet/socket`             | Viewer; `edit` access from operator        | The WebSocket of the room, with an `Origin` check                                  |
| `POST /sheet/reset`             | Operator                                   | Clears all draft cells                                                             |

The three `POST` routes of `control/routes/costs.ts` pass `admitUserMutation`, so the
same `Idempotency-Key` replays the same receipt. Each route parses the body, admits the
mutation and calls one function of `areas/kitchen/server/costs-sheet-save.ts`:
`saveCostsSheet`, `saveLotCost` or `saveSupplyCost`. `POST /sheet/reset` takes no key:
it checks the operator role, and a repeat clears the draft again. A stale
`expectedPlanRevision`, `expectedOfferRevision`, `expectedEntryRevision` or
`expectedRevision` gives 409 `stale_resource_revision`. If a lot or plan save already
applied the same values, a repeat with the old expected revision gives the saved result
again. This is true for the save routes, `save_sheet` and the agent tools.

`save_sheet` replaces every product row of the plan. It refuses a product that is not
active with 422 `cost_plan_invalid`. `costs_plan_save` merges its products with the
saved rows.

## Rules and limits

| Action                                         | Viewer                | Operator          | Admin and owner | Agent                                                  |
| ---------------------------------------------- | --------------------- | ----------------- | --------------- | ------------------------------------------------------ |
| Read the model and the draft                   | Yes                   | Yes               | Yes             | `costs_read`, for a current member                     |
| Edit draft cells, reset the draft              | No (read-only socket) | Yes               | Yes             | `costs_sheet_edit`, if the person is not a viewer      |
| Save pack terms, lot costs, labor, rent, units | No                    | Yes               | Yes             | The save tools, if the person is an operator or higher |
| Save a buyer-facing price                      | No                    | No (what-if only) | Yes             | No; a proposal only                                    |
| Read actuals                                   | Yes                   | Yes               | Yes             | With the `order` read of the turn                      |

| Limit                    | Value                                    | Constant                                              |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------- |
| Draft cells              | 2,500                                    | `COSTS_SHEET_CELL_LIMIT`                              |
| Draft state, update      | 256 KiB                                  | `COSTS_SHEET_STATE_LIMIT`, `COSTS_SHEET_UPDATE_LIMIT` |
| State vector             | 16 KiB                                   | `COSTS_SHEET_STATE_VECTOR_LIMIT`                      |
| Open sockets in the room | 20                                       | `COLLABORATION_SOCKET_LIMIT`                          |
| Compaction               | Above 48 KiB of state or 4 KiB of vector | `COMPACT_STATE_BYTES`, `COMPACT_VECTOR_BYTES`         |
| Measured waste window    | 30 days                                  | `WINDOW_DAYS`                                         |
| Actuals windows          | 7 and 30 days                            | `actualsWindowDaysSchema`                             |
| Pack terms save attempts | 4, then `supply_cost_busy`               | `SAVE_ATTEMPT_LIMIT`                                  |
| Room mutation deadline   | 30 s                                     | In `CostsSheetRooms.reset` and `settleSaved`          |
| Reorder warning          | Below 4 days of supply                   | In `calculateBakeryCostsAndMargins`                   |

- **Checks before the first write.** `save_sheet` reads the commerce snapshot and the
  saved rows, and checks every refusal before it writes: the price role, an unknown
  offer, the stock item and unit of each pack terms line, the lot owner and unit, an
  inactive plan product, and the lot and plan revisions.
- **Save order.** Then `save_sheet` writes the offer prices and the pack terms to the
  commerce engine, one record at a time, and then the lots and the plan in one D1
  batch. The batch starts with a revision guard for each row, so a row that changed
  after the check fails the whole batch, and no lot or plan row of it applies. Pantry
  does not undo a saved price or pack terms write when a later step fails. The refusal
  names the saved records in `saved` (`offerIds`, `inventoryItemIds`), the save settles
  the draft cells of each saved record, and the route records no receipt. A failed
  batch gives 503 `cost_sheet_write_failed`. A retry with the same key runs every step
  again: the commerce engine answers each offer price and each pack terms write that it
  has from its key (`…:offer:<offerId>`, `…:supply:<n>`).
- **Settlement.** A failed settlement of the draft does not fail the save. The save
  writes `commerce.costs_sheet_settle_deferred` to `traceWarn`.
- **Idle cost.** The Actor writes no draft row until a person opens or resets the room,
  or an agent edits it. A settlement with no draft row and no open socket writes
  nothing. The draft compacts only when the room opens with no other socket.
- **Retention.** The draft cells stay until a save or a reset. The Organisation purge
  erases the three D1 tables (`areas/kitchen/server/data/purge-entries.ts`).
- **Information flow.** `costs_read` admits each Commerce read as a read observation of
  the turn. The save tools are staff page effects with a `tool_effect` sink, and
  `costs_sheet_edit` is a shared draft for every member. If the label of the turn does
  not let that audience read the result, or the turn read content from outside the
  Organisation, the exit holds the call and asks the person. Any other refusal stops the
  call (FND-07).
- **Out of scope:** labor and energy costs from the recipe workflows; a change to stock,
  to an order or to a payment. A save moves no stock and pays nothing.
- **COM-02** owns the `supply_cost_terms` list, the offers and their revision checks.
  **COM-05** owns suppliers, purchase requests and `supplier_payable`. **KIT-03** owns
  the recipe workflows. **FND-09** owns the agent tool catalog and the page surface
  protocol. **FND-10** owns the collaboration room.

## Open work

- Workflow labor and energy costs are not built. The plan wants station minutes and
  equipment `kWh` from the recipe workflows (KIT-03, KIT-02) in the unit cost, in
  `CostsBomDrawer` and in `costs_read`.
- The source plan records no signed-in check of the page in production after its
  releases.

## Sources

- [Plan 86](../../../history/plan-86-bakery-costs-and-margins.md). Where it differs from the
  code, this spec follows the code. The plan gives no evidence links in the archive.
- E2E journeys: `workers/platform/tests/e2e/costs-and-margins.test.ts`, with its
  helper `costs-sheet-room-support.ts` (step 9 fails the lot and plan batch after a
  price write and retries the rest), and
  `services/commerce/tests/purchasing-replenishment.test.ts` for the
  `supply_cost_terms` list.
