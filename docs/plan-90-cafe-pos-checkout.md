# Plan 90 — Café Counter Register and POS Payment Adapters

Status (20 November 2026): Phases 1, 2, 3A, 3B, 4A and 5 are built and
released. The hardware work is deferred until the shop has the devices (the
owner's decision of 20 November): Phase 3C (Square Terminal), Phase 4B
(`stera terminal` and its POS-link spec), the live iPad check of Phase 3B
and the printer check of Phase 5. The owner steps for every hardware check
are in [the hardware runbook](runbooks/plan-90-hardware-acceptance.md).

- Phase 3B (Square Point of Sale app on the iPad) is proven with a fake
  Square in the commerce journey `tests/square-japan-tenders-journey.test.ts`
  and the Platform journey `tests/e2e/square-in-commerce.test.ts`. No live
  payment has gone through the Square app (runbook step A).
- Phase 5 (receipt printer and cash drawer) is proven in simulation. Its
  physical certification waits for the owner's `MCP31LB` (runbook step D).
- The FeliCa readback of Phase 3A was wrong and is fixed with Phase 3B:
  Square records e-money as a `CARD` payment with the card brand `FELICA`
  and the sub-brand in `electronic_money_details.felica_details.felica_brand`,
  not as `source_type: "FELICA"`. The code of the first commerce release
  refused every real FeliCa Terminal payment. No terminal was assigned in
  production, so no sale was affected.

Release of Phases 3B and 5 (20 November, 10:24 to 10:26 UTC), from `dev`
`3cd6686`:

- The commerce Worker `underclerk` is version `789f3773` (schema 92). The
  rehearsal from production `3fd041b` passed first. Both production merchants
  upgraded to schema 92 on their first request and answer their snapshot with
  the same records as before.
- The regional D1 patches `plan90-square-pos-app-d1-patch.sql` and
  `plan-90-receipt-printer-d1-patch.sql` are applied to
  `satyr-organisation-apac`. A copy of the production schema with its real
  device rows took both patches first. The 9 enrolled devices keep their rows.
- The Platform `satyr-edge` is version `2aa4f61c`, with the new
  `shop-gateway` build in the Portal assets. The schema gate passed (global
  61, APAC 368 and 1 extra). The live Portal entry files, the gateway install
  script and its three binaries equal the build. The helper Workers and the
  Slack ingress were not deployed again: they changed only by the package
  rename.
- Rollback: the Platform target is `ea3efc43`. A rollback of the commerce
  Worker to `f031c27b` refuses schema 92, so recover the engine with a forward
  fix.

Earlier releases:

- The Platform releases of 19 and 20 November carry Phase 2: the Register in
  the Portal, the counter-register domain and the Sous Chef tools.
- The commerce Worker carries Phases 1, 3A and 4A since 20 November 06:22 UTC:
  `underclerk` version `f031c27b`, from `dev` `3fd041b`. The Platform was not
  deployed again, because `dev` changed it only by the package rename.
- Both production merchants upgraded to schema 91 on their first request.
  They answer their snapshot with the same records as before the release.
- The Register takes cash when an operator switches cash on in the point of
  sale configuration, and card when a terminal is assigned. Production has
  neither on 20 November.
- The regional D1 patch `plan90-payment-terminal-d1-patch.sql` is applied in
  production (checked on 20 November).
- The schema 91 step first failed in a Durable Object for each checkout with
  a payment attempt. It was fixed before the release, and its rehearsal in
  workerd (`services/commerce/scripts/schema-upgrade-rehearsal.ts`) passed from
  `628f4a225` in `seams-tech/pantry-history`, the commit that production ran.
- A rollback to `10ca5e52` is not a recovery path: that code refuses a
  merchant at schema 91. Recover with a forward fix.

Date: 16 November 2026
Owners: Underclerk, Satyr platform, CafeOS Portal, and `shop-gateway`

Follows:
[Plan 33C — Payment Terminal Integrations (POS Systems)](./plan-33C-POS-systems.md),
[Plan 33D — Square release acceptance](./plan-33D-square-release-acceptance.md),
[Plan 40B — Collaborative Menu Editor](./plan-40B-collaborative-menu-editor.md),
[Plan 80 — Underclerk as a Multi-Tenant Headless Backend](./plan-80-underclerk-multi-tenant-backend.md),
and [Plan 85 — Devices page for Satyr Kitchen](history/plan-85-device-fleet-page.md).

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
- **`square_pos_app` (`client_app_handoff`, Phase 3B):** for an iPad
  paired to a Bluetooth Square Reader with no Square Terminal, `/register`
  launches `square-commerce-v1://payment/create` with a deterministic client
  reference. Return-URL parameters are untrusted hints; Underclerk settles the
  attempt only after `GET /v2/payments/:id` confirms the exact merchant,
  location, amount, currency, and zero tip.
  Built as the transport `client_app_handoff` of the provider
  `square_terminal`, with the terminal target `square_pos_app`. A new
  provider value would need a rebuild of `checkout_payment_attempt` for its
  provider CHECK, the kind of step that failed in schema 91.

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
  received, kick the cash drawer, print or reprint a receipt, or run a direct
  counter refund. A person at
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
- **Phase 5 printer and drawer:** `0`. A shop with no receipt printer reads
  one D1 row set at a print or a cash sale and starts no Durable Object. A
  `printer_job` row exists only after a print or a drawer task, and the daily
  upkeep that `DeviceFleetActor` already runs deletes it after 7 days.
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

Phase 3B (`square_pos_app`) — built and released on 20 November 2026:

- Café › Counters & payments: "Use the Square app on an iPad" assigns the
  counter to the Square Point of Sale app (`POST
  …/commerce/terminal-operations/square-pos-app`, `admin`+, production only:
  Square's Sandbox has no Point of Sale API). The form shows the one web
  callback URL, `<Portal origin>/portal/square-pos-return`, that the Square
  Developer Console must list.
- The Register's charge opens the app with the amount, the location, the
  tender types (`CREDIT_CARD`, which covers e-money in Japan, or `PAYPAY`) and
  a `state` that names the handoff reference and the Register. The callback
  page sends the browser back to that Register only, and the Register posts
  the app's answer (`POST …/counter-sales/:checkoutId/handoff-result`,
  `operator`+).
- Commerce keeps the first answer for the attempt (schema 92,
  `square_pos_handoff`), refuses another reference, another answer and a
  transaction id that another handoff used, reads the order
  (`GET /v2/orders/:transactionId`) and its one tender's payment, and records
  the capture only for a completed payment at the location, for the exact
  amount, with no tip, with no `reference_id`, made after the handoff started.
  A FeliCa capture is refunded in cash (D6). No alarm reads a handoff, so an
  idle counter costs nothing.
- Limits: if the app does not return to the Register, or in the app's Offline
  Mode, Pantry has no transaction id and the sale stays open; staff find the
  payment in the Square Dashboard. Live acceptance needs an iPad, a Square
  Reader and a live Japan location (runbook step A).
- Agent access: none. The handoff and its answer move money, so they stay
  with the person at the counter (D9); `counter_sale_read` shows the result.

Phase 3C (restarts [Plan 33D](./plan-33D-square-release-acceptance.md) on
Underclerk): once the shop's Japan Square location is activated for live
payments and one physical Square Terminal is purchased, run the Plan 33D
distinct-seller check and physical pairing, card, FeliCa, QR, cancellation,
offline, and refund certification packet. The steps are in step B of
[the hardware runbook](runbooks/plan-90-hardware-acceptance.md).

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
  (`stera developers`) and GMO Financial Gate (`pos_stera@gmo-fg.com`). The
  request is step C of
  [the hardware runbook](runbooks/plan-90-hardware-acceptance.md).
- Implement the versioned `stera` LAN client in `crates/shop-gateway` with local
  disk journal persistence before LAN dispatch so a power or Wi-Fi blip never
  double-charges or strands a terminal.
- Run physical `stera terminal` certification (card, transit IC + cash refund,
  QR, cancel race, LAN unplug during tap, gateway restart) and record the
  evidence packet in `docs/evidence/`.

### Phase 5 — Star `MCP31LB` receipt printer and `mJ-Drawer` (optional)

State (20 November 2026): built, proven in simulation and released. The
physical certification is deferred until the owner has the `MCP31LB` and
`mJ-Drawer` (step D of
[the hardware runbook](runbooks/plan-90-hardware-acceptance.md)).

What is built:

- **Protocol** (`packages/control-api/src/device-gateway.ts`): the hardware
  kind `receipt_printer` (capability `print_receipt`, and `cash_drawer` when a
  drawer hangs on the DK port), the Platform messages `receipt_print` (a typed
  48-column layout: text with alignment, emphasis and double size, two-column
  rows, rules and feeds) and `cash_drawer_kick`, and the gateway answer
  `printer_result` (`done`, `offline`, `paper_out`, `cover_open`, `no_drawer`,
  `unknown_device` or `result_unknown`, with `replayed`).
- **Gateway** (`crates/shop-gateway/src/printer.rs`): it encodes StarPRNT and
  sends it to TCP port 9100. The printer's LAN address stays in
  `printers.json` in the gateway's folder; the gateway reports each printer in
  its hello. A JSON journal records each `requestId` before the first byte and
  after the answer, so a repeated request never prints or opens the drawer a
  second time. A request that stopped between the two records answers
  `result_unknown`. Before a print, the gateway reads the printer's status
  (`ESC ACK SOH`), so a printer with no paper or an open cover prints nothing.
  The gateway also sends a health report, so the Devices page shows the fault.
  `--simulate` takes `printers` (`sourceKey`, `drawer`, `status`,
  `outputDir`); a simulated printer writes the bytes and a plain-text
  rendering to two files. `shop-gateway answer` answers one task message from
  standard input with the same journal.
- **DeviceFleetActor** (`services/platform/src/actors/device-fleet-printer.ts`,
  schema version 4): one `printer_job` row for each task. The Actor finds the
  location's bound printer: the first active `receipt_printer` on an active
  gateway of the location, which a person confirmed on the Devices page. It
  waits up to 8 s for the answer. A task with no answer goes again at the
  gateway's next hello while it is younger than 60 s; an older one ends as
  `result_unknown`, so nothing prints or opens late. No cron, alarm or poll.
- **Platform** (`services/platform/src/commerce/counter-receipt.ts` and
  `counter-printing.ts`): the receipt comes from Commerce's order record: shop
  name, time, the lines with their modifiers, the tax-included total, the
  taxable amount and tax for each rate (a line's rate comes from its own tax
  and price; reduced-rate lines carry `※`), the Qualified Invoice registration
  number when it is set, the tender and change, the pickup code and the order.
  Commerce keeps one tax rate for each counter today, so a receipt shows one
  rate until Commerce has a rate for each line. A cash sale and a completed
  manual cash refund open the drawer one time each (request ids
  `drawer_sale_<checkout>` and `drawer_refund_<checkout>`). A print or drawer
  error never changes the sale: the cash and refund answers carry `drawer`
  beside `counterSale`.
- **Routes:** `GET …/counter-sales/:checkoutId/receipt` (operator+: the
  printer and the tasks of the sale), `POST …/counter-sales/:checkoutId/receipt-print`
  (operator+), and `GET` / `PUT …/commerce/counter-receipt-settings` (the
  registration number; `PUT` is admin+). The table
  `cafe_counter_receipt_setting` holds it.
- **Register:** "Print receipt" prints on the bound printer. With no printer,
  or with a printer whose gateway is offline, the browser prints. Each error
  shows in plain words, with "Print in the browser" where it helps.
- **Agent access (D9):** the agent gets no tool to print or reprint a receipt,
  and none to open the drawer. A receipt is paper for the customer at the
  counter, and only the person there can hand it over. A reprint from the
  agent prints a second copy of a Qualified Invoice that nobody asked for at
  the counter. The agent reads the sale with `counter_sale_read`.

StarPRNT commands. The source is Star's "StarPRNT Command Specifications"
Rev. 4.20, <https://www.starasia.com/Download/Manual/starprnt_cm_en.pdf>, whose
model list names `MCP31LB` as mC-Print3 (1st Gen.). Rev. 2.25,
<https://www.starmicronics.com/support/Mannualfolder/StarPRNT_cm_en.pdf>, shows
the same commands. The command list for each model (section 5) marks each one
as supported on mC-Print3 (1st Gen.).

| Use | Command | Bytes | Rev. 4.20 |
| --- | --- | --- | --- |
| Initialize | ESC @ | `1B 40` | p. 103 |
| UTF-8 on | ESC GS ) U fn=48 | `1B 1D 29 55 02 00 30 01` | p. 127 |
| Japanese Kanji font first | ESC GS ) U fn=65 | `1B 1D 29 55 05 00 41 01 00 00 00` | p. 129 |
| Alignment | ESC GS a n | `1B 1D 61 n` | p. 45 |
| Emphasis on / off | ESC E / ESC F | `1B 45` / `1B 46` | p. 39 |
| Double size on / off | ESC i n1 n2 | `1B 69 01 01` / `1B 69 00 00` | p. 36 |
| Line feed | LF | `0A` | p. 46 |
| Feed and partial cut | ESC d 3 | `1B 64 03` | p. 52 |
| Drawer (DK port) | BEL | `07` | p. 137 |
| Status | ESC ACK SOH | `1B 06 01` | p. 106, Appendix 2 |
| LAN port | TCP 9100 | — | §2.1 (NSB), and the mC-Print3 manual |

