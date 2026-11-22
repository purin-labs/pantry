import type { AgentResponsibilityScope } from "@purin-labs/agent/data/agent-operations";

const entityTypeScope: AgentResponsibilityScope = {
  kind: "entity_type",
  entityTypeId: { origin: "system", typeId: "shipment" },
  // @ts-expect-error Responsibility describes work placement and carries no capability grant.
  capabilityId: "commerce.entity_plane.context",
};

const listScope: AgentResponsibilityScope = {
  kind: "commerce_list",
  listId: "export_coordination",
  // @ts-expect-error Command authority must come from an explicit access grant.
  commandAuthority: {
    kind: "commerce_list_command",
    expectedRevision: 1,
  },
};

void entityTypeScope;
void listScope;
