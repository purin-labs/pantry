# Café — area guide

Menus, menu boards, the order queue and the counter Register. Read [the root
guide](../../AGENTS.md) first; this file adds only what is
particular to this area.

- **Specs:** [CAFE-01](../../docs/specs/areas/cafe/01-menus-boards-and-the-order-queue.md)
  (Menus, boards and the order queue). A spec says what is built; change it in the same commit
  as the behavior.
- **Packages:** `@purin-labs/area-cafe` (`server/` for the Worker, `ui/` for the Portal) and
  `@purin-labs/area-cafe-contract` (`contract/`).
- **Agent tool families** (`server/agent-tools/`): `commerce` (order queue, Register view),
  `drafts` (menu draft, menu boards).
- **Portal features** (`ui/features/`): `content-studio`, `menu-boards`, `order-queue`,
  `register`, `terminals`.
- **Files, tables and public files:** `node scripts/check-layers.mjs --areas cafe`, or
  [the layers page](../../docs/layers.md).

## Rules of the layers

- This area imports the foundation and the contract package of another area. It imports no
  surface and no file of another area. `pnpm lint:layers` refuses a new crossing.
- Another area or a surface reaches this area through `contract/`. A contract file imports no
  implementation file of this area as a value. Do not make an implementation file public to
  remove a crossing: write a port, and let the Worker wire it.
- Only the owner of a table writes it. A write to a table of another owner calls a function of
  that owner.
- `pnpm lint:layer-debts` counts the debts that stay. Its counts only go down.

## Particular to this area

- The Register and its payment adapters are [Plan
  90](../../docs/plan-90-cafe-pos-checkout.md). Its hardware checks wait for the devices of
  the shop.
- A menu board edit of an agent goes through the board chat port; the Portal shell registers
  the chat.
- A counter and a terminal read commerce through `@purin-labs/area-commerce-contract`.
