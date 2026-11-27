# Devices — area guide

The device fleet of a shop: gateway enrollment, health, alerts and device access. Read [the
root guide](../../AGENTS.md) first; this file adds only what is
particular to this area.

- **Specs:** [DEV-01](../../docs/specs/areas/devices/01-devices.md) (Devices). A spec says
  what is built; change it in the same commit as the behavior.
- **Packages:** `@purin-labs/area-devices` (`server/` for the Worker, `ui/` for the Portal) and
  `@purin-labs/area-devices-contract` (`contract/`).
- **Agent tool families** (`server/agent-tools/`): `devices`.
- **Portal features** (`ui/features/`): `devices`.
- **Files, tables and public files:** `node scripts/check-layers.mjs --areas devices`, or
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

- A shop gateway dials out from `crates/shop-gateway`; `DeviceFleetActor` holds its socket.
- While the fleet Actor knows a gateway, its alarm wakes it one time a day (DEV-01). Before
  you add an alarm, a poll or a write on a heartbeat, calculate its cost for an idle
  Organisation, as the root guide says.
- The cobot bake path of [Plan 24](../../docs/plan-24-cafeos-bakery-automation.md) dispatches
  through this fleet. Its journeys need `MUJOCO_DIR`.
