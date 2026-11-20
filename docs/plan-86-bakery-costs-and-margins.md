# Plan 86 — Satyr Kitchen Costs and Margins

Status: **Phases 1–8 and UI simplification complete and released** (2026-11-14; UI simplification and unified `CostsBomDrawer` 2026-11-19): spreadsheet, multiplayer, two-way solvers and `fx` formulas, lot costs from purchase invoices, the unified BOM cost drawer, plan vs. actuals, and the 12-week forecast. Only workflow labor and energy costs remain deferred (see Future features).

Release (2026-11-14): Phases 1–8 are in production. Phase 6 shipped in satyr-edge
`70693f99` (release commit `58aad4ef8`, ref `refs/backup/released-2026-11-14-plan-86-phase-6`).
Phases 7 and 8 shipped in satyr-edge `7e8454a3` (release commit `f40e5cc5f`, ref
`refs/backup/released-2026-11-14-plan-86-phases-7-8`). Before that upload, the column
`bakery_cost_plan.forecast_json` from `plan-86-costs-plan-d1-patch.sql` was added to the
production regional database, and the production schema check then passed. No signed-in
check of the Costs & margins page ran against the new version.

Release (2026-11-19): The UI simplification and unified `CostsBomDrawer` (`a72798d`)
shipped in production `satyr-edge` `f518b9a6` (deployed from `origin/dev` `b85200a`,
together with the Plan 91 `PANTRY_*` environment variable rename). Production D1 matched
the schema before upload, and `/healthz` and `/portal` returned HTTP 200 after the deploy.
No signed-in check of the Costs & margins page ran yet.

## Goal

Operators need one spreadsheet in Satyr Kitchen to price supplier packs, plan
weekday and weekend (`Mon–Sun`) production units, enter daily fixed labor and
rent overhead, back-solve prices from target margins, and verify operating
profit and break-even volume after waste, channel fees, and included
consumption tax.

## Scope (Phase 1)

1. **Underclerk supply cost terms (`supply_cost_terms`)**
   - Extend `PURCHASING_PRESET` in Underclerk's built-in purchasing plugin with
     `SUPPLY_COST_TERMS_LIST_ID = "supply_cost_terms"`, a unique-entity
     `CommerceList` over system `inventory_item`.
   - Each entry records `currency`, `pack_quantity`, `pack_unit`,
     `pack_price_minor`, optional `supplier_id`, and an optional 7-day volume
     tier (`bulk_min_7d_quantity`, `bulk_pack_quantity`, `bulk_pack_price_minor`).
   - Canonical `InventoryItem` stays unchanged. Updates inherit Underclerk's
     entity-plane revision fencing, idempotency, receipts, and projections.

2. **`shop.seams.tokyo` 24-item pâtisserie baseline**
   - Extend `configurePatisserieMenu` (`@underclerk/client` and
     `services/underclerk/scripts/configure-patisserie-menu.ts`) so all 24
     `shop.seams.tokyo` items — 8 financiers, 1 hotcake financier, 5 savoury
     pies, 3 fruit pastries, and 7 made-to-order drinks — publish editable
     `RecipeRevision`s (`stocked` batch yields for the 17 bakes, `immediate`
     single-serving recipes for the 7 drinks), baking and packaging
     `InventoryItem`s, and `supply_cost_terms` pack prices with 7-day bulk
     tiers.

3. **Shared deterministic budget and margin engine (`@satyr/control-api`)**
   - Convert compatible metric units (`gram` ↔ `kilogram`, `milliliter` ↔
     `liter`, `each` ↔ `each`) and reject incompatible units.
   - Compute 7-day ingredient and packaging demand across all active recipes,
     unlock supplier bulk tiers when 7-day usage reaches `bulkMin7dQuantity`,
     and report daily tier savings.
   - Distinguish whole-batch production on `stocked` bakes (`ceil(demand /
     batchYield) * batchYield` plus bake reject buffer and shelf spoilage) from
     single-order preparation on `immediate` drinks (prep reject loss only, zero
     unsold shelf spoilage).
   - Compare operator-selected waste and reject assumptions against measured
     30-day shop history (`waste` and `damage` `InventoryMovement`s, `expired`
     `InventoryLot`s, and `ProductionBatch` `plannedYield` vs `actualYield`).
   - Deduct included consumption tax (`round(price * taxBps / (10000 +
     taxBps))`, defaulting from active `CheckoutProfile` tax, recent
     tax-included orders, or `800` bps for `JPY` food) and payment/channel fees
     to report per-unit net contribution, net margin %, daily net contribution,
     and 26-day operating-month projections.

