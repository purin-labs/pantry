# Plan 90 — Café Counter Register and POS Payment Adapters

Status (20 November 2026): Phases 1, 2, 3A and 4A are built and on `dev`
(merged on 19 November). Phases 3B, 3C, 4B and 5 are open.

- The Platform releases of 19 and 20 November carry Phase 2: the Register is
  live in the Portal. The commerce Worker is not deployed since 15 November, so
  production has none of the Phase 1, 3A and 4A commerce code. The Register
  takes no payment there: cash is off, and no terminal is assigned.
- The regional D1 patch `plan90-payment-terminal-d1-patch.sql` is applied in
  production (checked on 20 November).
- The schema 91 step of the commerce Worker failed in a Durable Object for each
  checkout with a payment attempt. It is fixed, and its rehearsal in workerd
  (`services/commerce/scripts/schema-upgrade-rehearsal.ts`) passes from
  `628f4a225` in `seams-tech/pantry-history`, the commit that production runs.
- The next release deploys the commerce Worker with the Platform Worker.

Date: 16 November 2026
Owners: Underclerk, Satyr platform, CafeOS Portal, and `shop-gateway`

Follows:
[Plan 33C — Payment Terminal Integrations (POS Systems)](./plan-33C-POS-systems.md),
[Plan 33D — Square release acceptance](./plan-33D-square-release-acceptance.md),
[Plan 40B — Collaborative Menu Editor](./plan-40B-collaborative-menu-editor.md),
[Plan 80 — Underclerk as a Multi-Tenant Headless Backend](./plan-80-underclerk-multi-tenant-backend.md),
and [Plan 85 — Devices page for Satyr Kitchen](./plan-85-device-fleet-page.md).

Touches:
[Plan 81 — Agent Portal control](./plan-81-agent-portal-control.md),
[Plan 82 — Portal voice control](./plan-82-portal-voice-control.md),
[Plan 87 — Screen context](./plan-87-screen-context.md),
and [Plan 89 — Outside-written content](./plan-89-outside-written-content.md).

## Goal

A café in Japan needs one counter checkout system (`CafeOS › Register`) where
baristas ring up items and modifiers from the live shop menu, take cash, cards,
FeliCa e-money (`Suica`, `PASMO`, `iD`, `QUICPay`), or QR wallets (`PayPay`,
`d払い`, `Rakuten Pay`), hand over or queue the order with its `F-xxx` pickup
code, and print or reopen the Satyr receipt.

Underclerk stays the single commerce authority. A counter location plugs into
either **Square** (Square Terminal over cloud REST, with an optional Square POS
iPad handoff) or **GMO `stera`** (`stera terminal` over the shop LAN through
`shop-gateway`) behind one in-person payment contract, or sells in cash with no
terminal at all.

## Facts from the code (2026-11-16)

- **No staff register UI exists.** `CounterSaleOpenForm` in
  `apps/portal/src/features/terminals/route.tsx` is gated by `props.canManage`
  (`admin` and `owner` only) and accepts at most two lines from raw
  `variantId · satyrLocationId` dropdowns. An `operator` barista cannot see it,
  even though `beginCounterSaleMutation` in
  `services/platform/src/control/routes/counter-sale.ts` already authorizes the
  `"operator"` role.
- **Counter checkouts refuse menu entries and modifiers.** `planPointOfSaleQuote`
  in `services/underclerk/src/commerce-authority/checkout-planning.ts` rejects
  any line with `line.source.kind !== "catalog"` and checks a static
  `supportedItems` variant list on `point_of_sale_configuration`. Made-to-order
  drinks with modifiers, `sold_out_today` marks, and serving hours on
  `menu_cafe_main` (Plan 40B) work on the QR order page through
  `resolveCheckoutSelection`, which sits immediately below that guard, but a
  counter sale cannot use them.
- **Cash works on draft orders, not at the counter.** Underclerk records
  `manual_tender` (`method IN ('cash', 'bank_transfer')`,
  `services/underclerk/src/payments/manual-tender.ts`) for draft orders and
  order balances, and `src/payments/position.ts` already tracks manual refunds.
  However, `resolveCounterAuthority` (`counter-sale.ts`) requires an active
  terminal assignment to open a counter sale, and `placementTerminalId`
  (`checkout-payment-planning.ts`) throws unless
  `binding?.provider === "square_terminal"`.
