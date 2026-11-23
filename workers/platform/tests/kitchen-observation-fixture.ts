import type { SurfaceObservationV2 } from "@purin-labs/control-api";
import type { BakerySurfaceContextV1 } from "@purin-labs/bakery-model/bakery-surface";

/**
 * The screen observation that the Portal sends from the Kitchen (Plan 87
 * phase 2): the Kitchen's current view is its state, and the server makes
 * the view that the model reads from that state.
 */
export function kitchenObservation(
  context: BakerySurfaceContextV1,
  browserInstanceId: string,
  conversationId: string,
): SurfaceObservationV2 {
  return {
    kind: "surface-observation",
    schemaVersion: 2,
    surface: "workflow-simulator",
    area: "kitchen",
    instance: {
      browserInstanceId,
      surfaceSessionId: context.surfaceSessionId,
      epoch: context.surfaceEpoch,
    },
    title: "Workflow simulator",
    path: `/portal/nuki/shop/workflow-simulator#${conversationId}`,
    record: null,
    capturedAt: context.capturedAt,
    view: [],
    state: context,
    commands: [],
    sources: [],
  };
}
