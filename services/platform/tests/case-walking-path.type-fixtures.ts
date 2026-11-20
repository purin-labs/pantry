import type { CaseWalkingPathError } from "../src/actors/case-walking-path";
import type { ConnectorCaseTurnStreamError } from "../src/actors/case-turn-stream";

export function checkFailureTypes(): void {
  // @ts-expect-error A diagnostic string alone cannot determine retry behavior.
  const untyped: CaseWalkingPathError = {
    code: "session_stream:embedded_harness_history_failed",
  };
  // @ts-expect-error History failures require an origin.
  const missingSource: CaseWalkingPathError = {
    kind: "history_corruption",
    code: "embedded_harness_history_failed",
  };
  // @ts-expect-error History failure codes are checked literals.
  const typo: ConnectorCaseTurnStreamError = {
    kind: "history_corruption",
    code: "embedded_harness_history_faild",
  };
  const history = {
    kind: "history_corruption",
    source: "session_stream",
    code: "embedded_harness_history_failed",
  } as const;
  // @ts-expect-error Changing the discriminator cannot retain another branch's fields.
  const mixed: CaseWalkingPathError = { ...history, kind: "operational" };
  const pending = {
    kind: "usage_pending",
    code: "session_turn:budget_reservation_indeterminate",
  } as const;
  // @ts-expect-error Pending usage cannot carry a history origin.
  const pendingWithSource: CaseWalkingPathError = {
    ...pending,
    source: "session_turn",
  };
  // @ts-expect-error Pending usage requires its checked failure code.
  const pendingWithTypo: CaseWalkingPathError = {
    kind: "usage_pending",
    code: "session_turn:budget_reservation_indeterminant",
  };
  void [
    untyped,
    missingSource,
    typo,
    mixed,
    pendingWithSource,
    pendingWithTypo,
  ];
}
