import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { IntegrationAccountId } from "@purin-labs/kernel/ids";
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
