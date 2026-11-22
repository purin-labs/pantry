import type {
  ChatPermissionItem,
  ChatPermissionRequest,
} from "@purin-labs/control-api";
import { readAgentPermissionRequest } from "../data/agent-permission-request";
import { readOrganisationCapabilityPolicies } from "../data/capability-policy";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { ConversationScope } from "./store";

/**
 * The items of a paused run that nobody has allowed yet. A chat action's
 * capability must be turned on. An agent's request must be allowed by an
 * owner or admin, whose allow already checked its capabilities and grants.
 */
export async function missingChatPermissionItems(
  db: OrganisationDatabase,
  scope: ConversationScope,
  permission: ChatPermissionRequest,
): Promise<readonly ChatPermissionItem[] | null> {
  if (permission.items.every(isAgentRequestItem)) {
    const request = await readAgentPermissionRequest(
      db,
      scope.organisationId,
      permission.permissionRequestId,
    );
    if (request === null) return null;
    return request.status === "allowed" ? [] : permission.items;
  }
  const policies = await readOrganisationCapabilityPolicies({
    db,
    organisationId: scope.organisationId,
  });
  if (!policies.ok) return null;
  return permission.items.filter(
    (item) =>
      item.kind !== "capability" ||
      !policies.value.some(
        (policy) =>
          policy.capabilityId === item.capabilityId &&
          policy.capabilityVersion === item.capabilityVersion &&
          policy.mode === "enabled",
      ),
  );
}

function isAgentRequestItem(item: ChatPermissionItem): boolean {
  return item.kind === "agent_request";
}
