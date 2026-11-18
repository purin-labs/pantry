import {
  parseInventoryProductionCreation,
  parseInventoryProductionTransition,
  type InventoryProductionCreation,
  type InventoryProductionTransition,
} from "@seams/control-api";
import { isNormalizedText, isRecord } from "@seams/std";
import { parseEntityPlaneCommandResult } from "@seams/commerce-client";
import { ControlApiError } from "../../control-client";

type ProductionBody =
  InventoryProductionCreation | InventoryProductionTransition;
export type ProductionSubmission<T extends ProductionBody = ProductionBody> =
  Readonly<{
    idempotencyKey: string;
    body: T;
  }>;
export type ProductionSubmissionScope = Readonly<{
  userId: string;
  organisationId: string;
  kind: "create" | "transition";
  targetId: string;
}>;

export function readProductionSubmission(
  scope: ProductionSubmissionScope & { kind: "create" },
): ProductionSubmission<InventoryProductionCreation> | null;
export function readProductionSubmission(
  scope: ProductionSubmissionScope & { kind: "transition" },
): ProductionSubmission<InventoryProductionTransition> | null;
export function readProductionSubmission(
  scope: ProductionSubmissionScope,
): ProductionSubmission | null {
  const stored = sessionStorage.getItem(storageKey(scope));
  if (stored === null) return null;
  const raw: unknown = JSON.parse(stored);
  if (!isRecord(raw) || !isNormalizedText(raw.idempotencyKey))
    throw new Error(
      "The pending production update could not be restored. Keep this tab open and contact support.",
    );
  const body =
    scope.kind === "create"
      ? parseInventoryProductionCreation(raw.body)
      : parseInventoryProductionTransition(raw.body);
  const targetId = body.kind === "create" ? body.positionId : body.requestId;
  if (targetId !== scope.targetId)
    throw new Error("The pending production update does not match this item.");
  return { idempotencyKey: raw.idempotencyKey, body };
}

export function storeProductionSubmission(
  scope: ProductionSubmissionScope & { kind: "create" },
  submission: ProductionSubmission<InventoryProductionCreation>,
): void;
export function storeProductionSubmission(
  scope: ProductionSubmissionScope & { kind: "transition" },
  submission: ProductionSubmission<InventoryProductionTransition>,
): void;
export function storeProductionSubmission(
  scope: ProductionSubmissionScope,
  submission: ProductionSubmission,
): void {
  const encoded = JSON.stringify(submission);
  const key = storageKey(scope);
  sessionStorage.setItem(key, encoded);
  if (sessionStorage.getItem(key) !== encoded)
    throw new Error(
      "This browser could not save the production update for recovery. Enable tab storage before submitting.",
    );
}

export function clearProductionSubmission(
  scope: ProductionSubmissionScope,
): void {
  sessionStorage.removeItem(storageKey(scope));
}

export function productionFailure(error: unknown): "rejected" | "uncertain" {
  if (!(error instanceof ControlApiError) || !isRecord(error.details))
    return "uncertain";
  try {
    const result = parseEntityPlaneCommandResult(error.details.result);
    return result.status === "rejected" &&
      result.error.code !== "duplicate_identity"
      ? "rejected"
      : "uncertain";
  } catch {
    return "uncertain";
  }
}

export function productionReceipt(response: unknown): string {
  if (!isRecord(response) || response.ok !== true)
    throw new Error("The production receipt is unavailable.");
  const result = parseEntityPlaneCommandResult(response.result);
  if (
    result.status !== "accepted" ||
    result.receipt.target.kind !== "commerce_list_entry"
  )
    throw new Error("The production receipt is unavailable.");
  return result.receipt.target.entry.entryId;
}

function storageKey(scope: ProductionSubmissionScope): string {
  return `satyr:inventory-production:${JSON.stringify([scope.userId, scope.organisationId, scope.kind, scope.targetId])}`;
}
