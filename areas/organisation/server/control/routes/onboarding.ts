import { lifecycleFenceOf } from "@purin-labs/tenancy/data/organisation-lifecycle-moves";
import { signalChat } from "@purin-labs/conversation/chat/signals";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import type { Env } from "@purin-labs/kernel/env";
import { createOwnedOrganisation } from "@purin-labs/tenancy/organisation-access/creation";
import {
  readOrganisationCreationRequest,
  readOrganisationName,
} from "@purin-labs/control-api";
import {
  acceptInvitation,
  issueInvitation,
  listPendingInvitations,
  revokeInvitation,
} from "@purin-labs/tenancy/organisation-access/invitations";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { commerceSystemReadiness } from "@purin-labs/area-commerce-contract/server/system-readiness";
import {
  ensureCurrentReadiness,
  ensureCurrentReadinessFromSignals,
  parseSetupSelection,
  recordOnboardingStageViewed,
  selectSetupTemplates,
  setupCatalog,
} from "../../data/onboarding";
import {
  buildOnboardingProjection,
  type OnboardingProjection,
} from "../../data/onboarding-projection";
import {
  changeOrganisationServiceRole,
  listEligibleControlMemberships,
  listOrganisationMemberProfiles,
  parseAssignableControlRole,
  parseControlRole,
  parseOrganisationInvitationEmail,
  revokeOrganisationMembership,
} from "@purin-labs/tenancy/data/control-plane";
import type { StoredControlMutationReceipt } from "@purin-labs/tenancy/data/control-mutation";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
  renameOrganisation,
  restoreOrganisation,
} from "@purin-labs/tenancy/data/organisation-lifecycle";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import {
  activationModelRouteError,
  resolveOrganisationModelRoute,
} from "@purin-labs/agent/models/route";
import { holdOrganisationPolicyDistribution } from "@purin-labs/authority/policy-snapshot";
import { providerServices } from "@purin-labs/area-integrations-contract/server/provider-services";
import {
  admitUserMutation,
  controlMutationIdentity,
  mutationProjection,
  projectionReplay,
  projectionResponse,
  resolveMutationUser,
} from "@purin-labs/control/worker/admission/control-mutation";
import {
  authenticateControlMutation,
  authenticateControlRead,
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import {
  readOrganisationHomeRegions,
  selectOrganisationHomePlacement,
} from "@purin-labs/control/worker/home-region";
import {
  readJsonRecord,
  controlError,
  controlHeaders,
  controlJson,
} from "@purin-labs/control/worker/http";
import {
  activationErrorStatus,
  runtimeAdmissionStatus,
} from "../onboarding-runtime";
import {
  assertNever,
  hasExactKeys,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";

export type OnboardingControlRoute =
  | Readonly<{ kind: "organisations" }>
  | Readonly<{ kind: "organisation"; organisationIdRaw: string }>
  | Readonly<{ kind: "members"; organisationIdRaw: string }>
  | Readonly<{
      kind: "member";
      organisationIdRaw: string;
      userIdRaw: string;
    }>
  | Readonly<{ kind: "invitations"; organisationIdRaw: string }>
  | Readonly<{
      kind: "revokeInvitation";
      organisationIdRaw: string;
      organisationInvitationIdRaw: string;
    }>
  | Readonly<{ kind: "setupCatalog" }>
  | Readonly<{
      kind: "acceptInvitation";
      organisationIdRaw: string;
      invitationIdRaw: string;
    }>
  | Readonly<{ kind: "homeRegions" }>
  | Readonly<{ kind: "setup"; organisationIdRaw: string }>
  | Readonly<{ kind: "stageViewed"; organisationIdRaw: string }>
  | Readonly<{ kind: "readiness"; organisationIdRaw: string }>
  | Readonly<{ kind: "activate"; organisationIdRaw: string }>
  | Readonly<{ kind: "archive"; organisationIdRaw: string }>
  | Readonly<{ kind: "restore"; organisationIdRaw: string }>;

export function matchOnboardingControlRoute(
  pathname: string,
): OnboardingControlRoute | null {
  if (pathname === "/v1/control/organisations")
    return { kind: "organisations" };
  if (pathname === "/v1/control/setup/catalog") return { kind: "setupCatalog" };
  if (pathname === "/v1/control/home-regions") return { kind: "homeRegions" };
  const member = two(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/members\/([^/]+)$/u,
  );
  if (member !== null) {
    return {
      kind: "member",
      organisationIdRaw: member.organisationIdRaw,
      userIdRaw: member.valueRaw,
    };
  }
  const acceptInvitation = two(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/invitations\/([^/]+)\/accept$/u,
  );
  if (acceptInvitation !== null)
    return {
      kind: "acceptInvitation",
      organisationIdRaw: acceptInvitation.organisationIdRaw,
      invitationIdRaw: acceptInvitation.valueRaw,
    };
  const revokeInvitation = two(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/invitations\/([^/]+)\/revoke$/u,
  );
  if (revokeInvitation !== null) {
    return {
      kind: "revokeInvitation",
      organisationIdRaw: revokeInvitation.organisationIdRaw,
      organisationInvitationIdRaw: revokeInvitation.valueRaw,
    };
  }
  const members = organisation(pathname, "members");
  if (members !== null) return { kind: "members", organisationIdRaw: members };
  const invitations = organisation(pathname, "invitations");
  if (invitations !== null)
    return { kind: "invitations", organisationIdRaw: invitations };
  const stageViewed = organisation(pathname, "onboarding/stage-viewed");
  if (stageViewed !== null)
    return { kind: "stageViewed", organisationIdRaw: stageViewed };
  const setup = organisation(pathname, "setup");
  if (setup !== null) return { kind: "setup", organisationIdRaw: setup };
  const readiness = organisation(pathname, "readiness");
  if (readiness !== null)
    return { kind: "readiness", organisationIdRaw: readiness };
  const activate = organisation(pathname, "activate");
  if (activate !== null)
    return { kind: "activate", organisationIdRaw: activate };
  const archive = organisation(pathname, "archive");
  if (archive !== null) return { kind: "archive", organisationIdRaw: archive };
  const restore = organisation(pathname, "restore");
  if (restore !== null) return { kind: "restore", organisationIdRaw: restore };
  const root = /^\/v1\/control\/organisations\/([^/]+)$/u.exec(pathname);
  return root?.[1] === undefined
    ? null
    : { kind: "organisation", organisationIdRaw: decodeURIComponent(root[1]) };
}

function organisation(pathname: string, suffix: string): string | null {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const result = new RegExp(
    `^/v1/control/organisations/([^/]+)/${escaped}$`,
    "u",
  ).exec(pathname);
  return result?.[1] === undefined ? null : decodeURIComponent(result[1]);
}

function two(
  pathname: string,
  pattern: RegExp,
): Readonly<{ organisationIdRaw: string; valueRaw: string }> | null {
  const result = pattern.exec(pathname);
  return result?.[1] === undefined || result[2] === undefined
    ? null
    : {
        organisationIdRaw: decodeURIComponent(result[1]),
        valueRaw: decodeURIComponent(result[2]),
      };
}

export function handleOnboardingControlRoute(
  request: Request,
  env: Env,
  route: OnboardingControlRoute,
): Promise<Response> {
  switch (route.kind) {
    case "organisations":
      return handleOrganisations(request, env);
    case "organisation":
      return handleOrganisation(request, env, route.organisationIdRaw);
    case "members":
      return handleMembers(request, env, route.organisationIdRaw);
    case "member":
      return handleMember(
        request,
        env,
        route.organisationIdRaw,
        route.userIdRaw,
      );
    case "invitations":
      return handleInvitations(request, env, route.organisationIdRaw);
    case "revokeInvitation":
      return handleRevokeInvitation(
        request,
        env,
        route.organisationIdRaw,
        route.organisationInvitationIdRaw,
      );
    case "setupCatalog":
      return handleSetupCatalog(request, env);
    case "acceptInvitation":
      return handleAcceptInvitation(
        request,
        env,
        route.organisationIdRaw,
        route.invitationIdRaw,
      );
    case "homeRegions":
      return handleHomeRegions(request, env);
    case "setup":
      return handleSetup(request, env, route.organisationIdRaw);
    case "stageViewed":
      return handleStageViewed(request, env, route.organisationIdRaw);
    case "readiness":
      return handleReadiness(request, env, route.organisationIdRaw);
    case "activate":
      return handleActivate(request, env, route.organisationIdRaw);
    case "archive":
      return handleArchive(request, env, route.organisationIdRaw);
    case "restore":
      return handleRestore(request, env, route.organisationIdRaw);
    default:
      return assertNever(route);
  }
}

async function handleOrganisations(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "POST") return handleCreateOrganisation(request, env);
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authenticated = await authenticateControlRead(request, env);
  if (!authenticated.ok) return authenticated.response;
  const memberships = await listEligibleControlMemberships({
    env,
    session: authenticated.value.session,
  });
  return controlJson({
    ok: true,
    memberships: memberships.memberships,
    membershipAvailability: memberships.availability,
  });
}

/**
 * Plan 95 step 2: a signed-in person makes an organisation and becomes its
 * owner. The operation id makes a retry return the same organisation.
 */
async function handleCreateOrganisation(
  request: Request,
  env: Env,
): Promise<Response> {
  const authenticated = await authenticateControlMutation(request, env);
  if (!authenticated.ok) return authenticated.response;
  const body = await readJsonRecord(request);
  const input = body.ok ? readOrganisationCreationRequest(body.value) : null;
  if (input === null) return controlError("organisation_create_invalid", 422);
  const owner = await resolveMutationUser(
    env,
    authenticated.value.session.userId,
  );
  if (owner instanceof Response) return owner;
  // The person's browser sends this request, so its location is theirs.
  const placement = selectOrganisationHomePlacement(env, request);
  if (!placement.ok) return controlError(placement.error.code, 503);
  const created = await createOwnedOrganisation({
    env,
    owner,
    request: input,
    placement: placement.value,
    now: Date.now(),
  });
  if (created.ok) return controlJson({ ok: true, organisation: created.value });
  switch (created.error.code) {
    case "organisation_create_invalid":
      return controlError(created.error.code, 422);
    case "organisation_owner_unverified":
    case "organisation_test_not_allowed":
      return controlError(created.error.code, 403);
    case "organisation_limit_reached":
    case "idempotency_key_conflict":
      return controlError(created.error.code, 409);
    case "authority_unavailable":
      return controlError(created.error.code, 503);
    default:
      return assertNever(created.error.code);
  }
}

async function handleOrganisation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method === "PATCH")
    return handleOrganisationRename(request, env, organisationIdRaw);
  if (request.method === "DELETE")
    return handleOrganisationDelete(request, env, organisationIdRaw);
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) {
    return controlError("organisation_not_found", 404);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const now = Date.now();
  await ensureCurrentReadinessFromSignals({
    db: authorized.executionScope.database,
    organisationId: organisationId.value,
    fence: lifecycleFenceOf(authorized.executionScope),
    now,
    signals: readReadinessSignals.bind(null, env, organisationId.value, now),
  });
  const projection = await buildOnboardingProjection({
    db: authorized.executionScope.database,
    organisationId: organisationId.value,
    membership: authorized.membership,
    now: Date.now(),
  });
  if (projection === null) {
    return controlError("organisation_not_found", 404);
  }
  return onboardingProjectionResponse(request, projection);
}