## Scope (Phase 2 — Spreadsheet Upgrade)

1. **Regional D1 Organisation Cost Plan (`bakery_cost_plan`, `bakery_cost_product_plan`)**
   - Persist per-Organisation `daily_labor_minor`, `daily_rent_minor`, and
     per-product `mon_units..sun_units` plus optional `spoil_bps` in regional D1
     with optimistic `revision` fencing (`expectedPlanRevision`) and patch
     script `services/platform/scripts/plan-86-costs-plan-d1-patch.sql`.
   - Compute `dailyFixedCostMinor`, `dailyOperatingProfitMinor`,
     `operatingMarginPct`, `monthlyOperatingProfitMinor`, and daily break-even
     unit volume (`breakEvenUnitsPerDay`), plus target-margin price back-solve
     (`backSolveGrossPriceMinorForMargin`).

2. **Batch `Save changes` on `POST /v1/control/organisations/:id/commerce/costs`**
   - `kind: "save_sheet"` commits dirty cells in one idempotent operation:
     - `priceWrites` updates live Underclerk `Offer` prices (`client.updateOffer`
       with `expectedOfferRevision`), restricted to `owner` and `admin` roles
       because offer prices change what buyers pay on storefronts and café
       screens.
     - `supplyWrites` updates Underclerk `supply_cost_terms` (`operator` or
       higher).
     - `planWrite` updates `bakery_cost_plan` and `bakery_cost_product_plan` in
       regional D1 (`operator` or higher).
   - BOM lines in the collapsible drawer remain read-only on `CostsPage` and
     link directly to **Satyr Kitchen › Recipes**.

3. **Portal 3-Sheet Workbook (`apps/portal/src/features/costs/route.tsx`)**
   - **Top P&L & Break-Even Formula Ribbon**: `Gross/d − Supply, tax & fee =
     Contrib/d − Labor/d − Rent/d = Operating Net/d` with `BEP u/d`, dirty-cell
     counter, `Reset`, and `Save changes`.
   - **Sheet 1 (`1. Product Margins`)**: dense sticky-header grid with editable
     `Units/d`, `Spoil %`, `Price ¥`, and `Margin %` (back-solving `Price ¥`),
     `Enter` / `Shift+Enter` / `↑` / `↓` row navigation, and a collapsible
     right-hand Recipe BOM & waterfall drawer.
   - **Sheet 2 (`2. Mon–Sun Plan (7d)`)**: editable 7-day `Mon..Sun` unit cells
     driving 7-day batch runs and supplier bulk-tier unlocks.
   - **Sheet 3 (`3. Supplier Pack Prices`)**: inline spreadsheet cells for
     `Pack Qty`, `Pack Unit`, `Pack ¥`, and 7-day bulk tier cells.

4. **Portal / Slack chat agent parity**
   - `costs_read` returns the Organisation's saved `costPlan`, fixed overhead
     and `breakEvenUnitsPerDay` in `summary`, and `offerId`, `offerRevision`,
     `spoilPct`, and `weekUnits` on each product.
   - `costs_plan_save` (`commerce.supply_cost.save`) saves `dailyLaborMinor`,
     `dailyRentMinor`, and per-product `weekUnits` / `spoilBps` with
     `expectedPlanRevision` fencing, `passSharedDraftExit`, and durable
     receipts.
   - Buyer-facing offer price changes from the chat agent continue to require
     human approval via `menu_board_propose_price` or
     `commerce_propose_action` (`adjust_offer_price`) rather than unapproved
     direct agent execution.

## Scope (Phase 3 — Full Multiplayer)

1. **Shared Yjs CRDT Workbook (`@satyr/costs-sheet-crdt` + `CostsSheetRooms`)**
   - Sparse cell overrides in `Y.Map("cells")` (`overhead:dailyLabor`,
     `overhead:dailyRent`, `scenario:*`, `product:<id>:daily`,
     `product:<id>:day:0..6`, `product:<id>:spoil`, `product:<id>:price`,
     `supply:<id>:<field>`) sync live across all open browser screens per
     Organisation via `CollaborationRoom` (`costs_sheet`) on `OrganisationDO`
     (`costs_sheet_draft` SQLite table with idle compaction).
   - Routes under `/v1/control/organisations/:id/commerce/costs/sheet`:
     - `GET .../sheet` reads the snapshot (`viewer` or higher).
     - `GET .../sheet/socket` opens a hibernatable WebSocket with `Origin`
       verification (`edit` for `operator`+, read-only `read` for `viewer`).
     - `POST .../sheet/reset` clears uncommitted draft cells (`operator`+).

