# Brain — area guide

Memory, Evals and the inspection of Case execution. Read [the root guide](../../AGENTS.md)
first; this file adds only what is
particular to this area.

- **Specs:** [BRN-01](../../docs/specs/areas/brain/01-brain.md) (Brain). A spec says what is
  built; change it in the same commit as the behavior.
- **Packages:** `@purin-labs/area-brain` (`server/` for the Worker, `ui/` for the Portal) and
  `@purin-labs/area-brain-contract` (`contract/`).
- **Agent tool families** (`server/agent-tools/`): none.
- **Portal features** (`ui/features/`): `brain`.
- **Files, tables and public files:** `node scripts/check-layers.mjs --areas brain`, or
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

- The Memory store (`server/memory/store.ts`) is the only code that makes a Memory revision.
  `server/memory/access.ts` stays private: another area reads Memory through the Memory
  service of the contract.
- The Inbox reads Memory through that service, and the Worker wires it. Do not import an Inbox
  file here.
