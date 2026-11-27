# Integrations — area guide

Provider connections, custom connectors, the Jev feature switches, the Vault pages and the
Shopify module. Read [the root guide](../../AGENTS.md) first; this file adds only what is
particular to this area.

- **Specs:** [INT-01](../../docs/specs/areas/integrations/01-integrations-and-connectors.md)
  (Integrations and connectors). A spec says what is built; change it in the same commit as
  the behavior.
- **Packages:** `@purin-labs/area-integrations` (`server/` for the Worker, `ui/` for the
  Portal) and
  `@purin-labs/area-integrations-contract` (`contract/`).
- **Agent tool families** (`server/agent-tools/`): `integrations`, `jev`.
- **Portal features** (`ui/features/`): `integrations`, `jev-features`, `vault`.
- **Files, tables and public files:** `node scripts/check-layers.mjs --areas integrations`, or
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

- The connection records (accounts, connections, credential generations) belong to
  `foundation/connections`. This area holds the provider catalogue and the workflows on top of
  them.
- All Shopify code is in `shopify/`. [`shopify/REMOVE.md`](shopify/REMOVE.md) lists what a
  removal deletes. Keep that list true.
- A provider callback path and a Worker name do not change with a folder move.
