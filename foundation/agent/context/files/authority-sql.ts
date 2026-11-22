import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { FileProjectionCommand } from "./domain";

export function fileExecutionFence(
  scope: OrganisationExecutionScope,
): Readonly<{
  sql: string;
  bindings: readonly (string | number)[];
}> {
  return {
    sql: `EXISTS (SELECT 1 FROM organisation_placement
      WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
        AND fence_token = ? AND status = 'active')`,
    bindings: [
      scope.organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      scope.fenceToken,
    ],
  };
}

export function fileProjectionFence(
  scope: OrganisationExecutionScope,
  command: FileProjectionCommand,
): Readonly<{ sql: string; bindings: readonly (string | number)[] }> {
  const execution = fileExecutionFence(scope);
  return {
    sql: `${execution.sql} AND EXISTS (
      SELECT 1 FROM file_grant_admission AS admission
      JOIN access_grant AS grant_record
        ON grant_record.organisation_id = admission.organisation_id
       AND grant_record.grant_id = admission.grant_id
       AND grant_record.revision = admission.grant_revision
      JOIN integration_account AS account
        ON account.organisation_id = admission.organisation_id
       AND account.integration_account_id = admission.integration_account_id
      JOIN file_resource_source AS source
        ON source.organisation_id = admission.organisation_id
       AND source.integration_account_id = admission.integration_account_id
       AND source.provider_file_id = admission.provider_file_id
      WHERE admission.organisation_id = ? AND admission.grant_id = ?
        AND admission.grant_revision = ? AND admission.integration_account_id = ?
        AND admission.provider = ? AND admission.provider_file_id = ?
        AND admission.provider_revision_json = ?
        AND source.provider_revision_json = admission.provider_revision_json
        AND source.source_sequence = ? AND grant_record.lifecycle = 'active'
        AND account.lifecycle = 'active'
        AND ${ACTIVE_FILE_GRANT_VISIBILITY_SQL} = ?)`,
    bindings: [
      ...execution.bindings,
      scope.organisationId,
      command.grantId,
      command.grantRevision,
      command.integrationAccountId,
      command.provider,
      command.providerFileId,
      JSON.stringify(command.providerRevision),
      command.sourceSequence,
      command.visibilityKey,
    ],
  };
}

export const ACTIVE_FILE_GRANT_VISIBILITY_SQL = `CASE json_extract(grant_record.subject_json, '$.kind')
  WHEN 'organisation_role' THEN 'organisation_role:' || json_extract(grant_record.subject_json, '$.role')
  WHEN 'person' THEN 'person:' || json_extract(grant_record.subject_json, '$.personId')
  WHEN 'conversation' THEN 'conversation:' ||
    json_extract(grant_record.subject_json, '$.integrationAccountId') || ':' ||
    json_extract(grant_record.subject_json, '$.conversationId')
  WHEN 'workflow' THEN 'workflow:' ||
    json_extract(grant_record.subject_json, '$.workflowKind') || ':' ||
    json_extract(grant_record.subject_json, '$.workflowId') || ':' ||
    json_extract(grant_record.subject_json, '$.workflowRevision')
  WHEN 'agent_mailbox' THEN 'agent_mailbox:' ||
    json_extract(grant_record.subject_json, '$.integrationAccountId') || ':' ||
    json_extract(grant_record.subject_json, '$.mailboxBindingId') || ':' ||
    json_extract(grant_record.subject_json, '$.bindingRevision')
  WHEN 'whatsapp_support' THEN 'whatsapp_support:' ||
    json_extract(grant_record.subject_json, '$.integrationAccountId') || ':' ||
    json_extract(grant_record.subject_json, '$.supportBindingId') || ':' ||
    json_extract(grant_record.subject_json, '$.bindingRevision')
END`;
