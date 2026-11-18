// The four-order cold-cell scenarios of Plan 70 J2: `base` has one cell,
// and `scenario` adds a second cell that finishes each tray after a
// handoff. The two-cell journey and the phase 1 measurement use them.
import {
  coldCellJourneyAdapter,
  coldCellJourneySnapshot,
} from "../../packages/production-simulation/src/recipes/cold-cell-journey.ts";

function value(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Both scenarios for two parsed native cell definitions. */
export async function twoCellScenarios(firstCell, secondCell) {
  const base = value(
    coldCellJourneyAdapter.compile(
      await coldCellJourneySnapshot(
        {
          horizonSeconds: 600,
          orders: 4,
          trays: ["tray-a", "tray-b"],
          cell: {
            id: firstCell.cellId,
            modelHash: firstCell.modelHash,
            controllerSourceHash: firstCell.controllerSourceHash,
            timestepSeconds: 0.002,
            holdModel: "cold-cell-rest.1",
          },
          load: { pickupSeconds: 4, placementSeconds: 12, durationSeconds: 14 },
          unload: {
            pickupSeconds: 4,
            placementSeconds: 12,
            durationSeconds: 14,
          },
        },
        1,
      ),
    ),
  );
  const scenario = structuredClone(base);
  scenario.id = "plan-70-two-cell-journey";
  scenario.resources.push({
    kind: "capacity",
    id: "finishing-arm",
    capacity: 1,
    configuration: null,
  });
  scenario.cells.push({
    id: secondCell.cellId,
    modelHash: secondCell.modelHash,
    controllerSourceHash: secondCell.controllerSourceHash,
    timestepMicroseconds: 2000,
    carrierSlots: 1,
    holdModel: "cold-cell-rest.1",
  });
  scenario.storages.push(
    {
      id: "second-table",
      capacity: { kind: "carriers", slots: 1 },
      cell: secondCell.cellId,
    },
    {
      id: "second-rack",
      capacity: { kind: "carriers", slots: 1 },
      cell: secondCell.cellId,
    },
  );
  const [load, transfer, unload] = scenario.workflows[0].tasks;
  const handoff = structuredClone(unload);
  handoff.key = "handoff";
  handoff.inputs = [];
  handoff.outputs = [];
  handoff.carriers = [{ ...handoff.carriers[0], to: "second-table" }];
  const finish = structuredClone(transfer);
  finish.key = "finish";
  finish.prerequisites = ["handoff"];
  finish.claims[0].resource = "finishing-arm";
  finish.executor.operation.cell = secondCell.cellId;
  finish.executor.operation.parameters = secondCell.modelHash;
  finish.carriers[0].from = "second-table";
  finish.carriers[0].to = "second-rack";
  // A declared rack wait makes the downstream slot stay occupied long enough
  // to block the next handoff. The arm remains a real, evolving/qualified cell.
  const rackWait = {
    key: "rack-wait",
    priority: 0,
    releaseAfter: 0,
    prerequisites: ["finish"],
    claims: [],
    executor: { kind: "declared", duration: 30_000_000, evidence: "assumed" },
    inputs: [],
    outputs: [],
    releases: [],
    carriers: [],
  };
  unload.prerequisites = ["rack-wait"];
  unload.carriers[0].from = "second-rack";
  unload.carriers[0].to = "tray-store";
  scenario.workflows[0].tasks = [
    load,
    transfer,
    handoff,
    finish,
    rackWait,
    unload,
  ];
  return { base, scenario };
}
