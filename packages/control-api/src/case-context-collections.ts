import { isPositiveInteger, isRecord } from "@seams/std";

export type CaseContextCollectionRelationshipDecision = Readonly<{
  kind: "confirm" | "reject" | "detach";
  relationshipId: string;
}>;

export type CaseContextCollectionReviewCommand = Readonly<{
  commandId: string;
  expectedRevision: number;
  decision:
    | Readonly<{ kind: "resolve"; relationshipId?: never }>
    | CaseContextCollectionRelationshipDecision;
}>;

export type CaseContextCollectionMetadataView = Readonly<{
  caseContextCollectionId: string;
  revision: number;
  lifecycle: "open" | "resolved";
  issueKind: string;
  issueInstance: string;
  anchorCaseId: string;
  relationships: readonly CaseContextCollectionRelationshipView[];
}>;

export type CaseContextCollectionRelationshipView = Readonly<{
  relationshipId: string;
  caseId: string;
  kind: "suggested" | "attached" | "rejected" | "detached";
}>;

export function parseCaseContextCollectionMetadataResponse(
  raw: unknown,
): readonly CaseContextCollectionMetadataView[] {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !Array.isArray(raw.caseContextCollections) ||
    raw.caseContextCollections.length > 20
  )
    throw new Error("CaseContextCollection metadata is unavailable.");
  return raw.caseContextCollections.map(parseCaseContextCollectionMetadata);
}

function parseCaseContextCollectionMetadata(
  raw: unknown,
): CaseContextCollectionMetadataView {
  if (
    !isRecord(raw) ||
    !identifier(raw.caseContextCollectionId) ||
    !isPositiveInteger(raw.revision) ||
    (raw.lifecycle !== "open" && raw.lifecycle !== "resolved") ||
    !identifier(raw.issueKind) ||
    !identifier(raw.issueInstance) ||
    !identifier(raw.anchorCaseId) ||
    !Array.isArray(raw.relationships) ||
    raw.relationships.length > 200
  )
    throw new Error("CaseContextCollection metadata is invalid.");
  return {
    caseContextCollectionId: raw.caseContextCollectionId,
    revision: raw.revision,
    lifecycle: raw.lifecycle,
    issueKind: raw.issueKind,
    issueInstance: raw.issueInstance,
    anchorCaseId: raw.anchorCaseId,
    relationships: raw.relationships.map(
      parseCaseContextCollectionRelationship,
    ),
  };
}

function parseCaseContextCollectionRelationship(
  raw: unknown,
): CaseContextCollectionRelationshipView {
  if (
    !isRecord(raw) ||
    !identifier(raw.relationshipId) ||
    !identifier(raw.caseId) ||
    (raw.kind !== "suggested" &&
      raw.kind !== "attached" &&
      raw.kind !== "rejected" &&
      raw.kind !== "detached")
  )
    throw new Error("CaseContextCollection relationship is invalid.");
  return {
    relationshipId: raw.relationshipId,
    caseId: raw.caseId,
    kind: raw.kind,
  };
}

function identifier(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 256;
}