/** The two live signals of a readiness assessment, read together. */
async function readReadinessSignals(
  env: Env,
  organisationId: OrganisationId,
  now: number,
) {
  const [runtimeAdmission, commerce] = await Promise.all([
    runtimeAdmissionStatus(env, organisationId, now),
    commerceSystemReadiness(env, organisationId, now),
  ]);
  return { runtimeAdmission, commerceSystemReadiness: commerce };
}

async function handleOrganisationRename(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "owner",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  const name = body.ok ? readOrganisationName(body.value.name) : null;
  if (!body.ok || name === null || Object.keys(body.value).length !== 1) {
    return controlError("organisation_rename_request_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}`,
    operation: "organisation.rename",
    replay: projectionReplay(authorized),
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  const renamed = await renameOrganisation({
    directory: env.DB,
    execution: authorized.executionScope,
    actorUserId: identity.userId,
    name,
    mutation: {
      boundary,
      scope,
      identity: await controlMutationIdentity(request, identity, now),
    },
    now,
  });
  if (!renamed.ok) return controlError(renamed.error.code, 409);
  return projectionResponse(
    authorized,
    "renamed organisation projection is missing",
    {
      receipt: {
        receipt_id: renamed.value.receiptId,
        organisation_id: renamed.value.organisationId,
      },
    },
  );
}

async function handleOrganisationDelete(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "owner",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0)
    return controlError("organisation_delete_request_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}`,
    operation: "organisation.delete",
    replay: receiptReplay,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  const deleted = await deleteArchivedOrganisation({
    directory: env.DB,
    execution: authorized.executionScope,
    actorUserId: identity.userId,
    mutation: {
      boundary,
      scope,
      identity: await controlMutationIdentity(request, identity, now),
    },
    now,
  });
  if (!deleted.ok) return controlError(deleted.error.code, 409);
  return controlJson({
    kind: "success",
    receipt: {
      receipt_id: deleted.value.receiptId,
      organisation_id: deleted.value.organisationId,
    },
  });
}

/** The replay of a mutation whose answer is its receipt alone. */
function receiptReplay(receipt: StoredControlMutationReceipt): Response {
  return controlJson(
    { kind: "success", receipt: receipt.responseBody },
    receipt.responseStatus,
  );
}

async function handleMembers(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const members = await listOrganisationMemberProfiles({
    db: authorized.executionScope.database,
    identityDatabase: env.DB,
    organisationId: authorized.organisationId,
  });
  return controlJson({ ok: true, members });
}

async function handleMember(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  userIdRaw: string,
): Promise<Response> {
  if (request.method !== "PATCH" && request.method !== "DELETE") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const targetUserId = parseUserId(userIdRaw);
  if (!targetUserId.ok) {
    return controlError("organisation_membership_not_found", 404);
  }
  const body = await readJsonRecord(request);
  const nextRole =
    request.method === "PATCH" && body.ok
      ? parseControlRole(body.value.role)
      : null;
  if (
    !body.ok ||
    (request.method === "PATCH" && (nextRole === null || !nextRole.ok)) ||
    (request.method === "DELETE" && Object.keys(body.value).length !== 0)
  ) {
    return controlError("organisation_membership_request_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/members/${targetUserId.value}`,
    operation:
      request.method === "PATCH"
        ? "organisation.service-role.change"
        : "organisation.membership.revoke",
    replay: receiptReplay,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, user: identity } = admitted;
  const now = Date.now();
  const mutation = {
    boundary,
    scope: admitted.scope,
    identity: await controlMutationIdentity(request, identity, now),
  };
  if (request.method === "PATCH") {
    if (nextRole === null || !nextRole.ok) {
      throw new Error("organisation member role boundary invariant failed");
    }
    const changed = await changeOrganisationServiceRole({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      targetUserId: targetUserId.value,
      nextRole: nextRole.value,
      changedByUserId: identity.userId,
      mutation,
      now,
    });
    // A role decides chat access, and a revoked run stops on the next read.
    if (changed.ok)
      signalChat(authorized.executionScope, { kind: "organisation" });
    return changed.ok
      ? controlJson({
          kind: "success",
          member: changed.value.member,
          receipt: {
            receipt_id: changed.value.receiptId,
            organisation_id: authorized.organisationId,
          },
        })
      : controlError(
          changed.error.code,
          membershipErrorStatus(changed.error.code),
        );
  }
  const revoked = await revokeOrganisationMembership({
    execution: authorized.executionScope,
    organisationId: authorized.organisationId,
    targetUserId: targetUserId.value,
    revokedByUserId: identity.userId,
    mutation,
    now,
  });
  if (revoked.ok)
    signalChat(authorized.executionScope, { kind: "organisation" });
  return revoked.ok
    ? controlJson({
        kind: "success",
        receipt: {
          receipt_id: revoked.value.receiptId,
          organisation_id: authorized.organisationId,
        },
      })
    : controlError(
        revoked.error.code,
        membershipErrorStatus(revoked.error.code),
      );
}

/** A missing member is 404, a change that needs an owner 403, others 409. */
function membershipErrorStatus(code: string): number {
  switch (code) {
    case "organisation_membership_not_found":
      return 404;
    case "organisation_owner_required":
      return 403;
    default:
      return 409;
  }
}

async function handleInvitations(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    request.method === "GET" ? "viewer" : "admin",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  if (request.method === "GET")
    return controlJson({
      ok: true,
      invitations: await listPendingInvitations(
        authorized.executionScope,
        Date.now(),
      ),
    });
  const body = await readJsonRecord(request);
  if (!body.ok || !hasExactKeys(body.value, ["email", "role"]))
    return controlError("organisation_invitation_invalid", 422);
  const role = parseAssignableControlRole(body.value.role);
  const email = parseOrganisationInvitationEmail(body.value.email);
  if (!role.ok || !email.ok)
    return controlError("organisation_invitation_invalid", 422);
  const issued = await issueInvitation(authorized.executionScope, {
    email: email.value.value,
    role: role.value,
    invitedBy: authorized.authenticated.session.userId,
    now: Date.now(),
  });
  return issued.ok
    ? controlJson({ ok: true, ...issued.value }, 201)
    : invitationError(issued.error.code);
}

async function handleRevokeInvitation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  invitationId: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    !hasExactKeys(body.value, []) ||
    invitationId.length === 0 ||
    invitationId.trim() !== invitationId
  )
    return controlError("organisation_invitation_revoke_invalid", 422);
  const revoked = await revokeInvitation(
    authorized.executionScope,
    invitationId,
    Date.now(),
  );
  return revoked.ok
    ? controlJson({ ok: true, invitation: revoked.value })
    : invitationError(revoked.error.code);
}

/**
 * The invited person is not a member yet, so the request has a session and
 * no organisation role. The invitation, its token and the person's verified
 * email decide the answer.
 */
async function handleAcceptInvitation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  invitationId: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authenticated = await authenticateControlMutation(request, env);
  if (!authenticated.ok) return authenticated.response;
  const organisation = parseOrganisationId(organisationIdRaw);
  const body = await readJsonRecord(request);
  if (
    !organisation.ok ||
    !body.ok ||
    !hasExactKeys(body.value, ["token"]) ||
    typeof body.value.token !== "string" ||
    body.value.token.trim() !== body.value.token ||
    body.value.token.length === 0 ||
    body.value.token.length > 256 ||
    invitationId.trim() !== invitationId ||
    invitationId.length === 0
  )
    return controlError("organisation_invitation_accept_invalid", 422);
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisation.value,
  );
  if (!execution.ok)
    return controlError("organisation_invitation_not_found", 404);
  const user = await resolveMutationUser(
    env,
    authenticated.value.session.userId,
  );
  if (user instanceof Response) return user;
  const accepted = await acceptInvitation(execution.value, {
    invitationId,
    token: body.value.token,
    user,
    now: Date.now(),
  });
  return accepted.ok
    ? controlJson({ ok: true, member: accepted.value })
    : invitationError(accepted.error.code);
}

