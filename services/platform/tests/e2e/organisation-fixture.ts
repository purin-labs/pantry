// Organisation fixtures of the E2E journeys. Pantry keeps its own members
// (Plan 95), so a member joins through the same invitation routes that a
// person uses in the Portal.
import { env, exports } from "cloudflare:workers";
import { isRecord } from "@purin-labs/std";
import type { ModelRoute } from "@purin-labs/contracts";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import {
  parseModelApiKey,
  storeOrganisationModelCredential,
} from "../../src/credential-vault";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import {
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
} from "../../src/data/organisation-inference-selection";
import { parseUserId } from "@purin-labs/control-api/ids";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { resolveOrganisationModelRouteForSelection } from "../../src/models/route";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders, type commerceClient } from "./commerce-support";

/** A signed-in person of a journey. */
export type OrganisationClient = Awaited<ReturnType<typeof commerceClient>>;

/** A control request with the person's session and CSRF cookies. */
export function controlRequest(
  client: Readonly<{ session: IssuedControlSession }>,
  path: string,
  body: unknown | null,
): Promise<Response> {
  if (body === null)
    return exports.default.fetch(`https://localhost${path}`, {
      headers: commerceHeaders(client.session),
    });
  return exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers: commerceHeaders(client.session),
    body: JSON.stringify(body),
  });
}

/**
 * The person joins the organisation with `role`: the owner invites the
 * person's email, and the person accepts with the token of the link.
 */
export async function addOrganisationMember(
  organisationId: OrganisationId,
  client: OrganisationClient,
  role: "admin" | "operator" | "viewer",
): Promise<void> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const owner = await scope.database
    .prepare(
      "SELECT user_id AS userId FROM service_role_grant WHERE organisation_id = ? AND role = 'owner' AND status = 'active' ORDER BY created_at, user_id LIMIT 1",
    )
    .bind(organisationId)
    .first<{ userId: string }>();
  if (owner === null) throw new Error("The organisation has no owner");
  const ownerId = parseUserId(owner.userId);
  if (!ownerId.ok) throw new Error(ownerId.error.code);
  const ownerSession = await issueControlSession({
    db: env.DB,
    userId: ownerId.value,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const base = `/v1/control/organisations/${organisationId}/invitations`;
  const invited = await controlRequest({ session: ownerSession }, base, {
    email: client.identity.email,
    role,
  });
  const invitation: unknown = await invited.json();
  if (
    invited.status !== 201 ||
    !isRecord(invitation) ||
    !isRecord(invitation.invitation) ||
    typeof invitation.invitation.organisationInvitationId !== "string" ||
    typeof invitation.token !== "string"
  )
    throw new Error(
      `Invitation failed: ${invited.status} ${JSON.stringify(invitation)}`,
    );
  const accepted = await controlRequest(
    client,
    `${base}/${invitation.invitation.organisationInvitationId}/accept`,
    { token: invitation.token },
  );
  if (accepted.status !== 200)
    throw new Error(
      `Acceptance failed: ${accepted.status} ${await accepted.text()}`,
    );
}

/** The organisation becomes active with a published policy, as activation leaves it. */
export async function activateOrganisation(
  organisationId: OrganisationId,
): Promise<void> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  await scope.database
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = ?, activated_at = ? WHERE organisation_id = ?",
    )
    .bind(`receipt_fixture_${organisationId}`, Date.now(), organisationId)
    .run();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const native = await scope.database
    .prepare(
      "SELECT name, created_at AS createdAt FROM organisation WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ name: string; createdAt: number }>();
  if (native === null) throw new Error("The organisation is missing");
  await organisation.ensureOrganisation({
    organisationId,
    name: native.name,
    plan: "beta",
    status: "active",
    createdAt: native.createdAt,
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: scope.database, kv: env.POLICY_KV },
    organisationId,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(JSON.stringify(policy.error));
}

/** Selects the organisation's model route and returns it. */
export async function selectModelRoute(
  organisationId: OrganisationId,
  client: OrganisationClient,
  selection: "pantry_platform" | "organisation_openai_api_key",
): Promise<ModelRoute> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  if (selection === "organisation_openai_api_key") {
    const key = parseModelApiKey(
      "openai",
      "sk-project-fixture-acceptance-1234567890",
    );
    if (!key.ok) throw new Error(key.error.code);
    const stored = await storeOrganisationModelCredential({
      provider: "openai",
      db: scope.database,
      keys: env,
      organisationId,
      apiKey: key.value,
      now: Date.now(),
    });
    if (!stored.ok) throw new Error(stored.error.code);
  }
  const current = await readOrganisationInferenceSelection({
    db: scope.database,
    organisationId,
  });
  if (current === null) throw new Error("Native inference selection missing");
  const selected = await selectOrganisationInferenceSelection({
    db: scope.database,
    organisationId,
    selection:
      selection === "pantry_platform"
        ? { kind: "pantry_platform" }
        : { kind: "organisation_openai_api_key" },
    expectedConfigurationVersion: current.configurationVersion,
    selectedByUserId: client.identity.userId,
    now: Date.now(),
  });
  if (!selected.ok) throw new Error(selected.error.code);
  const route = await resolveOrganisationModelRouteForSelection({
    env,
    scope,
    now: Date.now(),
    selection: selected.value.selection,
  });
  if (!route.ok) throw new Error(route.error.code);
  return route.value;
}

/** A role change (PATCH) or a removal (DELETE) of a member by the owner. */
export async function memberMutation(
  organisationId: OrganisationId,
  owner: OrganisationClient,
  target: OrganisationClient,
  method: "PATCH" | "DELETE",
  body: unknown,
): Promise<Response> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const current = await scope.database
    .prepare(
      "SELECT configuration_version AS configurationVersion FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ configurationVersion: number }>();
  if (current === null) throw new Error("The organisation has no onboarding");
  const headers = commerceHeaders(owner.session);
  headers.set("idempotency-key", crypto.randomUUID());
  headers.set(
    "x-pantry-configuration-version",
    String(current.configurationVersion),
  );
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/members/${target.identity.userId}`,
    { method, headers, body: JSON.stringify(body) },
  );
}