- **Square Terminal is pinned to `CARD_PRESENT` only.** `SquareTerminalGateway`
  in `services/underclerk/src/payments/square/square-payments.ts` posts to
  `/v2/terminals/checkouts` without `payment_type` (defaulting to
  `CARD_PRESENT`) and `#reconcileTerminal` rejects any Square Payment whose
  `raw.source_type !== "CARD"`. Square's Japan Terminal API supports
  `FELICA_ALL` (`felica_details`) and `QR_CODE` (`source_type: "WALLET"`,
  `wallet_details` for `PAYPAY`, `D_BARAI`, `RAKUTEN_PAY`, `AU_PAY`, `MERPAY`,
  `ALIPAY_PLUS`), and Square's Refunds API refuses digital refunds on FeliCa
  with `REFUND_DECLINED`.
- **`InPersonPaymentBinding` names `square_terminal` only, while the local
  gateway seam already exists.** `parseInPersonPaymentBinding` in
  `packages/underclerk-contracts/src/payment-binding.ts` accepts only
  `provider: "square_terminal"` (`transport: "server_terminal"`). Underclerk
  already exposes app-scoped `payments:record` routes
  (`record_checkout_payment_capture` and `resolve_checkout_payment`,
  `services/underclerk/docs/spec.md` §12), and `crates/shop-gateway` (Plan 85)
  already holds one outbound authenticated WebSocket from a computer in the shop
  to `DeviceFleetActor`.
- **`counter-sale.ts` is a 1,117-line route file with inline domain logic.**
  New counter work belongs in a Platform domain module returning `Result`, with
  a thin route handler (`AGENTS.md` repository boundaries).
- **Receipt printer hardware is simulation-only.** `CounterSaleRoute` prints
  through `window.print()`. Star Micronics `mC-Print3` (`MCP31LB`) and
  `mJ-Drawer` exist only as Blender and MuJoCo assets in
  `docs/equipment/star-mcp31lb/`.

## Decisions

D1. **One commerce authority; payment terminals only move money.** Underclerk
owns products, menus, modifiers, prices, discounts, included consumption tax,
stock holds, `point_of_sale` checkouts, `point_of_sale` orders, pickup codes,
and commercial receipts. Square and GMO `stera` supply payment collection and
verified payment evidence only. Full third-party POS registers (Smaregi,
AirREGI, Square Register catalog mode) remain outside this checkout boundary.

D2. **Split `CafeOS › Register` (`operator`+) from `CafeOS › Counters &
payments` (`admin`+ setup).** Staff ring up sales on a dedicated `/register`
route (`apps/portal/src/features/register/`) beside `Order queue`. Counter
policy setup, Square pairing, `stera` gateway binding, and diagnostics stay on
`/terminals`. The two-item `CounterSaleOpenForm` on `/terminals` is removed once
`/register` is live.

D3. **Counter checkouts read the live published menu and modifiers.**
`point_of_sale_configuration` adds a `catalogScope` union: either the legacy
explicit `supportedItems` list or `{ kind: "published_menu", menuId,
maxQuantityPerLine }`. When `published_menu` is active, `planPointOfSaleQuote`
accepts `food_service_menu_entry` lines for that menu, resolves modifier option
prices and ingredient consumption holds through `resolveCheckoutSelection`, and
enforces `sold_out_today`, expired-lot exclusions, and menu serving hours
identically to the QR order page.

D4. **Cash is a native counter tender with recorded change.** A counter sale
opens without requiring a paired card terminal when the counter policy enables
cash. Underclerk adds `record_counter_cash_payment`
(`POST /v1/admin/merchants/:merchantId/counter-sales/:checkoutId/cash-payment`,
scope `orders:write`): it verifies `cashReceivedMinor >= amountDue`, records a
captured `manual_tender` (`method: "cash"`, `cashReceivedMinor`,
`changeDueMinor`), places the `point_of_sale` Order with `terminalId: null`, and
queues or completes pickup in one idempotent transaction.

