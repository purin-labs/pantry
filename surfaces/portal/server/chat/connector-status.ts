import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { parseCustomConnectorSetupAttemptId } from "@purin-labs/connections/custom-connectors/identity";
import { customConnectorChat } from "@purin-labs/area-integrations-contract/server/custom-connector-chat";
import type { ConversationScope } from "@purin-labs/conversation/chat/store";

export async function readChatConnectorStatus(
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
): Promise<unknown> {
  const chat = customConnectorChat.use();
  const [connectors, rows] = await Promise.all([
    chat.listSummaries({
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
    const setup = await chat.readSetup({
      db: placement.database,
      organisationId: scope.organisationId,
      attemptId: id.value,
    });
    if (setup !== null) setups.push(setup);
  }
  return { connectors: connectors.value, recentSetups: setups };
}