function invitationError(
  code:
    | "organisation_invitation_not_found"
    | "organisation_invitation_closed"
    | "organisation_invitation_expired"
    | "organisation_invitation_email_mismatch"
    | "organisation_placement_conflict",
): Response {
  switch (code) {
    case "organisation_invitation_not_found":
      return controlError(code, 404);
    case "organisation_invitation_email_mismatch":
      return controlError(code, 403);
    case "organisation_invitation_closed":
    case "organisation_invitation_expired":
    case "organisation_placement_conflict":
      return controlError(code, 409);
    default:
      return assertNever(code);
  }
}

async function handleSetupCatalog(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authenticated = await authenticateControlRead(request, env);
  return authenticated.ok
    ? controlJson({ ok: true, catalog: setupCatalog() })
    : authenticated.response;
}

async function handleHomeRegions(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authenticated = await authenticateControlRead(request, env);
  if (!authenticated.ok) return authenticated.response;
  const homeRegions = readOrganisationHomeRegions(env, request);
  return homeRegions.ok
    ? controlJson({ ok: true, homeRegions: homeRegions.value })
    : controlError(homeRegions.error.code, 503);
}

async function handleSetup(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("invalid_setup_selection", 422);
  }
  const selection = parseSetupSelection(body.value);
  if (!selection.ok) {
    return controlError(selection.error.code, 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/setup`,
    operation: "setup.save",
    replay: projectionReplay(authorized),
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  const execution = await OrganisationExecutionScope.resolve(
    env,
    authorized.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const saved = await selectSetupTemplates({
    scope: execution.value,
    selectedByUserId: identity.userId,
    selection: selection.value,
    mutation: {
      boundary,
      scope,
      identity: await controlMutationIdentity(request, identity, now),
    },
    now,
  });
  if (!saved.ok) {
    return controlError(saved.error.code, 409);
  }
  return projectionResponse(authorized, "saved setup projection is missing", {
    receipt: {
      receipt_id: saved.value.receiptId,
      organisation_id: authorized.organisationId,
    },
  });
}

async function handleReadiness(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const now = Date.now();
  await providerServices.use().reconcileProviderManifestObservations({
    env,
    organisationId: authorized.organisationId,
    now,
    fetcher: runtimeFetch,
  });
  const assessment = await ensureCurrentReadiness({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    fence: lifecycleFenceOf(authorized.executionScope),
    now,
    runtimeAdmission: await runtimeAdmissionStatus(
      env,
      authorized.organisationId,
      now,
    ),
    commerceSystemReadiness: await commerceSystemReadiness(
      env,
      authorized.organisationId,
      now,
    ),
  });
  if (assessment === null) return controlError("organisation_not_found", 404);
  return controlJson({ kind: "success", assessment });
}

async function handleStageViewed(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  // A write in the person's name: the Origin and CSRF checks apply. The
  // record only says what the reader opened, so the access check discloses.
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    true,
    "disclose",
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    typeof body.value.stage !== "string" ||
    !/^[a-z][a-z0-9_:-]{0,63}$/u.test(body.value.stage)
  ) {
    return controlError("onboarding_stage_invalid", 422);
  }
  const identity = await resolveMutationUser(
    env,
    authorized.authenticated.session.userId,
  );
  if (identity instanceof Response) return identity;
  const recorded = await recordOnboardingStageViewed({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    identity: await controlMutationIdentity(request, identity, Date.now()),
    stage: body.value.stage,
  });
  return recorded.ok
    ? controlJson({ kind: "success" })
    : controlError(recorded.error.code, 404);
}

async function handleActivate(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const body = await readJsonRecord(request);
  if (
    !body.ok ||
    !isPositiveInteger(body.value.readinessVersion) ||
    typeof body.value.readinessHash !== "string" ||
    body.value.readinessHash.length === 0
  ) {
    return controlError("activation_request_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/activate`,
    operation: "organisation.activation.start",
    replay: (receipt) => activationMutationReplayResponse(authorized, receipt),
  });
  if (admitted instanceof Response) return admitted;
  const now = Date.now();
  const modelRoute = await resolveOrganisationModelRoute({
    env,
    organisationId: authorized.organisationId,
    now,
  });
  if (!modelRoute.ok) {
    return controlError(activationModelRouteError(modelRoute.error.code), 409);
  }
  // The model route resolved, so the runtime admission is available.
  await ensureCurrentReadiness({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    fence: lifecycleFenceOf(authorized.executionScope),
    now,
    runtimeAdmission: "available",
    commerceSystemReadiness: await commerceSystemReadiness(
      env,
      authorized.organisationId,
      now,
    ),
  });
  const mutationIdentity = await controlMutationIdentity(
    request,
    admitted.user,
    now,
  );
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now,
  });
  const activated = await organisation.activateOnboarding({
    organisationId: authorized.organisationId,
    readinessVersion: body.value.readinessVersion,
    readinessHash: body.value.readinessHash,
    mutation: {
      boundary: admitted.boundary,
      scope: admitted.scope,
      identity: mutationIdentity,
    },
    now,
  });
  if (!activated.ok) {
    if ("supportReference" in activated.error) {
      const projection = await mutationProjection(
        authorized,
        "failed activation projection is missing",
      );
      return controlJson(
        {
          kind: "retryable_failure",
          reason_code: activated.error.code,
          correlation_id: activated.error.correlationId,
          support_reference: activated.error.supportReference,
          projection,
        },
        503,
      );
    }
    if (activated.error.code === "activation_readiness_stale") {
      return controlJson(
        {
          ok: false,
          error: activated.error.code,
          detail: activated.error.detail,
        },
        activationErrorStatus(activated.error.code),
      );
    }
    return controlError(
      activated.error.code,
      activationErrorStatus(activated.error.code),
    );
  }
  return projectionResponse(
    authorized,
    "activated organisation projection is missing",
    {
      receipt: {
        receipt_id: mutationIdentity.receiptId,
        organisation_id: authorized.organisationId,
        activation_receipt_id: activated.value.activationReceiptId,
        first_task: activated.value.firstTask,
      },
    },
  );
}