D5. **Square Terminal multi-tender is the default Square path; Square POS app
handoff is optional.**

- **`square_terminal` (`server_terminal`, default):** collection accepts
  `paymentMethod: "card" | "felica" | "qr_code"`, mapped in
  `SquareTerminalGateway` to Square's `CARD_PRESENT`, `FELICA_ALL`, and
  `QR_CODE` (`CheckoutOptionsPaymentType`). `#reconcileTerminal` verifies
  `GET /v2/payments/:id` for `COMPLETED` status, exact location, currency,
  amount, zero tip, and matching tender evidence (`CARD` for `card`, `FELICA` /
  `felica_details` for `felica`, `WALLET` / `wallet_details` for `qr_code`),
  persisting the sub-brand (such as `FELICA_TRANSPORTATION` or `PAYPAY`) on the
  payment record.
- **`square_pos_app` (`client_app_handoff`, optional Phase 3B):** for an iPad
  paired to a Bluetooth Square Reader with no Square Terminal, `/register`
  launches `square-commerce-v1://payment/create` with a deterministic client
  reference. Return-URL parameters are untrusted hints; Underclerk settles the
  attempt only after `GET /v2/payments/:id` confirms the exact merchant,
  location, amount, currency, and zero tip.

D6. **Non-refundable Japan e-money refunds in cash without skewing payouts.**
Square's Refunds API refuses FeliCa refunds (`REFUND_DECLINED`), and `stera`
transit IC (`Suica`, `PASMO`, `ICOCA`) likewise cannot reverse over the rail.
Underclerk marks `providerRefundable: false` on FeliCa and transit-IC captures.
When an authorized operator refunds such an order at the counter, Underclerk
runs `record_counter_manual_cash_refund`: it rejects provider refund dispatch,
records an explicit `manual_tender` cash refund outflow on the order's payment
position (`src/payments/position.ts`), and leaves the original electronic
capture intact so `bank-payouts.ts` still matches Square's and GMO's bank
settlements while cash drawer totals reflect the cash handed back.

D7. **GMO `stera` runs over `shop-gateway` LAN and settles through
`payments:record`.** `stera terminal` exposes no public cloud-to-terminal REST
API. `InPersonPaymentBinding` adds `provider: "gmo_stera"` with
`transport: "lan_gateway"`, `gatewayId`, and `deviceSourceKey`:

1. Underclerk creates the `point_of_sale` Checkout and opens a `gmo_stera`
   payment attempt in `processing` (`session.kind: "gateway_terminal_checkout"`).
2. Platform's `counter-register` domain reserves exclusive collection ownership
   on `DeviceFleetActor` (Plan 85) and sends a bounded `terminal_collect`
   command (`requestId`, `paymentAttemptId`, `amountMinor`, `currency: "JPY"`,
   `paymentMethod: "card" | "felica" | "qr_code"`, `expiresAt`) over the shop
   gateway's existing outbound WebSocket.
3. `crates/shop-gateway` speaks the local LAN POS-link protocol to the shop's
   `stera terminal`, persists local inflight state across socket drops, and
   returns the terminal's signed result (`captured`, `declined`, `cancelled`,
   or `indeterminate` with terminal receipt identifiers and brand).
4. Platform records verified capture or decline in Underclerk through the
   existing app-only `payments:record` routes (`record_checkout_payment_capture`
   and `resolve_checkout_payment`). An `indeterminate` LAN timeout locks the
   device in `result_unknown` on `DeviceFleetActor` until inquired or resolved
   through `unplaced_capture` / manual investigation — never re-charging.
5. **Contract gate:** Following Plan 33B/33C rules, we build no guessed `stera`
   wire framing. Phase 4A ships the `lan_gateway` protocol, exclusivity,
   recovery, and `--simulate` fixture; Phase 4B adds the physical `stera` LAN
   framing only after SMBC (`stera developers`) and GMO Financial Gate
   (`pos_stera@gmo-fg.com`) provide the official POS-link specification.