2. **Figma-Style Live Cursors, Colored Cell Borders & Tab Presence**
   - `CostsSheetClient` (`apps/portal/src/features/costs/costs-sheet-client.ts`)
     streams normalized pointer coordinates (`pointer_update`, 5s idle hide) and
     focused `{ sheet, cellKey }` selections (`presence_update`).
   - `costs-sheet-presence.tsx` renders colored `MousePointer2` arrows with
     username pills across the workbook surface, 2px colored cell borders and
     floating username flags on focused cells, colored presence dots on the
     three workbook tabs, and clickable collaborator chips in the header bar.

3. **Authoritative `Save changes` Settlement & Chat Agent Live Presence**
   - `Save changes` (`POST /commerce/costs` `kind: "save_sheet"`),
     `supply_cost_save`, and `costs_plan_save` call
     `OrganisationDO.settleCostsSheetDraft`, removing committed cell overrides
     while preserving uncommitted scenario cells and stamping `meta:savedAt` so
     every open browser tab refreshes its baseline `CostsOverview` seamlessly.
   - `costs_sheet_edit` (`commerce.supply_cost.save`, gated by
     `passSharedDraftExit`) edits cells directly in the live multiplayer room
     while broadcasting an active `CollaborationAgentActivity` cursor on the
     target cell, and `costs_read` surfaces non-empty `draftCells`.

## Scope (Phase 5 — Lot Costs from Purchase Invoices)

1. **Regional D1 Lot Invoice Costs (`bakery_lot_invoice_cost`) & Automatic `supplier_payable` Linking**
   - Persist explicit per-lot purchase invoice cost rows (`lot_id`,
     `inventory_item_id`, `revision`, `currency`, `invoiced_quantity`,
     `invoiced_unit`, `invoice_total_minor`, `invoice_reference`, `supplier_id`)
     in regional D1 with optimistic `revision` fencing (`expectedRevision`) and
     patch script `services/platform/scripts/plan-86-lot-costs-d1-patch.sql`.
   - When a lot's receipt movement (`lot.sourceMovementId`) has
     `purchase.kind === "replenishment"` and no explicit
     `bakery_lot_invoice_cost` row overrides it, `readCostsOverview`
     automatically resolves `invoiceCost` (`source: "supplier_payable"`) from
     the matching non-void `supplier_payable` row in regional D1.

2. **FIFO & Weighted-Average Lot Cost Valuation (`@satyr/control-api`)**
   - `CostScenarioAssumptions.lotCostBasis` selects `"standing"` (default),
     `"fifo_lot"` (oldest active priced lot by `receivedAt`, or FIFO walk across
     active priced lots covering daily demand), or `"weighted_lot"` (weighted
     average across active priced lots by `remainingQuantity`).
   - `CalculatedSupplyUsage` reports `activeLotCount`, `pricedLotCount`,
     `availableLotBaseQuantity`, `fifoLotCostPerBaseUnitMinor`,
     `weightedLotCostPerBaseUnitMinor`, `fifoEquivalentPackPriceMinor`,
     `weightedEquivalentPackPriceMinor`, `lotCostVariancePct`, and `costSource`
     (`"standing_pack" | "bulk_tier" | "fifo_lot" | "weighted_lot" | "unpriced"`).

3. **Portal UI, Multiplayer CRDT & Chat Agent Parity**
   - `@satyr/costs-sheet-crdt` syncs `scenario:lotCostBasis` and
     `lot:<lotId>:<invoiceReference|invoiceTotalMajor>`.
   - `CostsAssumptionsPopover` adds a **Lot cost valuation** selector; Sheet 3
     (`Supplier packs`) adds a **Lot cost** column and a **Lots & Purchase
     Invoices** `SideDrawer` (`costs-lots-drawer.tsx`); `Save changes` commits
     `lotWrites` alongside `planWrite`, `priceWrites`, and `supplyWrites`.
   - `lot_cost_save` (`commerce.supply_cost.save`) records or updates a lot's
     purchase invoice cost from Portal or Slack chat with `passSharedDraftExit`
     and durable receipts, and `costs_read` supports `lotCostBasis` and returns
     `lots` and per-supply lot cost summaries.

