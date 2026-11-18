import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";
import { parseCaseId, parseIntegrationAccountId } from "../ids";
import type { Result } from "../result";
import type { CaseContextCollectionSelection } from "./relationships";
import { emailMessageReceiptMatches } from "../data/email-mailbox";
import {
  resolveVerifiedContactEndpoint,
  type VerifiedContactEndpoint,
} from "../data/contact-verification";

export async function resolveCaseContextCollectionSelectionVerification(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  selection: CaseContextCollectionSelection,
): Promise<
  Result<
    VerifiedContactEndpoint,
    Readonly<{
      code:
        | "case_context_collection_relationship_invalid"
        | "case_context_collection_relationship_unavailable";
    }>
  >
> {
  if (selection.source !== "gmail") {
    return {
      ok: false,
      error: { code: "case_context_collection_relationship_invalid" },
    };
  }
  const integrationAccountId = parseIntegrationAccountId(
    selection.integrationAccountId,
  );
  const caseId = parseCaseId(selection.caseId);
  if (!integrationAccountId.ok || !caseId.ok) {
    return {
      ok: false,
      error: { code: "case_context_collection_relationship_invalid" },
    };
  }
  const verified = await resolveVerifiedContactEndpoint({
    db,
    organisationId,
    verificationId: selection.verificationId,
    expectedRevision: selection.verificationRevision,
  });
  if (!verified.ok) {
    return {
      ok: false,
      error: { code: "case_context_collection_relationship_unavailable" },
    };
  }
  if (
    verified.value.integrationAccountId !== integrationAccountId.value ||
    verified.value.endpoint.channel !== selection.source
  ) {
    return {
      ok: false,
      error: { code: "case_context_collection_relationship_invalid" },
    };
  }
  const receiptMatches = await emailMessageReceiptMatches({
    db,
    organisationId,
    integrationAccountId: integrationAccountId.value,
    providerMessageId: selection.reference,
    caseId: caseId.value,
    admittedAt: selection.sourceRevision,
    verificationId: selection.verificationId,
    verificationRevision: selection.verificationRevision,
  });
  if (!receiptMatches) {
    return {
      ok: false,
      error: { code: "case_context_collection_relationship_invalid" },
    };
  }
  return verified;
}
