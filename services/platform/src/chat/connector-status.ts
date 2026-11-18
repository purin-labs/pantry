import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { parseCustomConnectorSetupAttemptId } from "../custom-connectors/identity";
import { resolveCustomConnectorSetupAttempt } from "../custom-connectors/setup";
import { listCustomConnectorSummaries } from "../custom-connectors/projection";
import type { ConversationScope } from "./store";

export async function readChatConnectorStatus(
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
): Promise<unknown> {
  const [connectors, rows] = await Promise.all([
    listCustomConnectorSummaries({
      db: placement.database,
      organisationId: scope.organisationId,
    }),
    placement.database
      .prepare(
        "SELECT attempt_id FROM custom_connector_setup_attempt WHERE organisation_id = ? AND created_by_user_id = ? ORDER BY updated_at DESC LIMIT 10",
      )
      .bind(scope.organisationId, scope.userId)
      .all<{ attempt_id: unknown }>(),
  ]);
  if (!connectors.ok)
    throw new Error("Could not read current connector status.");
  const setups: unknown[] = [];
  for (const row of rows.results) {
    const id = parseCustomConnectorSetupAttemptId(row.attempt_id);
    if (!id.ok) throw new Error("Invalid connector setup identity.");
    const result = await resolveCustomConnectorSetupAttempt({
      db: placement.database,
      organisationId: scope.organisationId,
      attemptId: id.value,
    });
    if (!result.ok) continue;
    const attempt = result.value;
    setups.push({
      connectorId: attempt.connectorId,
      revision: attempt.connectorRevision,
      state: attempt.lifecycle,
      failure: attempt.lifecycle === "failed" ? attempt.failure : null,
    });
  }
  return { connectors: connectors.value, recentSetups: setups };
}
