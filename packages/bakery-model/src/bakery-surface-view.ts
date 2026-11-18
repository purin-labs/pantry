import { hasExactKeys, isRecord } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";

// The camera, dock and label settings of the Kitchen view, and the
// parsers of their wire values. Moved from bakery-surface.ts (file-size
// ratchet).

export type BakeryShiftDock =
  | "closed"
  | "workflow"
  | "inputs"
  | "inspector"
  | "timeline"
  | "scenarios"
  | "comparison"
  | "floorPlan";
export type BakeryCameraView = Readonly<{
  camera: "perspective" | "overhead";
}>;
export type BakeryRecordingCameraView = Readonly<{
  camera:
    | BakeryCameraView["camera"]
    | "cell"
    | "task"
    | "selection"
    | "operator"
    | "inspectionOverhead";
}>;

export type BakeryDoorInspection = StrictUnion<
  | Readonly<{ kind: "unavailable" | "recorded" }>
  | Readonly<{ kind: "preview"; degrees: number }>
>;

export type BakeryShiftView = BakeryCameraView &
  Readonly<{
    dock: BakeryShiftDock;
    labels: "auto" | "all" | "off";
    minimap: boolean;
    chrome: "shown" | "hidden";
  }>;
export type BakeryWorkspaceViewAction = StrictUnion<
  | Readonly<{ kind: "openDock"; dock: BakeryShiftDock }>
  | Readonly<{
      kind: "setCamera";
      camera: BakeryRecordingCameraView["camera"];
    }>
  | Readonly<{ kind: "setDoorPreview"; degrees: number | null }>
  | Readonly<{ kind: "resetCamera" }>
  | Readonly<{ kind: "resetView" }>
  | Readonly<{ kind: "setLabels"; labels: BakeryShiftView["labels"] }>
  | Readonly<{ kind: "setMinimap"; visible: boolean }>
  | Readonly<{ kind: "setChrome"; chrome: BakeryShiftView["chrome"] }>
>;

export function shiftDock(raw: unknown): raw is BakeryShiftDock {
  return (
    raw === "closed" ||
    raw === "workflow" ||
    raw === "inputs" ||
    raw === "inspector" ||
    raw === "timeline" ||
    raw === "scenarios" ||
    raw === "comparison" ||
    raw === "floorPlan"
  );
}
export function parseShiftView(raw: unknown): BakeryShiftView | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["dock", "camera", "labels", "minimap", "chrome"]) ||
    !shiftDock(raw.dock) ||
    (raw.camera !== "perspective" && raw.camera !== "overhead") ||
    (raw.labels !== "auto" && raw.labels !== "all" && raw.labels !== "off") ||
    typeof raw.minimap !== "boolean" ||
    (raw.chrome !== "shown" && raw.chrome !== "hidden")
  )
    return null;
  return {
    dock: raw.dock,
    camera: raw.camera,
    labels: raw.labels,
    minimap: raw.minimap,
    chrome: raw.chrome,
  };
}
export function parseBakeryWorkspaceViewAction(
  raw: unknown,
): BakeryWorkspaceViewAction | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "openDock":
      return hasExactKeys(raw, ["kind", "dock"]) && shiftDock(raw.dock)
        ? { kind: raw.kind, dock: raw.dock }
        : null;
    case "setCamera":
      return hasExactKeys(raw, ["kind", "camera"]) &&
        recordingCamera(raw.camera)
        ? { kind: raw.kind, camera: raw.camera }
        : null;
    case "setDoorPreview":
      return hasExactKeys(raw, ["kind", "degrees"]) &&
        (raw.degrees === null || doorDegrees(raw.degrees))
        ? { kind: raw.kind, degrees: raw.degrees }
        : null;
    case "resetCamera":
    case "resetView":
      return hasExactKeys(raw, ["kind"]) ? { kind: raw.kind } : null;
    case "setLabels":
      return hasExactKeys(raw, ["kind", "labels"]) &&
        (raw.labels === "auto" || raw.labels === "all" || raw.labels === "off")
        ? { kind: raw.kind, labels: raw.labels }
        : null;
    case "setMinimap":
      return hasExactKeys(raw, ["kind", "visible"]) &&
        typeof raw.visible === "boolean"
        ? { kind: raw.kind, visible: raw.visible }
        : null;
    case "setChrome":
      return hasExactKeys(raw, ["kind", "chrome"]) &&
        (raw.chrome === "shown" || raw.chrome === "hidden")
        ? { kind: raw.kind, chrome: raw.chrome }
        : null;
    default:
      return null;
  }
}

export function recordingCamera(
  raw: unknown,
): raw is BakeryRecordingCameraView["camera"] {
  return (
    raw === "perspective" ||
    raw === "overhead" ||
    raw === "cell" ||
    raw === "task" ||
    raw === "selection" ||
    raw === "operator" ||
    raw === "inspectionOverhead"
  );
}

export function parseRecordingCameraView(
  raw: unknown,
): BakeryRecordingCameraView | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["camera"]) ||
    !recordingCamera(raw.camera)
  )
    return null;
  return { camera: raw.camera };
}

export function doorDegrees(raw: unknown): raw is number {
  return (
    typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 110
  );
}