D8. **Star `MCP31LB` printing and `mJ-Drawer` kick are optional `shop-gateway`
effects.** Browser receipt print and QR receipts stay the zero-hardware
baseline. Phase 5 adds `receipt_print` and `cash_drawer_kick` tasks on
`shop-gateway` for Star `mC-Print3` (`MCP31LB` over LAN TCP/`StarPRNT`, driving
the 24 V `DK-Port` solenoid on `mJ-Drawer`). Hardware print or drawer errors
surface on the Register and `Devices` page (`Plan 85`) and never roll back a
completed sale.

D9. **Agents stage counter baskets; humans execute money movement.** Following
Plans 81, 82, 87, and 89:

- The Portal chat and voice agent gets `counter_sale_read`
  (`commerce.order.read`) and Register screen surface commands
  (`register.add_item`, `register.update_line`, `register.remove_line`,
  `register.clear_basket`) when the member has `/register` open, so a barista
  can say *"Two plain financiers and an iced ginger milk tea"*.
- The agent gets **no tool** to trigger terminal collection, record cash
  received, kick the cash drawer, or run a direct counter refund. A person at
  the counter taps **Charge** or **Record cash** after seeing the total, and
  chat-proposed refunds continue through `commerce_propose_refund` (`owner` or
  `admin` approval card).
- Customer-supplied free text never enters counter basket commands; if a
  session has `writer: "outside"` (Plan 89), `surface` staging commands affect
  only that operator's screen view and have no financial or record consequence.

## Architecture

```text
CafeOS › Register (/register, operator+)  ◄── Plan 87/82 chat & voice staging
        │
        │ controlRead / controlMutation (Idempotency-Key)
        ▼
Platform domain: services/platform/src/commerce/counter-register.ts
        │
        ├──► Underclerk (single commerce & order authority)
        │      ├─ planPointOfSaleQuote (menu_cafe_main + modifiers + stock holds)
        │      ├─ cash ──────────────► record_counter_cash_payment (manual_tender)
        │      ├─ square_terminal ───► SquareTerminalGateway ──► Square Cloud REST
        │      │                         (CARD_PRESENT | FELICA_ALL | QR_CODE)
        │      └─ gmo_stera ─────────► payment_attempt (processing)
        │                                     ▲
        │                                     │ payments:record (capture / resolve)
        └──► DeviceFleetActor (Plan 85) ──────┘
               │ outbound WebSocket (no open shop ports)
               ▼
        crates/shop-gateway (shop Mac / mini-PC on café LAN)
               ├─► GMO stera terminal (LAN POS-link: card, FeliCa, QR)
               └─► Star MCP31LB + mJ-Drawer (LAN StarPRNT + DK-Port kick)
```

## Cost of each idle tenant (30 days)

Per `AGENTS.md`, an Organisation where nothing changes must cost close to
nothing:

- **New cron triggers:** `0`.
- **New background polls:** `0`. `/register` reads the menu on open and
  refreshes stock/queue state only while an operator has the tab open in the
  foreground.
- **Durable Object alarms when idle:** `0`. Underclerk's `SquareTerminalGateway`
  alarm (`5 s` for `10 min`, then `60 s` for `50 min`) schedules only while an
  unsettled `square_terminal` attempt exists, writes `0` rows when the checkout
  is still `PENDING` or `IN_PROGRESS`, and terminates at `60 min`.
  `DeviceFleetActor` writes `0` rows on unchanged `30 s` `shop-gateway`
  heartbeats (Plan 85).
- **30-day idle Organisation cost added by Plan 90:** `0` D1 rows written, `0`
  DO SQLite rows written, `0` queue messages, `0` KV writes, and `0` R2 writes.
  Guard with `pnpm --filter satyr-edge test:e2e tests/e2e/idle-tenant-cost.test.ts`
  after Phases 3 and 4.

## Repository boundaries and lints

