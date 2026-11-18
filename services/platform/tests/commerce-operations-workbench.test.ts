import { parseCommerceGraphResponse } from "@seams/commerce-client";
import type { CommerceEntity, CommerceFreshness } from "@seams/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveMissingTrackingExceptions,
  parseTrackingBatchPreviewRequest,
  previewTrackingBatch,
} from "../src/commerce/operations-workbench";
import type { CommerceExceptionInbox } from "@seams/control-api";

const OBSERVED_AT = "2026-08-29T00:00:00.000Z";
const EXPECTED_BY = "2026-08-30T03:00:00.000Z";
const MERCHANT_ID = "merchant_operations";
const EXCEPTION_ID =
  "missing_tracking:underclerk%3Amerchant_operations%3Afulfillment_1:underclerk%3Amerchant_operations%3Ashipment_1";

describe("commerce operations workbench", () => {
  it("derives one current missing-tracking exception and closes it from the fulfillment fact", () => {
    const fulfillment = fulfillmentEntity("requested", 4);
    const shipment = shipmentEntity(7);

    expect(
      deriveMissingTrackingExceptions({
        merchantId: MERCHANT_ID,
        merchantRevision: 12,
        fulfillments: [fulfillment],
        shipments: [shipment, shipment],
      }),
    ).toEqual([
      {
        kind: "missing_tracking",
        exceptionId: EXCEPTION_ID,
        reason:
          "This fulfillment has a shipping label and is waiting for its tracking reference to be attached.",
        owner: { kind: "unassigned" },
        dueAt: EXPECTED_BY,
        recommendedAction: {
          kind: "attach_tracking",
          label: "Attach tracking",
        },
        resolution: {
          kind: "fulfillment_lifecycle",
          expectedState: "handed_to_carrier",
        },
        target: {
          merchantRevision: 12,
          orderId: "underclerk:merchant_operations:order_1",
          fulfillmentId: "underclerk:merchant_operations:fulfillment_1",
          fulfillmentRevision: 4,
          shipmentId: "underclerk:merchant_operations:shipment_1",
          shipmentRevision: 7,
          trackingNumber: "JP123456789",
        },
        freshness: "current",
      },
    ]);

    expect(
      deriveMissingTrackingExceptions({
        merchantId: MERCHANT_ID,
        merchantRevision: 13,
        fulfillments: [fulfillmentEntity("handed_to_carrier", 5)],
        shipments: [shipmentEntity(8)],
      }),
    ).toEqual([]);
    expect(
      deriveMissingTrackingExceptions({
        merchantId: MERCHANT_ID,
        merchantRevision: 12,
        fulfillments: [fulfillment],
        shipments: [
          shipmentEntity(7, {
            state: "stale",
            observedAt: OBSERVED_AT,
            staleSince: OBSERVED_AT,
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("freezes exact targets, rejects closed selections, and changes identity with revisions", async () => {
    const current = readyInbox(4, 7, 12);
    const request = parseTrackingBatchPreviewRequest({
      exceptionIds: [EXCEPTION_ID, "missing_tracking:closed:shipment"],
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;

    const first = await previewTrackingBatch(
      current,
      request.value,
      Date.parse(OBSERVED_AT),
    );
    const replay = await previewTrackingBatch(
      current,
      request.value,
      Date.parse(EXPECTED_BY),
    );
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(first.value.batchId).toBe(replay.value.batchId);
    expect(first.value.items).toMatchObject([
      {
        validation: { kind: "valid" },
        action: {
          kind: "attach_tracking",
          fulfillmentRevision: 4,
          shipmentRevision: 7,
          merchantRevision: 12,
        },
      },
      {
        validation: { kind: "invalid", reason: "closed_or_changed" },
        action: null,
      },
    ]);

    const changed = await previewTrackingBatch(
      readyInbox(5, 8, 13),
      request.value,
      Date.parse(OBSERVED_AT),
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.batchId).not.toBe(first.value.batchId);
    expect(changed.value.items[0]).toMatchObject({
      action: {
        fulfillmentRevision: 5,
        shipmentRevision: 8,
        merchantRevision: 13,
      },
    });
  });

  it("rejects empty, duplicate, oversized, and malformed preview selections", () => {
    expect(
      parseTrackingBatchPreviewRequest({ exceptionIds: [] }),
    ).toMatchObject({ ok: false });
    expect(
      parseTrackingBatchPreviewRequest({
        exceptionIds: [
          "missing_tracking:fulfillment_1:shipment_1",
          "missing_tracking:fulfillment_1:shipment_1",
        ],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseTrackingBatchPreviewRequest({
        exceptionIds: Array.from({ length: 51 }, exceptionIdAt),
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseTrackingBatchPreviewRequest({ exceptionIds: ["fulfillment_1"] }),
    ).toMatchObject({ ok: false });
  });
});

function readyInbox(
  fulfillmentRevision: number,
  shipmentRevision: number,
  merchantRevision: number,
): CommerceExceptionInbox {
  return {
    kind: "ready",
    observedAt: OBSERVED_AT,
    items: deriveMissingTrackingExceptions({
      merchantId: MERCHANT_ID,
      merchantRevision,
      fulfillments: [fulfillmentEntity("requested", fulfillmentRevision)],
      shipments: [shipmentEntity(shipmentRevision)],
    }),
  };
}

function fulfillmentEntity(
  lifecycle: "requested" | "handed_to_carrier",
  revision: number,
): CommerceEntity {
  return parsedEntity({
    reference: {
      origin: "system",
      typeId: "fulfillment",
      entityId: "fulfillment_1",
    },
    revision,
    displayName: "Fulfillment 1",
    attributes: [
      systemAttribute("fulfillment", "lifecycle", {
        kind: "status",
        value: lifecycle,
      }),
      systemAttribute("fulfillment", "order_id", {
        kind: "short_text",
        value: "order_1",
      }),
      systemAttribute("fulfillment", "expected_by", {
        kind: "timestamp",
        value: EXPECTED_BY,
      }),
    ],
    provenance: provenance("fulfillment", "fulfillment_1", revision),
    freshness: { state: "current", observedAt: OBSERVED_AT },
  });
}

function shipmentEntity(
  revision: number,
  freshness: CommerceFreshness = { state: "current", observedAt: OBSERVED_AT },
): CommerceEntity {
  return parsedEntity({
    reference: { origin: "system", typeId: "shipment", entityId: "shipment_1" },
    revision,
    displayName: "Shipment 1",
    attributes: [
      systemAttribute("shipment", "lifecycle", {
        kind: "status",
        value: "label_purchased",
      }),
      systemAttribute("shipment", "order_id", {
        kind: "short_text",
        value: "order_1",
      }),
      systemAttribute("shipment", "fulfillment_id", {
        kind: "short_text",
        value: "fulfillment_1",
      }),
      systemAttribute("shipment", "tracking_number", {
        kind: "short_text",
        value: "JP123456789",
      }),
    ],
    provenance: provenance("shipment", "shipment_1", revision),
    freshness,
  });
}

function parsedEntity(value: unknown): CommerceEntity {
  const response = parseCommerceGraphResponse({
    merchantRevision: 1,
    entities: [value],
    relationships: [],
    listEntries: [],
    aggregations: [],
    nextCursor: null,
    provenance: [],
    freshness: [],
  });
  const entity = response.entities[0];
  if (entity === undefined)
    throw new Error("Commerce entity fixture was not parsed");
  return entity;
}

function systemAttribute(
  typeId: "fulfillment" | "shipment",
  attributeId: string,
  value: Readonly<{
    kind: "status" | "short_text" | "timestamp";
    value: string;
  }>,
): unknown {
  return {
    attributeId,
    scope: { kind: "system", entityTypeId: typeId, schemaRevision: 1 },
    definitionRevision: 1,
    sensitivity: "internal",
    value,
  };
}

function provenance(
  resourceType: "fulfillment" | "shipment",
  resourceId: string,
  revision: number,
): unknown {
  return {
    organisationId: "organisation_operations",
    integrationAccountId: "integration_underclerk",
    source: "underclerk",
    resourceType,
    resourceId,
    revision,
    occurredAt: OBSERVED_AT,
    observedAt: OBSERVED_AT,
  };
}

function exceptionIdAt(_value: unknown, index: number): string {
  return `missing_tracking:fulfillment_${index}:shipment_${index}`;
}
