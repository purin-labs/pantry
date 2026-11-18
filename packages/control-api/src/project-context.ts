import type { ProjectId } from "./ids.ts";
import { isProjectId } from "./ids.ts";
import {
  hasExactKeys,
  isNonNegativeInteger,
  isRecord,
  canonicalJson,
  sha256Hex,
} from "@seams/std";
import {
  parseProjectContent,
  parseProjectReference,
  type ProjectReference,
} from "./projects.ts";

export type ProjectContextAdmission = Readonly<{
  flowLabelJson: string;
  observationJson: string;
}>;
export type ProjectReferenceObservation = Readonly<{
  reference: ProjectReference;
  observedAt: number;
}> &
  (
    | Readonly<{
        kind: "available";
        revision: string;
        digest: string;
        admission: ProjectContextAdmission;
      }>
    | Readonly<{
        kind: "unavailable";
        reason: string;
        revision?: never;
        digest?: never;
        admission?: never;
      }>
  );
// Every layer names the Project the Case sits in. A withheld layer carries none
// of its content: the acting principal reads nothing from that Project.
export type ProjectLayer =
  | Readonly<{
      kind: "withheld";
      projectId: ProjectId;
      membershipRevision: number;
      contentRevision?: never;
      name?: never;
      brief?: never;
      references?: never;
      admission?: never;
    }>
  | Readonly<{
      kind: "project";
      projectId: ProjectId;
      membershipRevision: number;
      contentRevision: number;
      name: string;
      brief: string;
      admission: ProjectContextAdmission;
      references: readonly ProjectReferenceObservation[];
    }>;
export type ProjectSnapshot = Readonly<{
  layer: ProjectLayer;
  observedAt: number;
  digest: string;
}>;
export const MAX_PROJECT_CONTEXT_BYTES = 24 * 1024;
const MAX_PROJECT_EVIDENCE_BYTES = 512 * 1024;

export async function createProjectSnapshot(
  layer: ProjectLayer,
  observedAt: number,
): Promise<ProjectSnapshot> {
  const payload = canonicalJson({ layer, observedAt });
  if (
    new TextEncoder().encode(canonicalJson(projectLayerContent(layer)))
      .byteLength > MAX_PROJECT_CONTEXT_BYTES ||
    new TextEncoder().encode(payload).byteLength > MAX_PROJECT_EVIDENCE_BYTES
  )
    throw new Error("project_context_capacity");
  return { layer, observedAt, digest: await sha256Hex(payload) };
}
export async function verifyProjectSnapshot(
  snapshot: ProjectSnapshot,
): Promise<boolean> {
  return (
    snapshot.digest ===
    (await sha256Hex(
      canonicalJson({ layer: snapshot.layer, observedAt: snapshot.observedAt }),
    ))
  );
}

export function parseProjectSnapshot(raw: unknown): ProjectSnapshot | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["layer", "observedAt", "digest"]) ||
    !isNonNegativeInteger(raw.observedAt) ||
    !isDigest(raw.digest) ||
    !isRecord(raw.layer)
  )
    return null;
  const layer = raw.layer;
  if (
    !isNonNegativeInteger(layer.membershipRevision) ||
    !isProjectId(layer.projectId)
  )
    return null;
  if (
    layer.kind === "withheld" &&
    hasExactKeys(layer, ["kind", "projectId", "membershipRevision"])
  )
    return {
      layer: {
        kind: "withheld",
        projectId: layer.projectId,
        membershipRevision: layer.membershipRevision,
      },
      observedAt: raw.observedAt,
      digest: raw.digest,
    };
  if (
    layer.kind !== "project" ||
    !hasExactKeys(layer, [
      "kind",
      "projectId",
      "membershipRevision",
      "contentRevision",
      "name",
      "brief",
      "admission",
      "references",
    ]) ||
    !isProjectContextAdmission(layer.admission) ||
    !isNonNegativeInteger(layer.contentRevision) ||
    layer.contentRevision < 1 ||
    !Array.isArray(layer.references) ||
    layer.references.length > 12
  )
    return null;
  const observations: ProjectReferenceObservation[] = [];
  for (const observation of layer.references) {
    const parsed = parseReferenceObservation(observation);
    if (parsed === null) return null;
    observations.push(parsed);
  }
  const content = parseProjectContent({
    name: layer.name,
    brief: layer.brief,
    references: observations.map(observedReference),
  });
  if (content === null) return null;
  return {
    layer: {
      kind: "project",
      projectId: layer.projectId,
      membershipRevision: layer.membershipRevision,
      contentRevision: layer.contentRevision,
      name: content.name,
      brief: content.brief,
      admission: layer.admission,
      references: observations,
    },
    observedAt: raw.observedAt,
    digest: raw.digest,
  };
}