- **Underclerk (`services/underclerk`, `packages/underclerk-contracts`,
  `packages/underclerk-commerce-client`):** owns quote rules, `InPersonPaymentBinding`,
  `SquareTerminalGateway`, cash tender, FeliCa cash-refund accounting, and
  `spec.md`. Update `services/underclerk/docs/spec.md` in the same commit as
  every route, command, scope, or rule change (`pnpm lint:underclerk-spec`).
  Import no Satyr package (`pnpm lint:runtime-boundary`).
- **Platform (`services/platform`):** extract counter orchestration out of
  `src/control/routes/counter-sale.ts` into `src/commerce/counter-register.ts`
  returning typed `Result` values. Route handlers parse requests, check
  authorization, call one domain function, and map its result (`pnpm
  lint:runtime-boundary`, `pnpm lint:file-size` — run
  `node scripts/check-file-size-ratchet.mjs --update` if a ratcheted file
  shrinks).
- **Database and capabilities:** `cafe_terminal_assignment` already stores
  versioned `assignment_json` in regional D1; if any regional table or index is
  added, ship a patch script in `services/platform/scripts/`
  (`pnpm lint:d1-patch`). `counter_sale_read` reuses `commerce.order.read`; if
  any new capability is introduced, add its IFC sink class (`pnpm
  lint:ifc-boundaries`) and run `node scripts/capability-policy-backfill-sql.mjs`.
- **Portal (`apps/portal`):** build `/register` with `apps/portal/src/ui`
  components (`Select` with `items`, `SideDrawer`, `Popover`, `EmptyState`),
  plain CSS tokens, and `controlRead` / `controlMutation` (`pnpm
  lint:portal-select`, `pnpm lint:portal-fetch`).

## Phases

| Phase | Scope | Estimate | Gate / External dependency |
| --- | --- | --- | --- |
| 1 | Underclerk counter menu lines, modifiers, and counter cash tender (`spec.md` in same commit) | 4–5 days | None |
| 2 | `CafeOS › Register` tablet UI (`/register`), domain extraction (`counter-register.ts`), and chat/voice basket staging | 1–1.5 weeks | Phase 1 |
| 3A | Square Terminal Japan multi-tender (`CARD_PRESENT`, `FELICA_ALL`, `QR_CODE`) and FeliCa manual-cash refund accounting | 4–5 days | Phase 1; Sandbox test device IDs |
| 3B | Optional Square POS iPad handoff (`square_pos_app` URL scheme + Payment readback) | 1 week | Only if an iPad + Square Reader shop needs it |
| 3C | Physical Square Terminal live certification (restarts [Plan 33D](./plan-33D-square-release-acceptance.md) on Underclerk) | 2–3 days | Enabled Japan Square location + physical Square Terminal |
| 4A | `gmo_stera` `lan_gateway` binding, `DeviceFleetActor` exclusivity, `shop-gateway` `terminal_collect` protocol, and `--simulate` E2E | 1 week | Phase 1 + Plan 85 |
| 4B | Physical GMO `stera terminal` LAN POS-link framing and hardware certification in `crates/shop-gateway` | 2 weeks | Official POS-link spec from SMBC / GMO-FG + `stera terminal` |
| 5 | Optional Star `MCP31LB` receipt print and `mJ-Drawer` kick through `shop-gateway` | 1 week | Physical `MCP31LB` printer (+ optional `mJ-Drawer`) |

### Phase 1 — Underclerk counter menu, modifiers, and cash tender

Work:

- Extend `PointOfSaleConfiguration` (`@underclerk/contracts`) with
  `catalogScope` (`supported_items` | `published_menu`) and `cashEnabled:
  boolean` (default `true` for new counter policies; existing rows read as
  `supported_items` and `cashEnabled: false` until republished).
- Update `planPointOfSaleQuote` (`checkout-planning.ts`) to accept
  `food_service_menu_entry` lines and modifier selections when `catalogScope`
  names the published menu, enforcing `sold_out_today`, serving hours, and
  ingredient lot holds.
- Allow `CreateUnderclerkInPersonCheckoutV1` to take
  `terminalAssignmentRevision: number | null` so a cash-enabled counter with no
  terminal can open a `point_of_sale` Checkout.
