import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * The erase of the Mail classification switch of one removed mailbox, while
 * the placement of the scope is still active. The Inbox runs it in the batch
 * that erases the mailbox's classification records.
 */
export function prepareMailClassificationEligibilityErase(
  scope: OrganisationExecutionScope,
  integrationAccountId: IntegrationAccountId,
): D1PreparedStatement {
  return scope.database
    .prepare(
      `DELETE FROM mail_classification_eligibility WHERE organisation_id = ? AND integration_account_id = ?
           AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ?
             AND placement_epoch = ? AND placement_cell_id = ?
             AND fence_token = ? AND status = 'active')`,
    )
    .bind(
      scope.organisationId,
      integrationAccountId,
      scope.organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      scope.fenceToken,
    );
}

/**
 * Whether the Mail classification switch covers one mailbox source now: a
 * current, unrevoked review for the funding route and its connection
 * revision. The switch of Integrations writes the record
 * (`jev-features/mail-switch.ts`).
 */
export async function mailClassificationEligible(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    sourcePin: string;
    funding: string;
    connectionRevision: number;
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
      input.funding,
      input.connectionRevision,
      input.now,
      input.now,
    )
    .first<{ eligible: number }>();
  return row?.eligible === 1;
}
