import type { CycleInput, TransferInput } from "./workcell-input.ts";
import type { CompletedAttempt, HeldAttempt } from "./workcell-attempt.ts";

declare const cycle: CycleInput;
declare const transfer: TransferInput;
declare const complete: VariantBy<CompletedAttempt, "mode", "oven-cycle">;
declare const loaded: VariantBy<CompletedAttempt, "mode", "transfer">;
declare const failed: VariantBy<HeldAttempt, "mode", "cycle-loading-failed">;

// @ts-expect-error A transfer cannot inherit a cycle's return identity through a broad spread.
const mixed: TransferInput = {
  ...cycle,
  kind: "transfer",
  request: transfer.request,
};
// @ts-expect-error A cycle requires its pinned return request and handoff.
const partial: CycleInput = { ...transfer, kind: "oven-cycle" };
// @ts-expect-error Raw cycle inputs must be built at the compilation boundary.
const uncompiled: CycleInput = {
  kind: "oven-cycle",
  source: "local-simulation",
  taskInstanceId: cycle.taskInstanceId,
  dispatch: { kind: "scheduled", time: 0 },
  request: cycle.request,
  returnTaskInstanceId: cycle.returnTaskInstanceId,
  returnRequest: cycle.returnRequest,
  handoffDigest: cycle.handoffDigest,
  bindings: cycle.bindings,
};
// @ts-expect-error Successful return requires table occupancy and an available oven shelf.
const wrongDestination: CompletedAttempt = {
  ...complete,
  resources: loaded.resources,
};
// @ts-expect-error Failed loading cannot become a completed cycle through a spread.
const premature: CompletedAttempt = {
  ...failed,
  kind: "completed",
  resources: complete.resources,
};
// @ts-expect-error A cycle's identities cannot be supplied by casting a single transfer.
const cast = transfer as CycleInput;

void [mixed, partial, uncompiled, wrongDestination, premature, cast];

import type { AwaitingReturnAttempt } from "./workcell-attempt.ts";
import type { VariantBy } from "@seams/type-utils";
declare const prefix: AwaitingReturnAttempt;
const prematureSettlement: AwaitingReturnAttempt = {
  ...prefix,
  // @ts-expect-error An accepted loading prefix cannot acquire a whole-cycle settlement.
  settledTime: 40,
};
// @ts-expect-error A pending return cannot turn into a completed cycle via a cast.
const falseCompletion = prefix as CompletedAttempt;
const mixedPrefix: AwaitingReturnAttempt = {
  ...prefix,
  // @ts-expect-error Loading evidence cannot be replaced by an entire sequence in the pending branch.
  recording: complete.recording,
};
const failedPrefix: AwaitingReturnAttempt = {
  ...prefix,
  // @ts-expect-error A failed loading record cannot be retained as a successful prefix.
  recording: failed.recording,
};
// @ts-expect-error The lifecycle brand prevents constructing a prefix directly.
const directPrefix: AwaitingReturnAttempt = {
  kind: "awaiting-return",
  mode: "cycle-loading",
  input: prefix.input,
  recording: prefix.recording,
  loadingCompletedTime: 40,
  resources: prefix.resources,
};
void [
  prematureSettlement,
  falseCompletion,
  mixedPrefix,
  failedPrefix,
  directPrefix,
];