Not used: Shift JIS Kanji mode (`ESC $`, `ESC p`), because UTF-8 mode covers
Japanese text, and `ESC BEL` (drawer pulse width), because the default of
200 ms stays. `ESC GS BEL` is not supported on mC-Print3.

Proof: `services/platform/tests/e2e/counter-receipt-printer.test.ts`. The
socket of the journey only carries messages: each task goes to the real
`shop-gateway answer` through `tests/shop-gateway-adapters.ts`. A cash sale
opens the drawer once and prints one receipt; a socket drop after the print
and before the answer ends with the same task `done` and `replayed`, with no
second print; a printer with no paper prints nothing, the Register message
and the Devices fault show it, and the sale stays complete; a viewer is
refused. The artifact is the simulated printer's text and bytes in
`output/e2e/shop-gateway/receipt-printer/printer/`.

The release of 20 November applied
`services/platform/scripts/plan-90-receipt-printer-d1-patch.sql` to the
regional D1 database and served a new `shop-gateway` build with the Portal.
A gateway does not update itself: a gateway that runs an older build has no
printer support until the shop runs the install command from the Devices
page again.

Not verified on hardware: the bytes on a real `MCP31LB`, the Japanese font on
the unit, the status block over Ethernet (if the printer sends no status, the
print goes ahead), the DK-port pulse with `mJ-Drawer`, and the newest edition
of the specification (Rev. 4.50 needs a sign-in). The certification prints a
Japanese receipt, opens the drawer, and checks paper out, cover open, a power
cut during a print and a LAN unplug.

## Out of scope

- Smaregi and AirREGI checkout adapters (Smaregi sales-sync connector, if ever
  needed by an existing merchant, belongs to a separate read-import plan).
- Split tender across two cards, partial authorization, tipping, and offline
  catalog/order creation without internet connectivity to Underclerk.
- Building speculative `stera` LAN wire packets before receiving GMO-FG's
  official specification.
