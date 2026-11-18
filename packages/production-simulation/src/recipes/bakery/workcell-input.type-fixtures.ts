import { COLD_CELL, type CapabilityBinding } from "./workcell-instances.ts";
import type { PhysicsRequest } from "@seams/bakery-model/bakery-physics";
import {
  compileWorkcellInput,
  type CycleInput,
  type NativeCycleInput,
  type WorkcellInput,
  type WorkcellInputResult,
} from "./workcell-input.ts";
import type { VariantBy } from "@seams/type-utils";

declare const input: WorkcellInput;
declare const rackInput: Extract<
  WorkcellInput,
  { request: { bakeryTaskId: "table-to-rack" } }
>;
declare const ovenInput: Extract<
  WorkcellInput,
  { request: { bakeryTaskId: "table-to-oven" } }
>;
declare const oven: VariantBy<PhysicsRequest, "bakeryTaskId", "table-to-oven">;
declare const rawRequest: Omit<PhysicsRequest, symbol>;

// @ts-expect-error Direct construction requires the private compiler brand.
const direct: WorkcellInput = {
  source: "local-simulation",
  taskInstanceId: "cold-tray:test:transfer-1",
  request: input.request,
  dispatch: { kind: "scheduled", time: 0 },
  bindings: input.bindings,
};
// @ts-expect-error Native oven evidence cannot become a cold rack assignment by spreading.
const wrongSkill: WorkcellInput = { ...rackInput, request: oven };
// @ts-expect-error A compiled oven request cannot retain the rack destination.
const crossedBindings: WorkcellInput = {
  ...ovenInput,
  bindings: rackInput.bindings,
};
const wrongArm: WorkcellInput = {
  ...input,
  // @ts-expect-error A different executor requires a supported compiled capability.
  bindings: { ...input.bindings, arm: "mobile-carrier-1" },
};
// @ts-expect-error Rejected inputs cannot carry executable state.
const mixed: WorkcellInputResult = {
  kind: "invalid",
  field: "dispatchTime",
  message: "invalid",
  input,
};
// @ts-expect-error Raw requests must pass the existing native request parser.
compileWorkcellInput(rawRequest, "0", "cold-cell-1");
// @ts-expect-error Compiled dispatch inputs are immutable.
input.dispatch.time = 1;

void [direct, wrongSkill, crossedBindings, wrongArm, mixed];

declare const requestFirst: NativeCycleInput;
declare const pinned: CycleInput;
const forgedHandoff: NativeCycleInput = {
  ...requestFirst,
  // @ts-expect-error A request-first cycle has no pre-execution handoff identity.
  handoffDigest: pinned.handoffDigest,
};
// @ts-expect-error A request-first input cannot become a pinned cycle via an unsafe cast.
const cast = requestFirst as CycleInput;
// @ts-expect-error Native dispatch is scheduled; there is no blocked dispatch.
const blockedDispatch: WorkcellInput["dispatch"] = { kind: "blocked" };
void [forgedHandoff, cast, blockedDispatch];

// @ts-expect-error A cell cannot claim another cell's arm through a spread.
const mixedCell: CapabilityBinding = {
  ...COLD_CELL.skills["table-to-rack"],
  cell: "cold-cell-2",
};
void mixedCell;
