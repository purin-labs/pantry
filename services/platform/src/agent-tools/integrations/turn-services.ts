import { sha256Hex } from "@purin-labs/std";
import { acceptedExecutionAuthority } from "../../organisation-access/access";
import { sessionActionMutationExecution } from "../../actors/action-mutation-execution";
import { requireActiveOrganisationActorAtPlacement } from "../../actors/actor-router";
import { readSessionTurnFlowBinding } from "../../actors/agent-session-information-flow";
import type {
  SessionToolWiring,
  ToolTurnContext,
} from "../../actors/session/tool-wiring";
import { requireSessionExecution } from "../../actors/session-execution-admission";
import { authorizeCapabilityUse } from "../../authorization/access-grants/turn-authority";
import {
  buildCustomConnectorWriteAuthority,
  compileCustomConnectorCatalog,
  customConnectorTurnTool,
  type CustomConnectorWriteCatalogEntry,
} from "../../custom-connectors";
import { parseCaseId, parseSessionId } from "@purin-labs/kernel/ids";
import { withToolContext, type SessionToolContext } from "../context";
import {
  listIntegrationsForEmbeddedHarness,
  readAirtableForHarness,
  readCustomConnectorForEmbeddedHarness,
  writeAirtableForHarness,
} from "./handlers";
import type { IntegrationToolServices } from "./services";

/**
 * The tools that a turn adds to the tool list: one tool for each custom
 * connector operation that the grants of the turn select.
 */
export async function customConnectorTurnTools(
  input: Parameters<SessionToolWiring["turnTools"]>[0],
): ReturnType<SessionToolWiring["turnTools"]> {
  const catalog = await compileCustomConnectorCatalog({
    db: input.database,
    effectiveGrants: input.effectiveGrants,
  });
  return catalog.ok
    ? { ok: true, value: catalog.value.map(customConnectorTurnTool) }
    : catalog;
}

/** What Integrations gives to one turn: the services of its tools. */
export function integrationToolServices(
  turn: ToolTurnContext,
): IntegrationToolServices {
  const tool = withToolContext(turn);
  return {
    listIntegrations: tool(listIntegrationsForEmbeddedHarness),
    readAirtable: tool(readAirtableForHarness),
    writeAirtable: tool(writeAirtableForHarness),
    readCustomConnector: readCustomConnectorForEmbeddedHarness.bind(
      null,
      turn.env,
      turn.storage,
      turn.execution,
      turn.lease,
      turn.assignment,
      turn.effectiveGrantSet,
    ),
    proposeCustomConnectorWrite: tool(
      proposeCustomConnectorWriteForEmbeddedHarness,
    ),
  };
}

