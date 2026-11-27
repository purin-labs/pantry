# Organisation — area guide

Onboarding and the lifecycle of an Organisation, the access pages, billing, operators and Jev
from Purin. Read [the root guide](../../AGENTS.md) first; this file adds only what is
particular to this area.

- **Specs:** [ORG-01](../../docs/specs/areas/organisation/01-onboarding-and-lifecycle.md)
  (Onboarding and lifecycle),
  [ORG-02](../../docs/specs/areas/organisation/02-jev-from-purin.md) (Jev from Purin). A spec
  says what is built; change it in the same commit as the behavior.
- **Packages:** `@purin-labs/area-organisation` (`server/` for the Worker, `ui/` for the
  Portal) and
  `@purin-labs/area-organisation-contract` (`contract/`).
- **Agent tool families** (`server/agent-tools/`): `organisation`.
- **Portal features** (`ui/features/`): `access`, `agent-schedules`, `billing`.
- **Files, tables and public files:** `node scripts/check-layers.mjs --areas organisation`, or
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

- The Organisation record, its placement and its lifecycle batches belong to
  `foundation/tenancy`. A table owner gives its statements to a lifecycle batch through the
  lifecycle port; do not write a table of another owner here.
- The onboarding activation is its own module of `OrganisationDO`.
- After a change to onboarding or to a lifecycle, run `pnpm --filter @purin-labs/platform
test:onboarding-closure`.
