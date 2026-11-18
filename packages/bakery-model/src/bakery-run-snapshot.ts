import { readEspressoRun } from "./espresso-rehearsal-file.ts";
import { MAX_RECORDING_BYTES } from "./bakery-physics.ts";
import { hasExactKeys, isRecord } from "@seams/std";
import { parseApplianceWorkflow } from "./bakery-appliance-workflow.ts";

export const MAX_RUN_FILE_BYTES = MAX_RECORDING_BYTES + 65536;
export const MAX_RUN_SNAPSHOT_BYTES = MAX_RUN_FILE_BYTES + 1024;
const snapshot = Symbol("bounded rehearsal snapshot");
export type RunSnapshotKind =
  | "rehearsal"
  | "production"
  | "appliance"
  | "persistent-production"
  | "linea"
  | "eagle";

// Storage treats run files as untrusted documents. The simulator owns semantic
// validation and explicit evidence acceptance when a saved document is opened.
export type RunSnapshot = Readonly<{
  [snapshot]: true;
  name: string;
  kind: RunSnapshotKind;
  file: string;
  content: string;
}>;

export type RunSnapshotSummary = Readonly<{
  id: string;
  name: string;
  kind: RunSnapshotKind;
  savedAt: string;
  bytes: number;
}>;

export function isRunSnapshotId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function parseRunSnapshot(value: unknown): RunSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "document"]))
    return null;
  if (typeof value.name !== "string") return null;
  const name = value.name.trim();
  if (name.length === 0 || name.length > 80 || /[\u0000-\u001f]/u.test(name))
    return null;
  const document = value.document;
  if (!isRecord(document)) return null;
  let kind: RunSnapshotKind;
  switch (document.kind) {
    case "saved":
      // The production engine checks semantics and artifact digests on open.
      // Storage admits only its bounded, versioned file envelope.
      if (
        !hasExactKeys(document, ["kind", "document", "artifacts"]) ||
        !isRecord(document.document) ||
        !hasExactKeys(document.document, [
          "schemaVersion",
          "kind",
          "snapshot",
          "artifacts",
          "state",
          "bundle",
        ]) ||
        document.document.schemaVersion !== 1 ||
        document.document.kind !== "resumable" ||
        !isRunSnapshotId(document.document.snapshot) ||
        !isRecord(document.document.state) ||
        !isRecord(document.document.bundle) ||
        !Array.isArray(document.document.artifacts) ||
        !Array.isArray(document.artifacts)
      )
        return null;
      kind = "persistent-production";
      break;
    case "linea-rehearsal":
    case "eagle-rehearsal":
      try {
        readEspressoRun(JSON.stringify(document));
      } catch {
        return null;
      }
      kind = document.kind === "linea-rehearsal" ? "linea" : "eagle";
      break;
    case "bakery-appliance-run":
      try {
        parseApplianceWorkflow(JSON.stringify(document));
      } catch {
        return null;
      }
      kind = "appliance";
      break;
    case "bakery-orchestration-run":
      if (
        !hasExactKeys(document, [
          "schemaVersion",
          "kind",
          "trays",
          "operations",
        ]) ||
        (document.schemaVersion !== 1 &&
          document.schemaVersion !== 2 &&
          document.schemaVersion !== 3 &&
          document.schemaVersion !== 4) ||
        !Array.isArray(document.trays) ||
        !Array.isArray(document.operations) ||
        document.trays.length > 16 ||
        document.operations.length > 16
      )
        return null;
      kind = "rehearsal";
      break;
    case "bakery-workcell-experiment":
      if (
        !hasExactKeys(document, [
          "schemaVersion",
          "kind",
          "input",
          "evidence",
          ...(document.schemaVersion === 3 ? ["presentation"] : []),
        ]) ||
        (document.schemaVersion !== 1 &&
          document.schemaVersion !== 2 &&
          document.schemaVersion !== 3) ||
        document.kind !== "bakery-workcell-experiment" ||
        !isRecord(document.input) ||
        (document.schemaVersion === 3 && !isRecord(document.presentation)) ||
        (document.evidence !== null && !isRecord(document.evidence))
      )
        return null;
      kind = "rehearsal";
      break;
    case "bakery-rehearsal-run":
      if (
        !hasExactKeys(document, [
          "schemaVersion",
          "kind",
          "fingerprint",
          "settings",
          "trays",
          ...(document.schemaVersion === 1 ? [] : ["faults"]),
          ...(document.schemaVersion === 3 || document.schemaVersion === 4
            ? ["cellRobots"]
            : []),
        ]) ||
        (document.schemaVersion !== 1 &&
          document.schemaVersion !== 2 &&
          document.schemaVersion !== 3 &&
          document.schemaVersion !== 4) ||
        (document.schemaVersion !== 1 && !isRecord(document.faults)) ||
        ((document.schemaVersion === 3 || document.schemaVersion === 4) &&
          !isRecord(document.cellRobots)) ||
        typeof document.fingerprint !== "string" ||
        !isRecord(document.settings) ||
        !Array.isArray(document.trays) ||
        document.trays.length < 1 ||
        document.trays.length > 16
      )
        return null;
      kind = "rehearsal";
      break;
    case "bakery-production-workcells":
      if (
        !hasExactKeys(document, [
          "schemaVersion",
          "kind",
          "fingerprint",
          "settings",
          "variant",
          "source",
          "operations",
          ...(document.schemaVersion === 5 ||
          document.schemaVersion === 6 ||
          document.schemaVersion === 7 ||
          document.schemaVersion === 8 ||
          document.schemaVersion === 9
            ? ["manualTasks", "procedureFingerprint"]
            : []),
          ...(document.schemaVersion === 8 || document.schemaVersion === 9
            ? ["cellRobots"]
            : []),
        ]) ||
        (document.schemaVersion !== 3 &&
          document.schemaVersion !== 4 &&
          document.schemaVersion !== 5 &&
          document.schemaVersion !== 6 &&
          document.schemaVersion !== 7 &&
          document.schemaVersion !== 8 &&
          document.schemaVersion !== 9) ||
        ((document.schemaVersion === 8 || document.schemaVersion === 9) &&
          !isRecord(document.cellRobots)) ||
        typeof document.fingerprint !== "string" ||
        !isRecord(document.settings) ||
        (document.variant !== "normal" && document.variant !== "outage") ||
        !isRecord(document.source) ||
        !Array.isArray(document.operations) ||
        document.operations.length < 1 ||
        document.operations.length > 16
      )
        return null;
      kind = "production";
      break;
    default:
      return null;
  }
  const file = JSON.stringify(document);
  if (new TextEncoder().encode(file).length > MAX_RUN_FILE_BYTES) return null;
  return Object.freeze<RunSnapshot>({
    [snapshot]: true,
    name,
    kind,
    file,
    content: JSON.stringify({ name, document }),
  });
}

