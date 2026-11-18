import { isNormalizedText, isPositiveInteger, isRecord } from "@seams/std";
import {
  parseInventoryReconciliationChange,
  parseInventoryReconciliationTarget,
  parseMutationResult,
  type ReconcileCommerceInventoryV1,
} from "@seams/commerce-client";
import { ControlApiError } from "../../control-client";

export type ReconciliationScope = Readonly<{
  userId: string;
  organisationId: string;
  positionId: string;
  kind: "count" | "adjustment";
}>;
export type ReconciliationBody = Readonly<{
  merchantRevision: number;
  inventoryPositionId: string;
  inventoryPositionRevision: number;
  requestedAt: string;
  target: ReconcileCommerceInventoryV1["target"];
  change: ReconcileCommerceInventoryV1["change"];
}>;
export type ReconciliationSubmission = Readonly<{
  idempotencyKey: string;
  body: ReconciliationBody;
}>;

export function readReconciliationSubmission(
  scope: ReconciliationScope,
): ReconciliationSubmission | null {
  const stored = sessionStorage.getItem(storageKey(scope));
  if (stored === null) return null;
  const raw: unknown = JSON.parse(stored);
  if (
    !isRecord(raw) ||
    !isNormalizedText(raw.idempotencyKey) ||
    !isRecord(raw.body)
  )
    throw new Error(
      "The pending stock update could not be restored. Keep this tab open and contact support.",
    );
  const value = raw.body;
  if (
    !isPositiveInteger(value.merchantRevision) ||
    !isPositiveInteger(value.inventoryPositionRevision) ||
    value.inventoryPositionId !== scope.positionId ||
    !isNormalizedText(value.requestedAt) ||
    !Number.isFinite(Date.parse(value.requestedAt))
  )
    throw new Error(
      "The pending stock update is invalid. Keep this tab open and contact support.",
    );
  const change = parseInventoryReconciliationChange(value.change);
  if (change.kind !== scope.kind)
    throw new Error("The pending stock update does not match this operation.");
  return {
    idempotencyKey: raw.idempotencyKey,
    body: {
      merchantRevision: value.merchantRevision,
      inventoryPositionId: scope.positionId,
      inventoryPositionRevision: value.inventoryPositionRevision,
      requestedAt: value.requestedAt,
      target: parseInventoryReconciliationTarget(value.target),
      change,
    },
  };
}

export function storeReconciliationSubmission(
  scope: ReconciliationScope,
  submission: ReconciliationSubmission,
): void {
  const key = storageKey(scope);
  const encoded = JSON.stringify(submission);
  sessionStorage.setItem(key, encoded);
  if (sessionStorage.getItem(key) !== encoded)
    throw new Error(
      "This browser could not save the stock update for recovery. Enable tab storage before submitting.",
    );
}

export function clearReconciliationSubmission(
  scope: ReconciliationScope,
): void {
  sessionStorage.removeItem(storageKey(scope));
}

export function reconciliationFailure(
  error: unknown,
): Readonly<{ kind: "rejected" | "uncertain" }> {
  if (
    !(error instanceof ControlApiError) ||
    !isRecord(error.details) ||
    !isRecord(error.details.result)
  )
    return { kind: "uncertain" };
  try {
    const result = parseMutationResult(error.details.result);
    return {
      kind:
        result.outcome === "rejected" &&
        result.error.code !== "idempotency_conflict"
          ? "rejected"
          : "uncertain",
    };
  } catch {
    return { kind: "uncertain" };
  }
}

function storageKey(scope: ReconciliationScope): string {
  return `satyr:inventory-reconciliation:${JSON.stringify([scope.userId, scope.organisationId, scope.positionId, scope.kind])}`;
}
