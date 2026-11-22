import type {
  BakeryProductionControl,
  BakeryProductionTarget,
  BakeryPersistentSurface,
} from "@purin-labs/bakery-model/bakery-surface";

// @ts-expect-error Every target requires the exact continuation and host.
const incompleteTarget: BakeryProductionTarget = {
  runId: "run",
  bundleId: "bundle",
  controlRevision: 0,
};
// @ts-expect-error A pause cannot carry fields from a resource change.
const mixedControl: BakeryProductionControl = {
  kind: "pause",
  resource: "baker",
};
const resourceControl: Variant<BakeryProductionControl, "withhold-resource"> = {
  kind: "withhold-resource",
  resource: "baker",
  interval: { start: 2000, end: 4000 },
};
// @ts-expect-error A broad spread must not turn a resource interval into a pause.
const spreadControl: BakeryProductionControl = {
  ...resourceControl,
  kind: "pause",
};
// @ts-expect-error Persistent context requires lifecycle, target, metrics and review state.
const incompleteSurface: BakeryPersistentSurface = {
  kind: "persistent",
  status: "paused",
};
void [incompleteTarget, mixedControl, spreadControl, incompleteSurface];

import type { BakeryProductionSnapshotSurface } from "@purin-labs/bakery-model/bakery-surface";
import type { Variant } from "@purin-labs/type-utils";
declare const savedEvidence: BakeryProductionSnapshotSurface;
declare const executionTarget: BakeryProductionTarget;
const activeSnapshot: BakeryProductionSnapshotSurface = {
  ...savedEvidence,
  // @ts-expect-error Saved evidence cannot gain execution authority through a spread.
  target: executionTarget,
};
void activeSnapshot;