- Add `record_counter_cash_payment` (`POST
  …/counter-sales/:checkoutId/cash-payment`, `orders:write`): validates
  `cashReceivedMinor >= amountDue`, writes the `manual_tender` row with
  `cashReceivedMinor` and `changeDueMinor`, places the `point_of_sale` Order
  (`terminalId: null`, pickup code `F-xxx`), and opens the preparation ticket
  and pickup fulfillment.
- Update `services/underclerk/docs/spec.md` (§4, §11, §12, §13, and route
  appendix).

Exit journey (`services/underclerk/tests/counter-register-cash-journey.test.ts`):
a 24-item pâtisserie shop publishes `menu_cafe_main` with a drink modifier and
marks one pastry `sold_out_today`; a counter checkout refuses the sold-out
pastry, quotes two financiers plus an iced oat milk tea with included 8%/10% or
configured consumption tax, settles in cash (`¥2,000` tendered, exact change
recorded), deducts recipe milk/tea and pastry lot stock on handover, and
refunds in cash once with replay returning the identical receipt.

### Phase 2 — `CafeOS › Register` and chat/voice staging

Work:

- Extract Platform counter-sale domain logic from
  `services/platform/src/control/routes/counter-sale.ts` into
  `services/platform/src/commerce/counter-register.ts` (`Result`-based), adding
  `GET /v1/control/organisations/:id/commerce/counter-register` (published menu
  sections, item availability, modifier groups, active counter policy, cash
  status, and active terminal readiness) and `POST
  …/counter-sales/:checkoutId/cash` (`operator`+).
- Add `register` (`CafeOS › Register`, `/register`) to `apps/portal/src/route.ts`
  and `pages.tsx` for `operator`+ members:
  - Left/main pane: section tabs from `menu_cafe_main`, touch tiles with prices
    and `Sold out` badges, and a `SideDrawer` / `Popover` for drink modifiers
    and quantity.
  - Right pane: live counter basket, tax-included total, quick JPY bill buttons
    (`Exact`, `¥1,000`, `¥5,000`, `¥10,000`) with live change preview for
    **Cash**, and **Charge terminal** (with method picker when the terminal
    supports Card / FeliCa / QR).
  - Post-sale state: large `F-xxx` pickup code, one-tap **Hand over now** (for
    counter pastries) or **Send to queue** (for made-to-order drinks visible on
    `Order queue` and `/tv` pickup boards), **Print receipt**, and **New sale**.
  - Reload recovery: an open or pending-collection checkout stays pinned in URL
    / session state with **Check terminal**, **Cancel collection**, or **Switch
    to cash** (only after confirmed terminal non-capture).
- Remove `CounterSaleOpenForm` from `apps/portal/src/features/terminals/route.tsx`.
- Add `counter_sale_read` (`agent-tools/commerce/`) and `register` surface
  commands (`bakery-surface-registry.ts`, Plan 87) so Portal chat and Plan 82
  voice stage lines into the open basket while leaving **Cash** and **Charge
  terminal** to the human operator.

Exit journey (`services/platform/tests/e2e/counter-register-journey.test.ts` +
Playwright browser artifact): an `operator` (not `admin`) opens `/register`,
uses the chat agent to stage two items with a modifier, adjusts quantity on
screen, completes a cash sale, sees the `F-xxx` order appear on `Order queue`,
hands it over, and verifies that a `viewer` is refused on every mutation and
that the agent has no tool to charge or record cash directly.

### Phase 3 — Square Japan multi-tender and live acceptance

Work (Phase 3A — Square Terminal multi-tender):

- Extend `MerchantInPersonCollectionCommand` and `SquareTerminalGateway`
  (`square-payments.ts`) with `paymentMethod: "card" | "felica" | "qr_code"`,
  sending `"CARD_PRESENT"`, `"FELICA_ALL"`, or `"QR_CODE"` to
  `POST /v2/terminals/checkouts`.
- Update `#reconcileTerminal` (`square-payments.ts`) to verify Square Payment
  readback across `CARD`, `FELICA` (`felica_details`), and `WALLET`
  (`wallet_details`), recording the verified sub-brand and setting
  `providerRefundable: false` on `FELICA`.
