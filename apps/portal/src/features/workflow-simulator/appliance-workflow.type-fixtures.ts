import type {
  ApplianceAction,
  ApplianceProgram,
  ApplianceRequest,
  ApplianceResult,
} from "@seams/bakery-model/bakery-appliance-protocol";
import type {
  ApplianceOperation,
  ApplianceOperationState,
} from "@seams/bakery-model/bakery-appliance-workflow";

export function applianceStateFixtures(
  operation: ApplianceOperation,
  request: ApplianceRequest,
  result: ApplianceResult,
): void {
  // @ts-expect-error An interrupted operation has no accepted result.
  const interrupted: ApplianceOperationState = {
    kind: "interrupted",
    operation,
    start: 0,
    message: "Stopped",
    result,
  };
  const running = { kind: "running", operation, request, start: 0 } as const;
  // @ts-expect-error A broad spread cannot retain a request in an accepted state.
  const accepted: ApplianceOperationState = {
    ...running,
    kind: "accepted",
    result,
    end: 1,
  };
  // @ts-expect-error A pending operation cannot carry an accepted result.
  const pending = {
    kind: "pending",
    operation,
    result,
  } as ApplianceOperationState;
  // @ts-expect-error A held operation requires a result and elapsed simulation time.
  const held: ApplianceOperationState = {
    kind: "held",
    operation,
    start: 0,
    message: "Blocked",
  };
  void [interrupted, accepted, pending, held];
}

export function espressoActionFixtures(): void {
  // @ts-expect-error A steam command must select a group.
  const missingGroup: ApplianceAction = { kind: "steam", open: true };
  const conflicting = {
    kind: "steam",
    group: "left",
    open: true,
    position: "removed",
  } as const;
  // @ts-expect-error A broad spread cannot combine steam and portafilter commands.
  const mixedAction: ApplianceAction = { ...conflicting };
  // @ts-expect-error Hot water requires a bounded duration.
  const missingDuration: ApplianceProgram = { kind: "espresso-hot-water" };
  const shotFields = { group: "left", duration_s: 10 } as const;
  // @ts-expect-error Hot water cannot select a brew group through a spread.
  const mixedProgram: ApplianceProgram = {
    ...shotFields,
    kind: "espresso-hot-water",
  };
  // @ts-expect-error Each cup move requires an outlet.
  const missingOutlet: ApplianceAction = {
    kind: "move-cup",
    position: "removed",
  };
  // @ts-expect-error A programmed shot requires an exact dose slot.
  const missingSlot: ApplianceProgram = {
    kind: "espresso-shot-preset",
    group: "left",
  };
  void missingOutlet;
  void missingSlot;
  void missingDuration;
  void mixedProgram;
  void missingGroup;
  void mixedAction;
}