export function restoreStoredProjectSnapshot(
  raw: unknown,
):
  | Readonly<{ kind: "available"; snapshot: ProjectSnapshot }>
  | Readonly<{ kind: "evidence_unavailable" }>
  | Readonly<{ kind: "invalid" }> {
  const snapshot = parseProjectSnapshot(raw);
  if (snapshot !== null) return { kind: "available", snapshot };
  if (!isRecord(raw) || !isRecord(raw.layer) || raw.layer.kind !== "project")
    return { kind: "invalid" };
  if (!isProjectContextAdmission(raw.layer.admission))
    return { kind: "evidence_unavailable" };
  if (Array.isArray(raw.layer.references)) {
    for (const reference of raw.layer.references) {
      if (
        isRecord(reference) &&
        reference.kind === "available" &&
        !isProjectContextAdmission(reference.admission)
      )
        return { kind: "evidence_unavailable" };
    }
  }
  return { kind: "invalid" };
}
function parseReferenceObservation(
  raw: unknown,
): ProjectReferenceObservation | null {
  if (!isRecord(raw) || !isNonNegativeInteger(raw.observedAt)) return null;
  const reference = parseProjectReference(raw.reference);
  if (reference === null) return null;
  if (
    raw.kind === "available" &&
    hasExactKeys(raw, [
      "kind",
      "reference",
      "observedAt",
      "revision",
      "digest",
      "admission",
    ]) &&
    isProjectContextAdmission(raw.admission) &&
    typeof raw.revision === "string" &&
    raw.revision.length > 0 &&
    isDigest(raw.digest)
  )
    return {
      kind: "available",
      reference,
      observedAt: raw.observedAt,
      revision: raw.revision,
      digest: raw.digest,
      admission: raw.admission,
    };
  if (
    raw.kind === "unavailable" &&
    hasExactKeys(raw, ["kind", "reference", "observedAt", "reason"]) &&
    typeof raw.reason === "string" &&
    raw.reason.length > 0
  )
    return {
      kind: "unavailable",
      reference,
      observedAt: raw.observedAt,
      reason: raw.reason,
    };
  return null;
}
function observedReference(
  observation: ProjectReferenceObservation,
): ProjectReference {
  return observation.reference;
}
function isDigest(raw: unknown): raw is string {
  return typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw);
}

function isProjectContextAdmission(
  raw: unknown,
): raw is ProjectContextAdmission {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, ["flowLabelJson", "observationJson"]) &&
    typeof raw.flowLabelJson === "string" &&
    typeof raw.observationJson === "string"
  );
}

function projectLayerContent(layer: ProjectLayer): unknown {
  if (layer.kind === "withheld") return layer;
  return {
    kind: layer.kind,
    projectId: layer.projectId,
    name: layer.name,
    brief: layer.brief,
    membershipRevision: layer.membershipRevision,
    contentRevision: layer.contentRevision,
    references: layer.references.map(referenceContent),
  };
}
function referenceContent(reference: ProjectReferenceObservation): unknown {
  return reference.kind === "available"
    ? {
        kind: reference.kind,
        reference: reference.reference,
        revision: reference.revision,
        digest: reference.digest,
        observedAt: reference.observedAt,
      }
    : reference;
}
