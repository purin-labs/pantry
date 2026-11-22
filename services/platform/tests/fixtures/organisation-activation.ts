import { createMigratedDatabase } from "../sqlite-d1";
import { platformEnv, type UnitTestEnv } from "../worker-fakes";
import { prepareInitialOrganisationPlacementInsert } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./organisation-placement";
import { OrganisationDO } from "../../src/actors/organisation";
import {
  activateActorRegistryEntry,
  actorActivationRequest,
  reserveActor,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { ORGANISATION_ACTOR_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { requireActorExecutionAdmission } from "../sqlite-d1";

export async function activateOrganisationFixture(
  actor: OrganisationDO,
  env: UnitTestEnv,
  organisationId: OrganisationId,
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
      objectKind: "organisation",
      organisationId,
      logicalObjectId: organisationId,
    },
    admission,
    schemaVersion: ORGANISATION_ACTOR_SCHEMA_VERSION,
    now: Date.now(),
  });
  if (!reserved.ok) throw new Error(reserved.error.code);
  const entry = reserved.value;
  if (entry.lifecycleStatus !== "reserved")
    throw new Error("Organisation already active");
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

export async function createActiveOrganisationFixture(ctx: DurableObjectState, organisationId: OrganisationId): Promise<OrganisationDO> {
  const db = createMigratedDatabase();
  await db.prepare("INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'Commerce fixture', 'beta', 1, 'active')").bind(organisationId).run();
  await prepareInitialOrganisationPlacementInsert(db, organisationId, "development", TEST_INITIAL_ORGANISATION_PLACEMENT, 1).run();
  const env = platformEnv({ DB: db, PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE });
  const actor = new OrganisationDO(ctx, env);
  await activateOrganisationFixture(actor, env, organisationId);
  return actor;
}
