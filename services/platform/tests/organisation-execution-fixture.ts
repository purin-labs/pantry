import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import {
  reserveActor,
  actorActivationRequest,
  activateActorRegistryEntry,
  type ActorIdentity,
  type ActorActivationRequest,
  type ActorActivationResult,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import { requireActorExecutionAdmission } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import {
  bootstrapOrganisation,
  type OrganisationBootstrap,
} from "@purin-labs/tenancy/data/control-plane";
import { readActiveOrganisationMembershipRevision } from "@purin-labs/tenancy/data/control-plane";
import { buildControlAuthority } from "../src/request-authority";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Env } from "@purin-labs/kernel/env";
import type { UnitTestEnv } from "./worker-fakes";
import {
  parseSessionId,
  parseOrganisationId,
  type ControlSessionId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { RequestAuthority } from "@purin-labs/contracts";
import {
  bindOperatorTurnAccess,
  type SessionTurnExecution,
} from "../src/chat/turn-access";
import "./provide-organisation-lifecycle-parts";

export async function requireOrganisationExecutionScope(
  env: Pick<Env, "DB" | "PANTRY_ORGANISATION_PLACEMENT_PROFILE">,
  organisationId: OrganisationId,
): Promise<OrganisationExecutionScope> {
  const resolved = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!resolved.ok) throw new Error(resolved.error.code);
  return resolved.value;
}

export async function admitControlTurnFixture(
  env: Pick<Env, "DB" | "PANTRY_ORGANISATION_PLACEMENT_PROFILE">,
  authority: Extract<RequestAuthority, { kind: "control" }>,
  controlSessionId: ControlSessionId,
): Promise<SessionTurnExecution> {
  const sessionId = parseSessionId(`session_fixture_${controlSessionId}`);
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  const turnId = `turn_fixture_${controlSessionId}`;
  const admitted = await bindOperatorTurnAccess(
    await requireOrganisationExecutionScope(env, organisationId.value),
    sessionId.value,
    turnId,
    authority,
    { kind: "control_session", controlSessionId },
  );
  if (!admitted) throw new Error("Fixture origin admission failed");
  return { sessionId: sessionId.value, turnId, requestAuthority: authority };
}

export async function admitOperatorControlTurnFixture(
  env: Pick<Env, "DB" | "PANTRY_ORGANISATION_PLACEMENT_PROFILE">,
  organisationId: OrganisationId,
  userId: UserId,
  controlSessionId: ControlSessionId,
): Promise<SessionTurnExecution> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const member = await scope.database
    .prepare(
      "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ? AND role = 'operator' AND status = 'active'",
    )
    .bind(organisationId, userId)
    .first<{ personId: string }>();
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: scope.database,
    organisationId,
  });
  if (member === null || membershipRevision === null)
    throw new Error("Missing active fixture operator");
  return admitControlTurnFixture(
    env,
    buildControlAuthority({
      organisationId,
      userId,
      membershipRevision,
      requesterPersonId: member.personId,
      role: "operator",
    }).requestAuthority,
    controlSessionId,
  );
}

export async function requireOrganisationBootstrap(
  input: Parameters<typeof bootstrapOrganisation>[0],
): Promise<OrganisationBootstrap> {
  const result = await bootstrapOrganisation(input);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

export async function createOrganisationExecutionFixture(
  db: SingleDatabase,
  organisationId: OrganisationId,
): Promise<OrganisationExecutionScope> {
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, 'Execution fixture', 1) ON CONFLICT (organisation_id) DO NOTHING",
    )
    .bind(organisationId)
    .run();
  const placement = await ensureInitialOrganisationPlacement({
    db,
    organisationId,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 1,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  return requireOrganisationExecutionScope(
    {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    organisationId,
  );
}

export async function activateActorFixture(
  env: Pick<UnitTestEnv, "DB" | "PANTRY_ORGANISATION_PLACEMENT_PROFILE">,
  actor: {
    activate(request: ActorActivationRequest): Promise<ActorActivationResult>;
  },
  identity: ActorIdentity,
  schemaVersion: number,
): Promise<void> {
  const scope = await createOrganisationExecutionFixture(
    env.DB,
    identity.organisationId,
  );
  const admission = await requireActorExecutionAdmission(
    env.DB,
    identity.organisationId,
    scope.placement,
  );
  const reserved = await reserveActor({
    db: env.DB,
    identity,
    admission,
    schemaVersion,
    now: 1,
  });
  if (!reserved.ok) throw new Error(reserved.error.code);
  if (reserved.value.lifecycleStatus === "active") return;
  if (reserved.value.lifecycleStatus !== "reserved")
    throw new Error("Fixture Actor is unavailable");
  const activated = await actor.activate(
    actorActivationRequest(reserved.value, 1, admission),
  );
  if (!activated.ok) throw new Error(activated.error.code);
  const published = await activateActorRegistryEntry({
    db: env.DB,
    admission,
    registryId: reserved.value.registryId,
    activationToken: reserved.value.activationToken,
    stateVersion: activated.value.stateVersion,
    now: 1,
  });
  if (!published.ok) throw new Error(published.error.code);
}