async function activationMutationReplayResponse(
  authorized: AuthorizedOrganisationRequest,
  receipt: StoredControlMutationReceipt,
): Promise<Response> {
  if (receipt.responseStatus < 400) {
    return projectionReplay(authorized)(receipt);
  }
  if (
    !isRecord(receipt.responseBody) ||
    receipt.responseBody.organisation_id !== authorized.organisationId ||
    receipt.responseBody.kind !== "retryable_failure" ||
    typeof receipt.responseBody.reason_code !== "string" ||
    typeof receipt.responseBody.correlation_id !== "string" ||
    typeof receipt.responseBody.support_reference !== "string"
  ) {
    throw new Error("activation failure mutation receipt is invalid");
  }
  const projection = await mutationProjection(
    authorized,
    "activation failure replay projection is missing",
  );
  return controlJson(
    {
      kind: receipt.responseBody.kind,
      reason_code: receipt.responseBody.reason_code,
      correlation_id: receipt.responseBody.correlation_id,
      support_reference: receipt.responseBody.support_reference,
      projection,
    },
    receipt.responseStatus,
  );
}

function onboardingProjectionResponse(
  request: Request,
  projection: OnboardingProjection,
): Response {
  const headers = controlHeaders();
  const etag = `"organisation:${projection.organisation.organisation_id}:revision:${projection.projection_revision}"`;
  headers.set("cache-control", "private, no-cache");
  headers.set("etag", etag);
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(projection), { status: 200, headers });
}

