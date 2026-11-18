import type { OrganisationDatabase } from "../database-handles";
import type { IntegrationAccountId, OrganisationId } from "../ids";
import {
  typeSafeAuthorityRevision,
  type TypeSafeAuthority,
} from "../integrations/typesafe/authority";

export async function mailInferenceEligible(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    sourcePin: string;
    typesafe: TypeSafeAuthority;
    now: number;
  }>,
): Promise<boolean> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS eligible FROM mail_classification_eligibility
    WHERE organisation_id = ? AND integration_account_id = ? AND source_pin = ?
      AND funding = ? AND connection_revision = ? AND model = 'jev-1.13.0' AND purpose = 'mail_classification'
      AND disclosed_recipient = 'typesafe' AND reviewed_at <= ? AND review_expires_at > ? AND revoked_at IS NULL`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.sourcePin,
      input.typesafe.kind,
      typeSafeAuthorityRevision(input.typesafe),
      input.now,
      input.now,
    )
    .first<{ eligible: number }>();
  return row?.eligible === 1;
}
