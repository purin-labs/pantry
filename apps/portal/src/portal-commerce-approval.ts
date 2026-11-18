import { isRecord } from "@seams/std";
import type { PendingCommerceApproval } from "./portal-types";

const PENDING_COMMERCE_APPROVAL_STORAGE_KEY = "satyr:commerce-approval";

const PENDING_COMMERCE_APPROVAL_MAX_AGE_MS = 10 * 60 * 1000;

export function currentPortalPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function readPendingCommerceApproval(): PendingCommerceApproval | null {
  try {
    const raw = sessionStorage.getItem(PENDING_COMMERCE_APPROVAL_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      typeof parsed.organisationId !== "string" ||
      typeof parsed.actionNonce !== "string" ||
      typeof parsed.returnPath !== "string" ||
      typeof parsed.createdAt !== "number" ||
      !Number.isSafeInteger(parsed.createdAt) ||
      Date.now() - parsed.createdAt > PENDING_COMMERCE_APPROVAL_MAX_AGE_MS
    ) {
      sessionStorage.removeItem(PENDING_COMMERCE_APPROVAL_STORAGE_KEY);
      return null;
    }
    return {
      organisationId: parsed.organisationId,
      actionNonce: parsed.actionNonce,
      returnPath: parsed.returnPath,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function writePendingCommerceApproval(pending: PendingCommerceApproval): void {
  try {
    sessionStorage.setItem(
      PENDING_COMMERCE_APPROVAL_STORAGE_KEY,
      JSON.stringify(pending),
    );
  } catch {
    return;
  }
}

export function clearPendingCommerceApproval(pending: PendingCommerceApproval): void {
  try {
    const raw = sessionStorage.getItem(PENDING_COMMERCE_APPROVAL_STORAGE_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed.organisationId === pending.organisationId &&
      parsed.actionNonce === pending.actionNonce &&
      parsed.createdAt === pending.createdAt
    ) {
      sessionStorage.removeItem(PENDING_COMMERCE_APPROVAL_STORAGE_KEY);
    }
  } catch {
    return;
  }
}
