import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "../../organisation-execution-scope";
import {
  parseInstallModel,
  parseSurfaceKind,
  readNumberField,
  readStringArrayField,
  readStringField,
  readOrganisationIdField,
  readWorkspaceIdField,
  type FieldError,
} from "../../boundary";
import {
  createOrganisationInstallPreservingExistingInstallModel,
  resolveInstallOrganisation,
  type OrganisationInstallSeed,
} from "../../data/organisation";
import { resolveOrganisationCommerceSystemAuthority } from "../../data/organisation-commerce-system";
import type { OrganisationEnvironment } from "../../data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import {
  requireActiveOrganisationActor,
  requireActiveOrganisationActorAtPlacement,
} from "../../actors/actor-router";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
  type JsonObject,
} from "@purin-labs/kernel/http";
import {
  newRequestId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseInitialOrganisationPlacement } from "../../placement";
import type { Result } from "@purin-labs/kernel/result";
import { assertNever } from "@purin-labs/std";
import { fieldErrorResponse, isAuthorizedFaultInjectionRequest, isLocalDebugRequest, jsonBodyErrorResponse, parseOrganisationPath, parseSurfaceKindPath, parseWorkspacePath, routeParamErrorResponse } from "../request-helpers";

export async function handleCreateOrganisationInstall(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (!isLocalDebugRequest(request)) {
    return notFound();
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const seed = parseOrganisationInstallSeed(body.value, Date.now());

  if (!seed.ok) {
    return fieldErrorResponse(seed.error);
  }

  const execution = await OrganisationExecutionScope.resolveAtPlacement(
    env,
    seed.value.organisationId,
    seed.value.placement,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "Create the organisation through onboarding before installing a provider.",
      409,
    );
  }
  const record = await createOrganisationInstallPreservingExistingInstallModel(
    execution.value.database,
    env.DB,
    seed.value,
  );
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: record.organisationId,
    now: seed.value.createdAt,
  });
  const organisationMeta = await organisation.ensureOrganisation({
    organisationId: record.organisationId,
    name: record.name,
    plan: record.plan,
    status: record.organisationStatus,
    createdAt: seed.value.createdAt,
  });

  return jsonResponse(
    { ok: true, organisationInstall: record, organisation: organisationMeta },
    201,
  );
}

export async function handleResolveInstall(
  request: Request,
  env: Env,
  surfaceKindRaw: string,
  workspaceIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const surfaceKind = parseSurfaceKindPath(surfaceKindRaw);

  if (!surfaceKind.ok) {
    return routeParamErrorResponse(surfaceKind.error);
  }

  const workspaceId = parseWorkspacePath(workspaceIdRaw);

  if (!workspaceId.ok) {
    return routeParamErrorResponse(workspaceId.error);
  }

  if (surfaceKind.value === "slack") {
    return errorResponse(
      "slack_route_required",
      "Slack installations require a channel route or thread pin.",
      409,
    );
  }

  let install: Awaited<
    ReturnType<typeof createOrganisationInstallPreservingExistingInstallModel>
  > | null = null;
  for (const database of configuredOrganisationDatabases(env)) {
    const result = await resolveInstallOrganisation(database, {
      surfaceKind: surfaceKind.value,
      workspaceId: workspaceId.value,
    });
    if (!result.ok) continue;
    const execution = await OrganisationExecutionScope.resolve(
      env,
      result.value.organisationId,
    );
    if (!execution.ok) {
      return errorResponse(
        execution.error.code,
        "The organisation region is unavailable.",
        503,
      );
    }
    if (execution.value.database !== database) continue;
    if (install !== null) {
      return errorResponse(
        "install_ambiguous",
        "Workspace has more than one active installation.",
        409,
      );
    }
    install = result.value;
  }
  if (install === null) {
    return errorResponse("install_not_found", "Install was not found.", 404);
  }
  return jsonResponse({ ok: true, organisationInstall: install });
}

export async function handleOrganisationPing(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const organisationId = parseOrganisationPath(organisationIdRaw);

  if (!organisationId.ok) {
    return routeParamErrorResponse(organisationId.error);
  }

  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: organisationId.value,
    now: Date.now(),
  });
  const result = await organisation.ping();

  return jsonResponse(result);
}

/** The actor class that the ORGANISATION binding names. */
type OrganisationActor =
  Env["ORGANISATION"] extends DurableObjectNamespace<infer TActor>
    ? TActor
    : never;

/**
 * The head of a route that arms, reads or clears an acceptance fault: GET,
 * POST or DELETE, a local request or the fault injection bearer, and an
 * Organisation in the development environment. A failure is the answer of
 * the route.
 */
async function readAcceptanceFaultRequest(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<
  Result<
    Readonly<{
      method: "POST" | "GET" | "DELETE";
      scope: OrganisationExecutionScope;
      organisationId: OrganisationId;
      organisation: DurableObjectStub<OrganisationActor>;
      now: number;
    }>,
    Response
  >
> {
  const method = request.method;
  if (method !== "POST" && method !== "GET" && method !== "DELETE") {
    return { ok: false, error: methodNotAllowed(["POST", "GET", "DELETE"]) };
  }
  if (
    !isLocalDebugRequest(request) &&
    !isAuthorizedFaultInjectionRequest(request, env)
  ) {
    return { ok: false, error: notFound() };
  }
  const organisationId = parseOrganisationPath(organisationIdRaw);
  if (!organisationId.ok) {
    return { ok: false, error: routeParamErrorResponse(organisationId.error) };
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) {
    return {
      ok: false,
      error: errorResponse(
        execution.error.code,
        "The organisation region is unavailable.",
        503,
      ),
    };
  }
  const scope = execution.value;
  const environment = await readOnboardingAcceptanceEnvironment(
    scope.database,
    organisationId.value,
  );
  if (environment !== "development") {
    return { ok: false, error: notFound() };
  }
  const now = Date.now();
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId: organisationId.value,
    placement: scope.placement,
    now,
  });
  return {
    ok: true,
    value: {
      method,
      scope,
      organisationId: organisationId.value,
      organisation,
      now,
    },
  };
}

