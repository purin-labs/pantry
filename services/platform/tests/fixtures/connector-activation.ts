import type { UnitTestEnv } from "../worker-fakes";
import type { ConnectorDO } from "../../src/actors/connector";
import {
  activateActorRegistryEntry,
  actorActivationRequest,
  reserveActor,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { CONNECTOR_ACTOR_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import type { ConnectorId, OrganisationId } from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { requireActorExecutionAdmission } from "../sqlite-d1";

export async function activateConnectorFixture(
  actor: ConnectorDO,
  env: UnitTestEnv,
  organisationId: OrganisationId,
  connectorId: ConnectorId,
): Promise<void> {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  const admission = await requireActorExecutionAdmission(
    env.DB,
    organisationId,
    scope.value.placement,
  );
  const reserved = await reserveActor({
    db: env.DB,
    identity: {
      objectKind: "connector",
      organisationId,
      logicalObjectId: connectorId,
    },
    admission,
    schemaVersion: CONNECTOR_ACTOR_SCHEMA_VERSION,
    now: Date.now(),
  });
  if (!reserved.ok) throw new Error(reserved.error.code);
  const entry = reserved.value;
  if (entry.lifecycleStatus !== "reserved")
    throw new Error("Connector already active");
  const activated = await actor.activate(
    actorActivationRequest(entry, Date.now(), admission),
  );
  if (!activated.ok) throw new Error(activated.error.code);
  const published = await activateActorRegistryEntry({
    db: env.DB,
    admission,
    registryId: entry.registryId,
    activationToken: entry.activationToken,
    stateVersion: activated.value.stateVersion,
    now: Date.now(),
  });
  if (!published.ok) throw new Error(published.error.code);
}
