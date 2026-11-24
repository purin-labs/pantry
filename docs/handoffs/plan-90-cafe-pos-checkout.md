# Handoff — Plan 90: Café Counter Register and POS Payment Adapters

Date: 19 November 2026
Target repository: `/Users/pta/Dev/purin-labs/pantry` (`purin-labs/pantry`)
Owning plan: [`docs/plan-90-cafe-pos-checkout.md`](../plan-90-cafe-pos-checkout.md) (already committed in `pantry`)
Related plans: [`docs/plan-33C-POS-systems.md`](../history/plan-33C-POS-systems.md), [`docs/plan-33D-square-release-acceptance.md`](../history/plan-33D-square-release-acceptance.md), [`docs/plan-40B-collaborative-menu-editor.md`](../history/plan-40B-collaborative-menu-editor.md), [`docs/plan-80-underclerk-multi-tenant-backend.md`](../history/plan-80-underclerk-multi-tenant-backend.md), [`docs/plan-85-device-fleet-page.md`](../history/plan-85-device-fleet-page.md), [`docs/plan-91-seams-atelier-rename.md`](../history/plan-91-seams-atelier-rename.md), and [`docs/plan-92-new-pantry-repository.md`](../history/plan-92-new-pantry-repository.md).

## Current state

- **Phases 1, 2, 3A, and 4A are implemented on branch `plan-90-cafe-pos-checkout`.** Phases 3B (`square_pos_app`), 3C (live physical Square Terminal certification), 4B (GMO `stera` LAN CCT wire framing), and 5 (Star `MCP31LB` / `mJ-Drawer`) remain out of scope or hardware-gated.
- **Display and code names changed in Plans 91 and 92 (`AGENTS.md`):**
  - Product display name: **Seams Pantry** (short form: **Pantry**).
  - Switcher area: **Café** (`Café › Register`, `Café › Order queue`, `Café › Counters & payments`).
  - Built-in checkout display name: **Seams Checkout**; agent display name: **Sous Chef**.
  - `docs/plan-90-cafe-pos-checkout.md` keeps its pre-codemod path names per the Plan 91 rule (*"Plans and evidence keep the old names. Do not rewrite them."*). Translate old plan paths to the `pantry` paths in the table below when implementing.

| Old name in Plan 90 text | Current path / package in `purin-labs/pantry` |
| --- | --- |
| `services/underclerk/` | `services/commerce/` (`@seams/commerce-worker`) |
| `services/underclerk/docs/spec.md` | `services/commerce/docs/spec.md` (`pnpm lint:commerce-spec`) |
| `packages/underclerk-contracts/` (`@underclerk/contracts`) | `packages/commerce-contracts/` (`@seams/commerce-contracts`) |
| `packages/underclerk-commerce-client/` (`@underclerk/client`) | `packages/commerce-client/` (`@seams/commerce-client`) |
| `satyr-edge` (`services/platform/`) | `@seams/platform` (`services/platform/`, deployed Worker stays `satyr-edge`) |
| `@satyr/control-api`, `@satyr/contracts`, `@satyr/std` | `@seams/control-api`, `@seams/contracts`, `@seams/std` |
| `CafeOS › Register` | `Café › Register` (wire `WorkspaceSystem` value stays `"CafeOS"`) |

- **Plan 92 Phase 2 coordination:** Branch from `origin/dev` after the Plan 92 deduplication pass (`.claude/worktrees/p92-dup-51f67e`) lands, because it modifies `services/commerce/` and `services/platform/src/control/routes/counter-sale.ts` (`counter-policy.ts`, `terminal-operations.ts`, `order-queue.ts`, `payments.ts`). Reuse its shared helpers instead of writing new prologues:
  - `services/commerce/src/commerce-authority/merchant-command.ts` (`beginMerchantCommand`, `beginSnapshotCommand`, `admitMerchantCommand`)
  - `services/platform/src/control/admission/control-mutation.ts` (`parseMutationBoundary`, `resolveMutationUser`, `replayControlMutation`)
  - `services/platform/src/control/commerce-merchant.ts` (`resolveMerchantBinding`, `resolveMerchantControlContext`)
  - Run `node scripts/repo-binaries.mjs fetch` if a local Portal or native build needs R2 assets.

## Open decisions and external inputs from the owner