async function handleArchive(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("archive_request_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/archive`,
    operation: "organisation.archive",
    replay: projectionReplay(authorized),
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  const archived = await archiveOrganisation({
    identityDatabase: env.DB,
    execution: authorized.executionScope,
    actorUserId: identity.userId,
    mutation: {
      boundary,
      scope,
      identity: await controlMutationIdentity(request, identity, now),
    },
    authority: { kind: "organisation_owner" },
    reasonCode: "merchant_archived",
    now,
  });
  if (!archived.ok) {
    return controlError(archived.error.code, 409);
  }
  await holdOrganisationPolicyDistribution({
    kv: env.POLICY_KV,
    organisationId: authorized.organisationId,
  });
  return projectionResponse(
    authorized,
    "archived organisation projection is missing",
    {
      receipt: {
        receipt_id: archived.value.receiptId,
        organisation_id: archived.value.organisationId,
      },
    },
  );
}

async function handleRestore(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("restore_request_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/restore`,
    operation: "organisation.restore",
    replay: projectionReplay(authorized),
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  const restored = await restoreOrganisation({
    directory: env.DB,
    execution: authorized.executionScope,
    actorUserId: identity.userId,
    mutation: {
      boundary,
      scope,
      identity: await controlMutationIdentity(request, identity, now),
    },
    now,
  });
  if (!restored.ok) {
    return controlError(restored.error.code, 409);
  }
  return projectionResponse(
    authorized,
    "restored organisation projection is missing",
    {
      receipt: {
        receipt_id: restored.value.receiptId,
        organisation_id: restored.value.organisationId,
      },
    },
  );
}