## Scope (Phase 6 — Inline BOM Cost Chain, Stock Coverage & SKU Sensitivity)

1. **Inline `COGS` Cost Chain (`Wholesale → Recipe → SKU`)**
   - `CrmTable` supports `renderExpandedRow` for full-width detail panels inside
     spreadsheet grids without breaking column sorting, pinned columns, summary
     footers, or 2D arrow-key navigation.
   - `1. Product margins` expands any product row (via the `COGS` chevron, row
     action menu, or `fx` bar `Cost chain (N)` toggle) to render `Recipe BOM →
     Wholesale Cost Chain` (`costs-bom-inline.tsx`): ingredient/packaging
     supply, lot variance and reorder badges, batch quantity, per-piece quantity,
     active wholesale rate, batch cost, unit COGS + `%` share, `Open in Recipes ↗`
     link, and one-click drill-through to `3. Supplier packs` with that supply's
     drawer open.

2. **`Supplier packs` Stock Coverage, `Used in SKUs` & Downstream Margin Impact**
   - `@satyr/control-api` (`calculateBakeryCostsAndMargins`) computes per-supply
     `onHandBaseQuantity`, `daysOfSupply`, `reorderSuggested` (`< 4d` when daily
     usage is positive), `usedInProductCount`, `weeklyLotVarianceImpactMinor`,
     `tenPctHikeWeeklyImpactMinor`, and `skuImpacts`, plus per-product
     `recipeRevision` and `bomLines`.
   - `3. Supplier packs` adds **Stock coverage** (`Nd` pill + `< 4d` reorder
     warning) and **Used in SKUs** (`N SKUs` interactive reach badge);
     `CostsLotsDrawer` adds an on-hand vs 7-day coverage bar, weekly lot
     variance profit impact, `+10%` price sensitivity, and clickable downstream
     SKU impact rows that jump back to `1. Product margins` with that SKU
     expanded.

3. **Portal Screen Context & Chat Agent Parity**
   - `CostsPageViewSource` (`costs-page-view.ts`) exposes expanded BOM rows,
     reorder supply counts, stock coverage, and SKU reach to the Portal chat
     agent.
   - `costs_read` (`kitchen/costs.ts` & `agent-session-costs.ts`) emits
     `summary.reorderSupplyCount`, `weeklyLotVarianceImpactMinor` on supplies
     with priced lots, and `bomLines` + supply `daysOfSupply` /
     `usedInProductCount` on targeted SKU reads within `<harness>`'s 32 KB tool
     output cap.

## Scope (Phase 7 — Plan vs Actuals & Margin Variance Bridge)

1. **Windowed Actuals Observations (`CostsOverview.actuals`)**
   - `readCostsOverview` (`services/platform/src/commerce/cost-commands.ts`)
     summarizes 7-day and 30-day shop actuals with zero schema migrations:
     non-cancelled Underclerk `orders` (`orderCount`, `posOrderCount`,
     `onlineOrderCount`, `grossSalesMinor`, `includedTaxMinor`, completed
     `refundsMinor`, and per-SKU `unitsSold` / `grossSalesMinor`),
     `productionBatches` (`batchCount`, `plannedBatchUnits`,
     `actualBatchUnits`), finished-good `movements` & expired `lots`
     (`stockedUnitsProduced`, `stockedUnitsWasted`), direct ingredient and
     packaging waste movements (`supplyLosses`), and `supplier_payable` totals
     (`settledPayablesMinor`, `openPayablesMinor`, `payableCount`).

2. **Deterministic Variance Engine (`calculateBakeryPlanVsActuals`)**
   - `@satyr/control-api` (`packages/control-api/src/costs-actuals.ts`) compares
     standing plan targets against realized sales, FIFO/weighted lot invoice
     rates, bake rejects, showcase spoilage, and allocated supply losses across
     `7d` and `30d` windows, switching cleanly between `"orders_and_costs"`
     (when orders exist) and `"costs_and_waste_only"` (when zero orders exist)
     and ranking root-cause **Margin Bridge** drivers (`lot_invoice`,
     `product_waste`, `supply_loss`, `volume_mix`).

