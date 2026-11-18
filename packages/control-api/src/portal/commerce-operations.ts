import type {
  CommerceExceptionInbox,
  MissingTrackingException,
  TrackingActionTarget,
  TrackingBatchPreview,
  TrackingBatchPreviewItem,
} from "../index.ts";

export function parseCommerceExceptionInbox(
  value: unknown,
): CommerceExceptionInbox {
  const object = record(value, "commerceExceptions");
  if (object.kind === "unavailable") {
    const reason = enumValue(
      object.reason,
      [
        "commerce_system_unavailable",
        "resolution_unsupported",
        "entity_plane_unavailable",
      ] as const,
      "commerceExceptions.reason",
    );
    return { kind: "unavailable", reason };
  }
  if (object.kind !== "ready" || !Array.isArray(object.items)) {
    throw new Error("commerceExceptions is invalid");
  }
  return {
    kind: "ready",
    observedAt: timestamp(object.observedAt, "commerceExceptions.observedAt"),
    items: object.items.map(parseMissingTrackingException),
  };
}

export function parseTrackingBatchPreviewResponse(
  value: unknown,
): TrackingBatchPreview {
  const response = record(value, "response");
  if (response.ok !== true)
    throw new Error("Tracking batch preview was rejected");
  const preview = record(response.preview, "preview");
  if (
    preview.kind !== "tracking_batch_preview" ||
    !Array.isArray(preview.items)
  ) {
    throw new Error("Tracking batch preview is invalid");
  }
  const batchId = trackingBatchId(preview.batchId, "preview.batchId");
  return {
    kind: "tracking_batch_preview",
    batchId,
    frozenAt: timestamp(preview.frozenAt, "preview.frozenAt"),
    items: preview.items.map((item) => parseTrackingBatchItem(item, batchId)),
  };
}

function parseMissingTrackingException(
  value: unknown,
): MissingTrackingException {
  const object = record(value, "exception");
  const owner = record(object.owner, "exception.owner");
  const recommendedAction = record(
    object.recommendedAction,
    "exception.recommendedAction",
  );
  const resolution = record(object.resolution, "exception.resolution");
  if (
    object.kind !== "missing_tracking" ||
    owner.kind !== "unassigned" ||
    recommendedAction.kind !== "attach_tracking" ||
    recommendedAction.label !== "Attach tracking" ||
    resolution.kind !== "fulfillment_lifecycle" ||
    resolution.expectedState !== "handed_to_carrier" ||
    object.freshness !== "current"
  ) {
    throw new Error("Missing-tracking exception is invalid");
  }
  return {
    kind: "missing_tracking",
    exceptionId: text(object.exceptionId, "exception.exceptionId"),
    reason: text(object.reason, "exception.reason"),
    owner: { kind: "unassigned" },
    dueAt: timestamp(object.dueAt, "exception.dueAt"),
    recommendedAction: { kind: "attach_tracking", label: "Attach tracking" },
    resolution: {
      kind: "fulfillment_lifecycle",
      expectedState: "handed_to_carrier",
    },
    target: parseTrackingTarget(object.target, "exception.target"),
    freshness: "current",
  };
}

function parseTrackingBatchItem(
  value: unknown,
  batchId: string,
): TrackingBatchPreviewItem {
  const object = record(value, "preview.item");
  const validation = record(object.validation, "preview.item.validation");
  const exceptionId = text(object.exceptionId, "preview.item.exceptionId");
  if (
    validation.kind === "invalid" &&
    validation.reason === "closed_or_changed" &&
    object.action === null
  ) {
    return {
      exceptionId,
      validation: { kind: "invalid", reason: "closed_or_changed" },
      action: null,
    };
  }
  if (validation.kind !== "valid")
    throw new Error("Tracking batch item validation is invalid");
  const action = record(object.action, "preview.item.action");
  if (
    action.kind !== "attach_tracking" ||
    trackingBatchId(action.batchId, "preview.item.action.batchId") !== batchId
  ) {
    throw new Error("Tracking batch action is invalid");
  }
  return {
    exceptionId,
    validation: { kind: "valid" },
    action: {
      kind: "attach_tracking",
      batchId,
      ...parseTrackingTarget(action, "preview.item.action"),
    },
  };
}

function parseTrackingTarget(
  value: unknown,
  field: string,
): TrackingActionTarget {
  const object = record(value, field);
  return {
    merchantRevision: positiveInteger(
      object.merchantRevision,
      `${field}.merchantRevision`,
    ),
    orderId: text(object.orderId, `${field}.orderId`),
    fulfillmentId: text(object.fulfillmentId, `${field}.fulfillmentId`),
    fulfillmentRevision: positiveInteger(
      object.fulfillmentRevision,
      `${field}.fulfillmentRevision`,
    ),
    shipmentId: text(object.shipmentId, `${field}.shipmentId`),
    shipmentRevision: positiveInteger(
      object.shipmentRevision,
      `${field}.shipmentRevision`,
    ),
    trackingNumber: text(object.trackingNumber, `${field}.trackingNumber`),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${field} must be text`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${field} must be a positive integer`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (Number.isNaN(Date.parse(parsed)))
    throw new Error(`${field} must be a timestamp`);
  return parsed;
}

function trackingBatchId(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!/^tracking_batch_[0-9a-f]{64}$/u.test(parsed))
    throw new Error(`${field} must be a tracking batch ID`);
  return parsed;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new Error(`${field} is invalid`);
  return value as Values[number];
}
