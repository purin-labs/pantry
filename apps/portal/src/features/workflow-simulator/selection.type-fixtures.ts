import type { Selection, WorkcellSelection } from "@purin-labs/production-simulation/simulator/selection";

const task: Selection = { kind: "task", id: "batch:A:process:bake" };
const worker: Selection = { kind: "resource", id: "human-1" };
// @ts-expect-error Task selection requires a task identity.
const invalidTask: Selection = { kind: "task", id: "human-1" };
// @ts-expect-error Resource identity cannot be combined with a task discriminant.
const invalidSpread: Selection = { ...worker, kind: "task" };
// @ts-expect-error Financier resource selection requires a human identity.
const invalidResource: Selection = { kind: "resource", id: "fr10-1" };
// @ts-expect-error A task identity is required.
const missingIdentity: Selection = { kind: "task" };
// @ts-expect-error Workcell and financier task selections have distinct identities.
const crossRun: WorkcellSelection = task;

void invalidTask;
void invalidSpread;
void invalidResource;
void missingIdentity;
void crossRun;
