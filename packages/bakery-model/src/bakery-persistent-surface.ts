import { hasExactKeys, isNonNegativeInteger, isRecord } from "@seams/std";
import type { StrictUnion } from "@seams/type-utils";

/** Every command names one live continuation and its reviewed control state. */
export type BakeryProductionTarget = Readonly<{
  runId: string;
  executionId: string;
  hostSession: string;
  bundleId: string;
  controlRevision: number;
}>;
export type BakeryProductionControl = StrictUnion<
  | Readonly<{ kind: "pause" | "resume" }>
  | Readonly<{ kind: "close-arrivals"; source: string }>
  | Readonly<{ kind: "extend-horizon"; horizon: number }>
  | Readonly<{
      kind: "withhold-resource";
      resource: string;
      interval: Readonly<{ start: number; end: number }>;
    }>
  | Readonly<{
      kind: "recover-appliance-fault";
      appliance: string;
      checkpointDigest: string;
    }>
  | Readonly<{
      kind: "move-equipment";
      applianceId: string;
      xMm: number;
      zMm: number;
    }>
  | Readonly<{
      kind: "rotate-equipment";
      applianceId: string;
    }>
>;
export type BakeryProductionReview = Readonly<{
  digest: string;
  target: BakeryProductionTarget;
  control: BakeryProductionControl;
  expiresAt: number;
}>;
export type BakeryPersistentSurface = Readonly<{
  kind: "persistent";
  target: BakeryProductionTarget;
  status:
    | "running"
    | "paused"
    | "blocked"
    | "completed"
    | "awaiting-inspection"
    | "stopped-at-limit"
    | "busy";
  time: number;
  horizon: number;
  events: number;
  resources: readonly string[];
  arrivals: readonly string[];
  pendingControl: BakeryProductionReview | null;
}>;