export async function handleOnboardingActivationAcceptance(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const head = await readAcceptanceFaultRequest(
    request,
    env,
    organisationIdRaw,
  );
  if (!head.ok) return head.error;
  const { method, organisation, now } = head.value;
  switch (method) {
    case "POST": {
      const armed = await organisation.armOnboardingActivationAcceptanceFault({
        requestId: newRequestId(),
        phase: "placement",
        armedAt: now,
      });
      return armed.ok
        ? jsonResponse({ ok: true, fault: armed.value })
        : errorResponse(
            armed.error.code,
            "Activation acceptance fault is invalid.",
            422,
          );
    }
    case "GET": {
      const inspected =
        await organisation.inspectOnboardingActivationAcceptanceFault();
      return inspected.ok
        ? jsonResponse({ ok: true, inspection: inspected.value })
        : errorResponse(
            inspected.error.code,
            "Activation acceptance fault is invalid.",
            422,
          );
    }
    case "DELETE":
      await organisation.clearOnboardingActivationAcceptanceFault();
      return jsonResponse({ ok: true, cleared: true });
    default:
      return assertNever(method);
  }
}

export async function handleCafeCommerceAcceptance(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const head = await readAcceptanceFaultRequest(
    request,
    env,
    organisationIdRaw,
  );
  if (!head.ok) return head.error;
  const { method, scope, organisationId, organisation, now } = head.value;
  if (method === "GET") {
    return jsonResponse({
      ok: true,
      fault: await organisation.inspectCafeCommerceAcceptanceFault(),
    });
  }
  if (method === "DELETE") {
    await organisation.clearCafeCommerceAcceptanceFault();
    return jsonResponse({ ok: true, cleared: true });
  }
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: scope.database,
    organisationId,
  });
  if (
    !authority.ok ||
    authority.value.provider !== "commerce" ||
    authority.value.commerceSystem.kind !== "builtin_commerce"
  ) {
    return errorResponse(
      "cafe_commerce_acceptance_authority_unavailable",
      "Cafe commerce acceptance authority is unavailable.",
      409,
    );
  }
  const fault = await organisation.armCafeCommerceAcceptanceFault({
    requestId: newRequestId(),
    merchantId: authority.value.commerceSystem.merchantId,
    armedAt: now,
  });
  return jsonResponse({ ok: true, fault });
}

async function readOnboardingAcceptanceEnvironment(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<OrganisationEnvironment | null> {
  const row = await db
    .prepare(
      `SELECT environment FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{ readonly environment: unknown }>();
  return row?.environment === "development" || row?.environment === "production"
    ? row.environment
    : null;
}

function parseOrganisationInstallSeed(
  body: JsonObject,
  now: number,
): Result<OrganisationInstallSeed, FieldError> {
  const organisationId = readOrganisationIdField(body);

  if (!organisationId.ok) {
    return organisationId;
  }

  const name = readStringField(body, "name");

  if (!name.ok) {
    return name;
  }

  const surfaceKindRaw = readStringField(body, "surfaceKind");

  if (!surfaceKindRaw.ok) {
    return surfaceKindRaw;
  }

  const surfaceKind = parseSurfaceKind(surfaceKindRaw.value);

  if (!surfaceKind.ok) {
    return surfaceKind;
  }

  const workspaceId = readWorkspaceIdField(body);

  if (!workspaceId.ok) {
    return workspaceId;
  }

  const installModelRaw = readStringField(body, "installModel");

  if (!installModelRaw.ok) {
    return installModelRaw;
  }

  const installModel = parseInstallModel(installModelRaw.value);

  if (!installModel.ok) {
    return installModel;
  }

  const botTokenRef = readStringField(body, "botTokenRef");

  if (!botTokenRef.ok) {
    return botTokenRef;
  }

  const scopes = readStringArrayField(body, "scopes");

  if (!scopes.ok) {
    return scopes;
  }

  const placement = parseInitialOrganisationPlacement(
    body.placement,
    "placement",
  );

  if (!placement.ok) {
    return { ok: false, error: { code: "invalid_field", field: "placement" } };
  }

  const createdAt = readNumberField(body, "createdAt", now);

  if (!createdAt.ok) {
    return createdAt;
  }

  const installedAt = readNumberField(body, "installedAt", now);

  if (!installedAt.ok) {
    return installedAt;
  }

  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      name: name.value,
      surfaceKind: surfaceKind.value,
      workspaceId: workspaceId.value,
      installModel: installModel.value,
      botTokenRef: botTokenRef.value,
      scopes: scopes.value,
      placement: placement.value,
      createdAt: createdAt.value,
      installedAt: installedAt.value,
    },
  };
}