export function parseRunSnapshotSummary(
  value: unknown,
): RunSnapshotSummary | null {
  if (
    !isRecord(value) ||
    !isRunSnapshotId(value.id) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 80 ||
    (value.kind !== "rehearsal" &&
      value.kind !== "production" &&
      value.kind !== "appliance" &&
      value.kind !== "linea" &&
      value.kind !== "eagle" &&
      value.kind !== "persistent-production") ||
    typeof value.savedAt !== "string" ||
    !Number.isFinite(Date.parse(value.savedAt)) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > MAX_RUN_SNAPSHOT_BYTES
  )
    return null;
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    savedAt: value.savedAt,
    bytes: value.bytes,
  };
}

export type RunSnapshotPage = Readonly<{
  snapshots: readonly RunSnapshotSummary[];
  nextCursor: string | null;
}>;

export function isRunSnapshotCursor(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length > 0 && value.length <= 2048)
  );
}

export function parseRunSnapshotPage(raw: unknown): RunSnapshotPage | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["snapshots", "nextCursor"]) ||
    !Array.isArray(raw.snapshots) ||
    raw.snapshots.length > 25 ||
    !isRunSnapshotCursor(raw.nextCursor)
  )
    return null;
  const snapshots: RunSnapshotSummary[] = [];
  for (const value of raw.snapshots) {
    const summary = parseRunSnapshotSummary(value);
    if (summary === null) return null;
    snapshots.push(summary);
  }
  return { snapshots, nextCursor: raw.nextCursor };
}