function identifier(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 160;
}
function time(raw: unknown): raw is number {
  return (
    isNonNegativeInteger(raw) && Number.isSafeInteger(raw) && raw % 2000 === 0
  );
}
function digest(raw: unknown): raw is string {
  return typeof raw === "string" && /^[0-9a-f]{64}$/u.test(raw);
}
function checkpointHex(raw: unknown): raw is string {
  return typeof raw === "string" && /^[0-9a-f]{16,64}$/u.test(raw);
}
export function parseBakeryProductionTarget(
  raw: unknown,
): BakeryProductionTarget | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "runId",
      "executionId",
      "hostSession",
      "bundleId",
      "controlRevision",
    ]) ||
    !identifier(raw.runId) ||
    !identifier(raw.executionId) ||
    !identifier(raw.hostSession) ||
    !digest(raw.bundleId) ||
    !isNonNegativeInteger(raw.controlRevision)
  )
    return null;
  return {
    runId: raw.runId,
    executionId: raw.executionId,
    hostSession: raw.hostSession,
    bundleId: raw.bundleId,
    controlRevision: raw.controlRevision,
  };
}
export function parseBakeryProductionControl(
  raw: unknown,
): BakeryProductionControl | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "pause":
    case "resume":
      return hasExactKeys(raw, ["kind"]) ? { kind: raw.kind } : null;
    case "close-arrivals":
      return hasExactKeys(raw, ["kind", "source"]) && identifier(raw.source)
        ? { kind: raw.kind, source: raw.source }
        : null;
    case "extend-horizon":
      return hasExactKeys(raw, ["kind", "horizon"]) && time(raw.horizon)
        ? { kind: raw.kind, horizon: raw.horizon }
        : null;
    case "withhold-resource":
      if (
        !hasExactKeys(raw, ["kind", "resource", "interval"]) ||
        !identifier(raw.resource) ||
        !isRecord(raw.interval) ||
        !hasExactKeys(raw.interval, ["start", "end"]) ||
        !time(raw.interval.start) ||
        !time(raw.interval.end) ||
        raw.interval.end <= raw.interval.start
      )
        return null;
      return {
        kind: raw.kind,
        resource: raw.resource,
        interval: { start: raw.interval.start, end: raw.interval.end },
      };
    case "recover-appliance-fault":
      return hasExactKeys(raw, ["kind", "appliance", "checkpointDigest"]) &&
        identifier(raw.appliance) &&
        checkpointHex(raw.checkpointDigest)
        ? {
            kind: raw.kind,
            appliance: raw.appliance,
            checkpointDigest: raw.checkpointDigest,
          }
        : null;
    case "move-equipment":
      return hasExactKeys(raw, ["kind", "applianceId", "xMm", "zMm"]) &&
        identifier(raw.applianceId) &&
        typeof raw.xMm === "number" &&
        Number.isSafeInteger(raw.xMm) &&
        raw.xMm >= -20_000 &&
        raw.xMm <= 20_000 &&
        typeof raw.zMm === "number" &&
        Number.isSafeInteger(raw.zMm) &&
        raw.zMm >= -20_000 &&
        raw.zMm <= 20_000
        ? {
            kind: raw.kind,
            applianceId: raw.applianceId,
            xMm: raw.xMm,
            zMm: raw.zMm,
          }
        : null;
    case "rotate-equipment":
      return hasExactKeys(raw, ["kind", "applianceId"]) &&
        identifier(raw.applianceId)
        ? { kind: raw.kind, applianceId: raw.applianceId }
        : null;
    default:
      return null;
  }
}
export function parseBakeryProductionReview(
  raw: unknown,
): BakeryProductionReview | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["digest", "target", "control", "expiresAt"]) ||
    !digest(raw.digest) ||
    !isNonNegativeInteger(raw.expiresAt)
  )
    return null;
  const target = parseBakeryProductionTarget(raw.target);
  const control = parseBakeryProductionControl(raw.control);
  return target === null || control === null
    ? null
    : { digest: raw.digest, target, control, expiresAt: raw.expiresAt };
}
export function parseBakeryPersistentSurface(
  raw: unknown,
): BakeryPersistentSurface | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "target",
      "status",
      "time",
      "horizon",
      "events",
      "resources",
      "arrivals",
      "pendingControl",
    ]) ||
    raw.kind !== "persistent" ||
    !time(raw.time) ||
    !time(raw.horizon) ||
    !isNonNegativeInteger(raw.events) ||
    !Array.isArray(raw.resources) ||
    !raw.resources.every(identifier) ||
    raw.resources.length > 64 ||
    !Array.isArray(raw.arrivals) ||
    !raw.arrivals.every(identifier) ||
    raw.arrivals.length > 64
  )
    return null;
  const target = parseBakeryProductionTarget(raw.target);
  const pendingControl =
    raw.pendingControl === null
      ? null
      : parseBakeryProductionReview(raw.pendingControl);
  if (
    target === null ||
    (raw.pendingControl !== null && pendingControl === null)
  )
    return null;
  switch (raw.status) {
    case "running":
    case "paused":
    case "blocked":
    case "completed":
    case "awaiting-inspection":
    case "stopped-at-limit":
    case "busy":
      return {
        kind: "persistent",
        target,
        status: raw.status,
        time: raw.time,
        horizon: raw.horizon,
        events: raw.events,
        resources: raw.resources,
        arrivals: raw.arrivals,
        pendingControl,
      };
    default:
      return null;
  }
}

/** Saved evidence has no execution target or command authority. */
export type BakeryProductionSnapshotSurface = Readonly<{
  kind: "persistent-snapshot";
  snapshotId: string;
  runId: string;
  bundleId: string;
  time: number;
  events: number;
  target?: never;
  pendingControl?: never;
}>;
export function parseBakeryProductionSnapshotSurface(
  raw: unknown,
): BakeryProductionSnapshotSurface | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "snapshotId",
      "runId",
      "bundleId",
      "time",
      "events",
    ]) ||
    raw.kind !== "persistent-snapshot" ||
    !digest(raw.snapshotId) ||
    !identifier(raw.runId) ||
    !digest(raw.bundleId) ||
    !time(raw.time) ||
    !isNonNegativeInteger(raw.events)
  )
    return null;
  return {
    kind: "persistent-snapshot",
    snapshotId: raw.snapshotId,
    runId: raw.runId,
    bundleId: raw.bundleId,
    time: raw.time,
    events: raw.events,
  };
}