- Add `record_counter_manual_cash_refund` in Underclerk so refunding a
  `providerRefundable: false` order records a `manual_tender` cash refund
  without calling Square's Refunds API (`REFUND_DECLINED`), keeping
  `bank-payouts.ts` and cash totals consistent. Update `spec.md`.

Exit journey (`services/underclerk/tests/square-japan-tenders-journey.test.ts`
and live Sandbox run when credentials are present): card, `FELICA_ALL`, and
`QR_CODE` (`PayPay`) sales settle and verify readback; card and `QR_CODE`
refund through Square; FeliCa refuses provider refund and settles via
`record_counter_manual_cash_refund` with exact payout and cash positions; a
cancelled terminal prompt allows switching the same counter basket to cash.

Optional Phase 3B (`square_pos_app`): implement only if a target café uses an
iPad + Bluetooth Square Reader instead of a Square Terminal.

Phase 3C (restarts [Plan 33D](./plan-33D-square-release-acceptance.md) on
Underclerk): once the shop's Japan Square location is activated for live
payments and one physical Square Terminal is purchased, run the Plan 33D
distinct-seller check and physical pairing, card, FeliCa, QR, cancellation,
offline, and refund certification packet.

### Phase 4 — GMO `stera` adapter via `shop-gateway`

Work (Phase 4A — provider-neutral `lan_gateway` + simulation, no GMO blocker):

- Add `provider: "gmo_stera"` (`transport: "lan_gateway"`, `gatewayId`,
  `deviceSourceKey`) to `InPersonPaymentBinding` (`@underclerk/contracts`) and
  terminal assignment records (`@satyr/contracts`).
- Extend `packages/control-api/src/device-gateway.ts` and
  `DeviceFleetActor` with a `payment_terminal` hardware kind, per-terminal
  collection reservation, `terminal_collect` / `terminal_cancel` /
  `terminal_inquire` messages, and `terminal_result` receipts.
- Extend `crates/shop-gateway` `--simulate` to execute deterministic simulated
  `stera` card, FeliCa, QR, decline, cancel, and mid-flight socket-drop
  recoveries, settling into Underclerk via `record_checkout_payment_capture` and
  `resolve_checkout_payment` (`payments:record`).

Work (Phase 4B — physical `stera terminal` driver, **gated on GMO-FG spec**):

- Obtain the official LAN POS-link (CCT) specification from SMBC
  (`stera developers`) and GMO Financial Gate (`pos_stera@gmo-fg.com`).
- Implement the versioned `stera` LAN client in `crates/shop-gateway` with local
  disk journal persistence before LAN dispatch so a power or Wi-Fi blip never
  double-charges or strands a terminal.
- Run physical `stera terminal` certification (card, transit IC + cash refund,
  QR, cancel race, LAN unplug during tap, gateway restart) and record the
  evidence packet in `docs/evidence/`.

### Phase 5 — Star `MCP31LB` receipt printer and `mJ-Drawer` (optional)

Work:

- Add `receipt_printer` capability (`StarPRNT` over LAN TCP) and optional
  `cash_drawer_kick` (`DK-Port`) to `crates/shop-gateway` and
  `packages/control-api/src/device-gateway.ts`.
- Render an `80 mm` (`72 mm` printable width) thermal receipt layout in
  Platform from Underclerk's commercial receipt record (shop name, timestamp,
  tax-included lines, 8%/10% consumption tax breakdown and Qualified Invoice
  registration number when configured, tender, change due, and `F-xxx` code).
- Trigger drawer kick on counter cash capture and manual cash refund when a
  printer/drawer is bound to the counter location; fall back cleanly to browser
  print when absent or offline.

## Out of scope

- Smaregi and AirREGI checkout adapters (Smaregi sales-sync connector, if ever
  needed by an existing merchant, belongs to a separate read-import plan).
- Split tender across two cards, partial authorization, tipping, and offline
  catalog/order creation without internet connectivity to Underclerk.
- Building speculative `stera` LAN wire packets before receiving GMO-FG's
  official specification.