1. **Approval to start implementation (Phases 1–3A and 4A):** Confirm starting Phase 1 (counter menu, modifiers, and cash in `services/commerce`), Phase 2 (`Café › Register` UI and Sous Chef staging), Phase 3A (Square Terminal `CARD_PRESENT`, `FELICA_ALL`, `QR_CODE`, and manual cash refund for FeliCa), and Phase 4A (simulated `gmo_stera` `lan_gateway` over `shop-gateway`). Recommended default: build Phases 1–3A and 4A, and skip optional Phase 3B (`square_pos_app` iPad URL-scheme handoff) unless an iPad + Bluetooth Square Reader shop needs it.
2. **GMO `stera` specification (blocks Phase 4B only):** Register at `stera developers` (SMBC) and request the official LAN POS-link (CCT) specification from GMO Financial Gate (`pos_stera@gmo-fg.com`). Do not write speculative `stera` wire frames before the official spec arrives.
3. **Physical Square Terminal and live location (blocks Phase 3C / Plan 33D only):** Enable live card/FeliCa/QR payments on the Japan Square location and purchase one Japan Square Terminal to run the live certification packet.
4. **Star `MCP31LB` printer and `mJ-Drawer` (blocks Phase 5 only):** Optional hardware slice over `crates/shop-gateway`; browser receipt print (`window.print()`) and QR receipts cover Phases 1–4.

## Implementation tasks for `/Users/pta/Dev/purin-labs/pantry`

### Task 1 — Phase 1: Commerce counter menu, modifiers, and cash tender (4–5 days)

- **Contracts (`packages/commerce-contracts` & `packages/commerce-client`):**
  - Extend `PointOfSaleConfiguration` (`src/records/point-of-sale-configuration.ts`) with `catalogScope` (`supported_items` | `{ kind: "published_menu", menuId, maxQuantityPerLine }`) and `cashEnabled: boolean`.
  - Allow `terminalAssignmentRevision: number | null` when opening an in-person checkout on a cash-enabled counter without a terminal.
- **Quote & cash settlement (`services/commerce`):**
  - Update `planPointOfSaleQuote` (`src/commerce-authority/checkout-planning.ts`) to accept `food_service_menu_entry` lines and modifier option selections via `resolveCheckoutSelection` when `catalogScope.kind === "published_menu"`, enforcing `sold_out_today`, expired-lot exclusions, serving hours, and recipe ingredient holds.
  - Relax `placementTerminalId` (`src/commerce-authority/checkout-payment-planning.ts`) so `point_of_sale` cash orders place with `terminalId: null`.
  - Add `record_counter_cash_payment` (`POST /v1/admin/merchants/:merchantId/counter-sales/:checkoutId/cash-payment`, scope `orders:write`) recording `manual_tender` (`method: "cash"`, `cashReceivedMinor`, `changeDueMinor`), placing the `point_of_sale` Order with its `F-xxx` pickup code, and opening pickup fulfillment.
  - Update `services/commerce/docs/spec.md` in the same commit (`pnpm lint:commerce-spec`).
- **E2E proof:** `services/commerce/tests/counter-register-cash-journey.test.ts` (24-item pâtisserie menu, drink modifiers, `sold_out_today` refusal, included consumption tax, `¥2,000` cash tender with change, stock consumption on handover, and idempotent cash refund).

### Task 2 — Phase 2: `Café › Register` and Sous Chef basket staging (1–1.5 weeks)

- **Platform domain extraction (`services/platform`):**
  - Extract counter-sale logic out of `src/control/routes/counter-sale.ts` into `src/commerce/counter-register.ts` returning typed `Result` values (`pnpm lint:runtime-boundary`, `pnpm lint:file-size`).
  - Add `GET /v1/control/organisations/:id/commerce/counter-register` (menu sections, live availability, modifiers, counter policy, cash status, terminal readiness) and `POST …/counter-sales/:checkoutId/cash` (`operator`+).