async function proposeCustomConnectorWriteForEmbeddedHarness(
  context: SessionToolContext,
  entry: CustomConnectorWriteCatalogEntry,
  rawArguments: unknown,
  operationId: string,
): Promise<unknown> {
  await requireSessionExecution(context.execution, context.lease);
  const requiredCapability = {
    kind: "custom_connector_operation" as const,
    capabilityId: "custom_connector.write",
    capabilityVersion: 1,
    integrationAccountId: entry.integrationAccountId,
    connectorId: entry.connectorId,
    definitionRevision: entry.definitionRevision,
    definitionDigest: entry.definitionDigest,
    operationId: entry.operation.id,
  };
  const capability = await authorizeCapabilityUse({
    db: context.execution.scope.database,
    accountAccess: context.execution.scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      context.lease.session.sessionId,
      context.lease.turn.turnId,
    ),
    action: "execute",
    organisationId: context.execution.scope.organisationId,
    authority: context.lease.requestAuthority,
    authorityPartition: context.assignment.authorityPartition,
    request: { capabilities: [requiredCapability] },
  });
  if (!capability.ok) {
    throw new Error(
      `custom connector proposal authority rejected: ${capability.error.code}`,
    );
  }
  const informationFlow = await readSessionTurnFlowBinding(
    context.storage.sql,
    {
      organisationId: String(context.execution.scope.organisationId),
      sessionId: String(context.assignment.sessionId),
      turnId: String(context.lease.turn.turnId),
    },
  );
  if (
    !informationFlow.ok ||
    informationFlow.value === null ||
    informationFlow.value.authorityPartitionDigest !==
      context.lease.authorityPartitionDigest
  ) {
    throw new Error(
      "custom connector proposal information-flow binding unavailable",
    );
  }
  const providerEffectId = [
    "effect",
    context.assignment.assignmentId,
    operationId,
  ].join("_");
  const authority = await buildCustomConnectorWriteAuthority({
    entry,
    rawArguments,
    providerEffectId,
  });
  if (!authority.ok) {
    throw new Error(
      `custom connector proposal invalid: ${authority.error.code}`,
    );
  }
  const caseId = parseCaseId(String(context.assignment.caseId));
  const sessionId = parseSessionId(String(context.assignment.sessionId));
  if (!caseId.ok || !sessionId.ok) {
    throw new Error("custom connector proposal identity is invalid");
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: context.env,
    organisationId: context.execution.scope.organisationId,
    placement: context.execution.scope.placement,
    now: Date.now(),
  });
  const proposalDigest = await sha256Hex(
    JSON.stringify({
      capabilityKey: entry.capabilityKey,
      providerEffectId,
      canonicalInputDigest: authority.value.canonicalInputDigest,
    }),
  );
  const proposalId = `proposal_custom_${proposalDigest.slice(0, 32)}`;
  const now = Date.now();
  const resourceKey =
    authority.value.resourceIdentity.kind === "existing_record"
      ? `custom_connector:${entry.connectorId}:${entry.operation.id}:${authority.value.resourceIdentity.value}`
      : `custom_connector:${entry.connectorId}:${entry.operation.id}:${providerEffectId}`;
  await requireSessionExecution(context.execution, context.lease);
  const proposed = await organisation.proposeAction({
    execution: sessionActionMutationExecution(
      context.execution.scope,
      context.lease,
    ),
    organisationId: context.execution.scope.organisationId,
    integrationAccountId: entry.integrationAccountId,
    requestAuthority: context.lease.requestAuthority,
    authorityPartition: context.assignment.authorityPartition,
    authority: authority.value,
    caseId: caseId.value,
    proposalId,
    sessionId: sessionId.value,
    threadId: String(context.assignment.caseId),
    draft: {
      host: new URL(entry.origin).host,
      verb: `custom_connector.${entry.operation.effect.kind}`,
      path:
        entry.operation.transport.kind === "mcp"
          ? entry.operation.transport.endpointPath
          : entry.operation.transport.pathTemplate,
      argsHash: authority.value.canonicalInputDigest,
      amount: null,
      resourceKey,
    },
    flowBinding: informationFlow.value.binding.toJSON(),
    exp: now + 15 * 60_000,
    now,
  });
  if (!proposed.ok) {
    throw new Error(
      `custom connector proposal ledger rejected: ${proposed.error.code}`,
    );
  }
  await requireSessionExecution(context.execution, context.lease);
  const requested = await organisation.requestActionApproval({
    execution: sessionActionMutationExecution(
      context.execution.scope,
      context.lease,
    ),
    organisationId: context.execution.scope.organisationId,
    nonce: proposed.value.action.nonce.value,
    now,
  });
  if (!requested.ok) {
    throw new Error(
      `custom connector approval request rejected: ${requested.error.code}`,
    );
  }
  await requireSessionExecution(context.execution, context.lease);
  return {
    kind: "custom_connector_write_proposed",
    nonce: requested.value.action.nonce.value,
    state: requested.value.state,
    connectorId: entry.connectorId,
    operationId: entry.operation.id,
    effect: entry.operation.effect.kind,
    providerEffectId,
    requiresHumanApproval: true,
    reviewQuery: `?customConnector=${encodeURIComponent(entry.connectorId)}&customAction=${encodeURIComponent(requested.value.action.nonce.value)}`,
  };
}
