import type { PhysicsSceneLife } from "./physics-scene-host";

declare const factory: Extract<PhysicsSceneLife, { kind: "factory" }>;
declare const recording: Extract<
  PhysicsSceneLife,
  { kind: "ready" | "loading-assets" }
>;

// @ts-expect-error A disposed host cannot retain a factory renderer through a spread.
const disposedFactory: PhysicsSceneLife = { ...factory, kind: "disposed" };
// @ts-expect-error A factory renderer cannot stand in for a single-cell recording renderer.
const mixedRenderer: PhysicsSceneLife = {
  ...factory,
  kind: "ready",
  source: recording.source,
};
// @ts-expect-error Factory state cannot carry single-cell recording authority.
const mixedSource: PhysicsSceneLife = { ...factory, source: recording.source };
void [disposedFactory, mixedRenderer, mixedSource];