- **Portal UI (`apps/portal`):**
  - Add `register` (`Café › Register`, `/register`, `operator`+) to `src/route.ts` and `src/pages.tsx` using `src/ui` components (`Select` with `items`, `SideDrawer`, `Popover`, `EmptyState`) and `controlRead` / `controlMutation` (`pnpm lint:portal-select`, `pnpm lint:portal-fetch`).
  - Support section tabs, touch item tiles, modifier drawer, quick JPY cash buttons (`Exact`, `¥1,000`, `¥5,000`, `¥10,000`) with change preview, terminal charge trigger, `F-xxx` pickup code with **Hand over now** / **Send to queue**, browser receipt print, and reload recovery.
  - Remove the admin-only two-item `CounterSaleOpenForm` from `src/features/terminals/route.tsx`.
- **Sous Chef chat & voice parity (Plans 81, 82, 87, 89):**
  - Add `counter_sale_read` (`commerce.order.read`) under `services/platform/src/agent-tools/` + `registry.ts`, and `register` screen surface commands (`register.add_item`, `register.update_line`, `register.remove_line`, `register.clear_basket`) in `apps/portal/src/features/bakery-surface-registry.ts`.
  - Keep money movement human-only: expose no agent tool that triggers terminal collection, records cash received, kicks a drawer, or runs an unapproved counter refund.
- **E2E proof:** `services/platform/tests/e2e/counter-register-journey.test.ts` + Playwright browser journey (`operator` stages via Sous Chef, pays cash, advances `Order queue`, `viewer` refused).

### Task 3 — Phase 3A: Square Terminal Japan cashless & FeliCa cash refunds (4–5 days)

- **Square multi-tender (`services/commerce/src/payments/square/square-payments.ts`):**
  - Add `paymentMethod: "card" | "felica" | "qr_code"` to `MerchantInPersonCollectionCommand`, sending `"CARD_PRESENT"`, `"FELICA_ALL"`, or `"QR_CODE"` to `POST /v2/terminals/checkouts`.
  - Update `#reconcileTerminal` to verify `GET /v2/payments/:id` across `CARD`, `FELICA` (`felica_details`), and `WALLET` (`wallet_details`), storing the verified sub-brand and marking `providerRefundable: false` on `FELICA`.
- **FeliCa refund accounting (`services/commerce`):**
  - Add `record_counter_manual_cash_refund` so refunding a `providerRefundable: false` order records a `manual_tender` cash refund outflow in `src/payments/position.ts` without calling Square's Refunds API (`REFUND_DECLINED`), preserving exact Square figures in `bank-payouts.ts`. Update `services/commerce/docs/spec.md`.
- **E2E & cost proof:** `services/commerce/tests/square-japan-tenders-journey.test.ts` and `pnpm --filter @seams/platform test:e2e tests/e2e/idle-tenant-cost.test.ts` (`0` idle rows written).

### Task 4 — Phase 4A: `gmo_stera` `lan_gateway` boundary & simulation (1 week)

- Add `provider: "gmo_stera"` (`transport: "lan_gateway"`, `gatewayId`, `deviceSourceKey`) to `InPersonPaymentBinding` (`packages/commerce-contracts/src/payment-binding.ts`) and `@seams/contracts` terminal assignments.
- Add `payment_terminal` reservation and `terminal_collect` / `terminal_cancel` / `terminal_inquire` / `terminal_result` messages to `packages/control-api/src/device-gateway.ts`, `DeviceFleetActor`, and `crates/shop-gateway` (`--simulate`), settling into `services/commerce` via `record_checkout_payment_capture` and `resolve_checkout_payment` (`payments:record`).
- Hold Phase 4B (real `stera` LAN CCT wire framing) until GMO-FG delivers the contracted specification.

### Task 5 — Phases 3C, 4B, and 5 (hardware-gated)

- **Phase 3C:** Live Japan Square Terminal pairing and certification ([Plan 33D](../history/plan-33D-square-release-acceptance.md)).
- **Phase 4B:** Physical `stera terminal` LAN driver and certification in `crates/shop-gateway` after GMO-FG spec delivery.
- **Phase 5:** Optional Star `MCP31LB` (`StarPRNT` 80 mm receipt print) and `mJ-Drawer` (`DK-Port` kick) tasks in `crates/shop-gateway`.

## Verification checklist for every PR in `pantry`

```bash
pnpm underclerk:check
pnpm underclerk:test
pnpm --filter @seams/platform check:types
pnpm --filter @seams/platform test
pnpm --filter @seams/platform test:e2e tests/e2e/idle-tenant-cost.test.ts
pnpm portal:build
cargo test --workspace
pnpm lint
git diff --check
```
