/**
 * The commerce exception inbox: the shape that the Agent operations page and
 * the Platform read. It names no commerce package, so the foundation can read
 * it until the commerce area gives a port (Refactor 17, steps A1.7 and A1.8).
 */
export type MissingTrackingException = Readonly<{
  kind: "missing_tracking";
  exceptionId: string;
  reason: string;
  owner: Readonly<{ kind: "unassigned" }>;
  dueAt: string;
  recommendedAction: Readonly<{
    kind: "attach_tracking";
    label: "Attach tracking";
  }>;
  resolution: Readonly<{
    kind: "fulfillment_lifecycle";
    expectedState: "handed_to_carrier";
  }>;
  target: TrackingActionTarget;
  freshness: "current";
}>;

export type TrackingActionTarget = Readonly<{
  merchantRevision: number;
  orderId: string;
  fulfillmentId: string;
  fulfillmentRevision: number;
  shipmentId: string;
  shipmentRevision: number;
  trackingNumber: string;
}>;

export type CommerceExceptionInbox =
  | Readonly<{
      kind: "ready";
      observedAt: string;
      items: readonly MissingTrackingException[];
    }>
  | Readonly<{
      kind: "unavailable";
      reason:
        | "commerce_system_unavailable"
        | "resolution_unsupported"
        | "entity_plane_unavailable";
    }>;
