import { describe, expect, it } from "vitest";

import { parseCommerceExceptionInbox, parseTrackingBatchPreviewResponse } from "@purin-labs/control-api/portal/commerce-operations";
import type { MissingTrackingException } from "@purin-labs/control-api";

const BATCH_ID = `tracking_batch_${"a".repeat(64)}`;

describe("portal commerce operations boundary", () => {
  it("retains exact exception and frozen action evidence", () => {
    const exception = missingTrackingException();
    expect(
      parseCommerceExceptionInbox({
        kind: "ready",
        observedAt: "2026-08-29T00:00:00.000Z",
        items: [exception],
      }),
    ).toEqual({
      kind: "ready",
      observedAt: "2026-08-29T00:00:00.000Z",
      items: [exception],
    });

    expect(
      parseTrackingBatchPreviewResponse({
        ok: true,
        preview: {
          kind: "tracking_batch_preview",
          batchId: BATCH_ID,
          frozenAt: "2026-08-29T00:01:00.000Z",
          items: [
            {
              exceptionId: exception.exceptionId,
              validation: { kind: "valid" },
              action: {
                kind: "attach_tracking",
                batchId: BATCH_ID,
                ...exception.target,
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      batchId: BATCH_ID,
      items: [
        {
          validation: { kind: "valid" },
          action: {
            kind: "attach_tracking",
            fulfillmentRevision: 4,
            shipmentRevision: 7,
            merchantRevision: 12,
          },
        },
      ],
    });
  });

  it("rejects a preview whose action escaped the frozen batch", () => {
    const exception = missingTrackingException();
    expect(() =>
      parseTrackingBatchPreviewResponse({
        ok: true,
        preview: {
          kind: "tracking_batch_preview",
          batchId: BATCH_ID,
          frozenAt: "2026-08-29T00:01:00.000Z",
          items: [
            {
              exceptionId: exception.exceptionId,
              validation: { kind: "valid" },
              action: {
                kind: "attach_tracking",
                batchId: `tracking_batch_${"b".repeat(64)}`,
                ...exception.target,
              },
            },
          ],
        },
      }),
    ).toThrow("Tracking batch action is invalid");
  });
});

function missingTrackingException(): MissingTrackingException {
  return {
    kind: "missing_tracking",
    exceptionId: "missing_tracking:fulfillment_1:shipment_1",
    reason:
      "This fulfillment has a shipping label and is waiting for its tracking reference to be attached.",
    owner: { kind: "unassigned" },
    dueAt: "2026-08-30T03:00:00.000Z",
    recommendedAction: { kind: "attach_tracking", label: "Attach tracking" },
    resolution: {
      kind: "fulfillment_lifecycle",
      expectedState: "handed_to_carrier",
    },
    target: {
      merchantRevision: 12,
      orderId: "order_1",
      fulfillmentId: "fulfillment_1",
      fulfillmentRevision: 4,
      shipmentId: "shipment_1",
      shipmentRevision: 7,
      trackingNumber: "JP123456789",
    },
    freshness: "current",
  };
}
