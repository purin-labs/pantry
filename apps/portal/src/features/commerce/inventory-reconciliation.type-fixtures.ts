import type { InventoryReceiptContext } from "@purin-labs/control-api";
import type { ReconciliationState } from "./inventory-reconciliation";
import type { ReconciliationSubmission } from "./inventory-reconciliation-submission";
import type { Variant } from "@purin-labs/type-utils";

declare const context: InventoryReceiptContext;
declare const submission: ReconciliationSubmission;
declare const draft: Variant<
  ReconciliationState,
  "editing" | "refreshing"
>["draft"];

// @ts-expect-error An unknown outcome must retain the exact submission.
export const missingSubmission: ReconciliationState = {
  kind: "uncertain",
  context,
  draft,
  message: null,
};

// @ts-expect-error Editing cannot coexist with an unresolved submission.
export const editablePendingSubmission: ReconciliationState = {
  kind: "editing",
  context,
  draft,
  message: null,
  submission,
};

declare const pending: Variant<ReconciliationState, "saving" | "uncertain">;
// @ts-expect-error A broad spread cannot turn an unresolved submission into an editable draft.
export const spreadPendingSubmission: ReconciliationState = {
  ...pending,
  kind: "editing",
};