3. **Portal `Plan vs actuals` Workbook Tab & Chat Agent Parity**
   - `apps/portal/src/features/costs/costs-actuals-sheet.tsx` adds the
     **Plan vs actuals** tab (`CostsActualsKpiStrip`, `CostsMarginBridgeBar` with
     `7d / 30d` Base UI `Select` and clickable leak chips that jump to
     `Supplier packs` lots or select the SKU row, and `CostsActualsSheet` with
     expandable realized `CostsInlineBomPanel` rows); `costs-supplies-sheet.tsx`
     extracts the supplier pack grid to keep `route.tsx` ~500 lines below the
     3,000-line ceiling.
   - `costs_view_open_tab`, `@satyr/costs-sheet-crdt`, `CostsPageViewSource`,
     and `costs_read({ actualsWindowDays: 7 | 30 })` (guarded by `"order"`
     internal report admission) give the Portal chat agent full Plan vs Actuals
     visibility.

## Phase 8: 12-Week Rolling P&L, Cash Runway & Equipment Capex Payback

1. **12-Week Forecast Contract & Deterministic Cash Engine (`@satyr/control-api`)**
   - `packages/control-api/src/costs-forecast.ts` defines `CostForecastPlan`
     (`openingCashMinor`, `demandCurve`, 12-week `weekDemandPct` tuple,
     `supplierTerms`: `cod | net_15 | net_30`, `extraShiftThresholdPct`,
     `extraShiftWeeklyMinor`, and `capexMinor`) and
     `calculateBakery12WeekForecast`.
   - Each week scales baseline Mon–Sun product demand by `weekDemandPct[w]`,
     re-runs `calculateBakeryCostsAndMargins` in `"weekly"` mode so peak holiday
     weeks organically unlock 7-day supplier bulk tiers, triggers step
     baker/barista shift labor above `extraShiftThresholdPct`, settles monthly
     shop rent (`28 × dailyRentMinor`) on `W3 / W7 / W11`, models `cod`,
     `net_15`, and `net_30` supplier cash outflows (including open D1
     `supplier_payable`), deducts W1 equipment `capexMinor`, and computes
     `lowestCashMinor` trough timing and `capexPaybackWeeks`.

2. **Regional D1 Persistence & Multiplayer CRDT Cells**
   - `bakery_cost_plan.forecast_json` stores the Organisation's saved
     `CostForecastPlan` alongside `daily_labor_minor`, `daily_rent_minor`, and
     `products_json` (`services/platform/scripts/plan-86-costs-plan-d1-patch.sql`
     patches deployed databases).
   - `@satyr/costs-sheet-crdt` adds `"forecast"` to `CostsSheetTab` plus
     `forecast:opening_cash`, `forecast:demand_curve`,
     `forecast:supplier_terms`, `forecast:extra_shift_pct`,
     `forecast:extra_shift_minor`, `forecast:capex_minor`,
     `forecast:week_idx:0..11`, and `forecast:row:<id>:<col>` peer selection
     keys, settled automatically when `save_sheet` or `costs_plan_save` commits.

3. **Portal `12-week P&L & cash` Tab & Chat Agent Parity**
   - `apps/portal/src/features/costs/costs-forecast-sheet.tsx` adds
     `CostsForecastKpiStrip`, `CostsForecastControlsBar` (Base UI `Select` for
     seasonality curve and supplier terms plus live CRDT fields for opening
     cash, step shift threshold/cost, and W1 capex),
     `CostsForecastTrajectoryChart` (SVG operating profit bars, lump outflow
     bars, and ending bank cash line), and `CostsForecastSheet` (`W1..W12` +
     `12w Total` with editable weekly seasonality `%` cells).
   - `costs_view_open_tab`, `CostsPageViewSource`, `costs_read({ forecast })`,
     and `costs_plan_save({ forecast })` give the Portal chat agent full
     12-week P&L and cash scenario simulation and persistence parity.

## Future features

- **Workflow labor and energy costs**: derive per-step staff station minutes
  and equipment energy (`kWh` across ovens, mixers, proofers, and cold cells)
  from Satyr Kitchen recipe workflows (Plan 84 / Plan 60A), roll them into
  per-batch and per-unit product cost alongside ingredients, packaging, and
  fixed shop overhead, and show the breakdown in `CostsBomDrawer` and
  `costs_read`.
