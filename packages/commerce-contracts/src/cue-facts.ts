import { isRecord } from "@purin-labs/std";
import {
  CommerceRejection,
  currencyCode,
  resourceId,
} from "./commerce-canonical.ts";
import type { CommerceBoundaryResponse } from "./commerce-boundary.ts";
import { asI64, asU64 } from "./serde-input.ts";
import type { CommerceCueFact } from "./records/transitions.ts";

/**
 * Plan 78: the `deriveCueFacts` Wasm export. It reads a stored projection as
 * JSON, so a missing or mistyped member is `invalid_projection`, not a serde
 * error, and identities keep their validation error.
 */
export function deriveCueFacts(projection: unknown): CommerceBoundaryResponse {
  try {
    return { status: "ok", value: cueFacts(projection) };
  } catch (error) {
    if (error instanceof ProjectionRejection)
      return { status: "error", error: { code: "invalid_projection" } };
    if (error instanceof CommerceRejection)
      return { status: "error", error: error.error };
    throw error;
  }
}

class ProjectionRejection extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new ProjectionRejection();
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new ProjectionRejection();
  return value;
}

function cueFacts(projection: unknown): CommerceCueFact[] {
  const record = object(projection);
  const body = object(record.projection);
  const provenance = object(body.provenance);
  const kind = string(record.kind);
  string(provenance.organisationId);
  string(provenance.integrationAccountId);
  string(provenance.resourceType);
  string(provenance.resourceId);
  if (asU64(provenance.revision) === null) throw new ProjectionRejection();
  switch (kind) {
    case "payment":
      return paymentFact(body);
    case "shipment":
      return shipmentFact(body);
    default:
      return [];
  }
}

function paymentFact(body: Record<string, unknown>): CommerceCueFact[] {
  const lifecycle = object(body.lifecycle);
  if (string(lifecycle.state) !== "failed") return [];
  const amount = object(body.amount);
  const provenance = object(body.provenance);
  const orderId = resourceId(string(body.orderId));
  const paymentId = resourceId(string(provenance.resourceId));
  const amountMinor = asI64(amount.amountMinor);
  if (amountMinor === null) throw new ProjectionRejection();
  const currency = currencyCode(string(amount.currency));
  return [
    {
      kind: "payment_failed",
      orderId,
      paymentId,
      amountMinor,
      currency,
      reason: string(lifecycle.reason),
    },
  ];
}

function shipmentFact(body: Record<string, unknown>): CommerceCueFact[] {
  const lifecycle = object(body.lifecycle);
  if (string(lifecycle.state) !== "delivery_exception") return [];
  const provenance = object(body.provenance);
  const orderId = resourceId(string(body.orderId));
  const shipmentId = resourceId(string(provenance.resourceId));
  return [
    {
      kind: "delivery_exception",
      orderId,
      shipmentId,
      trackingNumber: string(body.trackingNumber),
      status: "delivery_exception",
      reason: string(lifecycle.reason),
    },
  ];
}
