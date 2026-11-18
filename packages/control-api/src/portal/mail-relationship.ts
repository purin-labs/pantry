import type {
  MailRelationshipPreview,
  MailSupplierCandidate,
} from "../index.ts";
import { isRecord, isPositiveInteger } from "@seams/std";

export function parseSuppliers(raw: unknown): readonly MailSupplierCandidate[] {
  if (!Array.isArray(raw) || raw.length > 20)
    throw new Error("Could not read supplier choices.");
  return raw.map(parseSupplier);
}

function parseSupplier(raw: unknown): MailSupplierCandidate {
  if (
    !isRecord(raw) ||
    typeof raw.entryId !== "string" ||
    typeof raw.supplierId !== "string" ||
    typeof raw.displayName !== "string"
  )
    throw new Error("Could not read a supplier record.");
  return {
    entryId: raw.entryId,
    supplierId: raw.supplierId,
    displayName: raw.displayName,
  };
}

export function parseRelationshipPreview(
  raw: Record<string, unknown>,
): MailRelationshipPreview {
  if (
    raw.kind !== "purchase_request" ||
    typeof raw.supplierEntryId !== "string" ||
    typeof raw.supplierId !== "string" ||
    typeof raw.supplierName !== "string" ||
    typeof raw.purchaseRequestEntryId !== "string" ||
    typeof raw.purchaseRequestId !== "string" ||
    !isPositiveInteger(raw.merchantRevision) ||
    !isPositiveInteger(raw.version) ||
    typeof raw.snapshotDigest !== "string" ||
    typeof raw.relationshipDigest !== "string" ||
    typeof raw.challenge !== "string" ||
    !Array.isArray(raw.facts) ||
    raw.facts.length > 6
  )
    throw new Error("Could not read current purchasing evidence.");
  return {
    kind: "purchase_request",
    supplierEntryId: raw.supplierEntryId,
    supplierId: raw.supplierId,
    supplierName: raw.supplierName,
    purchaseRequestEntryId: raw.purchaseRequestEntryId,
    purchaseRequestId: raw.purchaseRequestId,
    merchantRevision: raw.merchantRevision,
    version: raw.version,
    snapshotDigest: raw.snapshotDigest,
    relationshipDigest: raw.relationshipDigest,
    challenge: raw.challenge,
    facts: raw.facts.map(parseFact),
  };
}

function parseFact(raw: unknown): Readonly<{ label: string; value: string }> {
  if (
    !isRecord(raw) ||
    typeof raw.label !== "string" ||
    typeof raw.value !== "string"
  )
    throw new Error("Could not read a purchasing fact.");
  return { label: raw.label, value: raw.value };
}
