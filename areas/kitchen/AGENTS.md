# Kitchen — area guide

Production orchestration: the workflow canvas, the resource timeline, the 3D bakery, recipes,
bakes, and Costs & margins. Read [the root guide](../../AGENTS.md) first; this file adds only
what is
particular to this area.

- **Specs:** [KIT-01](../../docs/specs/areas/kitchen/01-orchestration-views.md) (Orchestration
  views), [KIT-02](../../docs/specs/areas/kitchen/02-physics-and-equipment-models.md) (Physics
  and equipment models), [KIT-03](../../docs/specs/areas/kitchen/03-recipe-workflows.md)
  (Recipe workflows), [KIT-04](../../docs/specs/areas/kitchen/04-costs-and-margins.md) (Costs
  and margins). A spec says what is built; change it in the same commit as the behavior.
- **Packages:** `@purin-labs/area-kitchen` (`server/` for the Worker, `ui/` for the Portal) and
  `@purin-labs/area-kitchen-contract` (`contract/`).
- **Agent tool families** (`server/agent-tools/`): `bakery`, `costs`, `kitchen`.
- **Portal features** (`ui/features/`): `bakes`, `costs`, `production-run`, `recipes`,
  `workflow-simulator`.
- **Files, tables and public files:** `node scripts/check-layers.mjs --areas kitchen`, or
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

- The engine and model packages (`packages/bakery-model`, `packages/bakery-workflow`,
  `packages/production-simulation`) name no browser global, so a server run stays possible
  (`pnpm lint:kitchen-dom`).
- The models and the physics bundles that no pin names live in R2. Run `node
scripts/repo-binaries.mjs fetch` before a Portal build or a Kitchen journey.
- The cobot journeys of [Plan 24](../../docs/plan-24-cafeos-bakery-automation.md) need
  `MUJOCO_DIR` (see the Testing part of the root guide).
- Kitchen reads commerce records through `@purin-labs/area-commerce-contract`.
