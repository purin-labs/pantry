import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { installPantryCommerceApp } from "@purin-labs/area-commerce-contract/server/client";
import type { Env } from "@purin-labs/kernel/env";
import type { Result } from "@purin-labs/kernel/result";
import type {
  CommerceClientError,
  CommerceDemoProfile,
  CommerceMerchantSnapshotV1,
} from "@purin-labs/commerce-client";
import type { CommerceSystemSyncStatus } from "@purin-labs/area-commerce-contract/server/system-readiness";
import { readCommerceSystemSyncStatus } from "@purin-labs/area-commerce-contract/server/system-readiness";
import {
  activateCommerceCapability,
  configureCommerceCapability,
  inactivateCommerceCapability,
  listCommerceCapabilityActivations,
  parseCapabilityActivationId,
  parseCapabilityContractRevision,
  parseCapabilityScope,
  parseCommerceCapability,
  readCommerceCapabilityActivation,
  type CapabilityActivationError,
  type CapabilityContractRevision,
  type CapabilityScope,
  type CommerceCapability,
  type CommerceCapabilityActivation,
} from "../../../data/commerce-capability-activation";
import { type OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import {
  bindCommerceMerchant,
  ensureEntityPlaneCommerceMerchantBinding,
  parseCommerceBindingId,
  resolveOrganisationCommerceMerchantBinding,
} from "@purin-labs/connections/data/commerce-merchant-binding";
import {
  parseExpectedCommerceSystemRevision,
  resolveOrganisationCommerceSystem,
  resolveOrganisationCommerceSystemAuthority,
  selectOrganisationCommerceSystem,
  type CommerceSystem,
  type CommerceSystemSelection,
} from "@purin-labs/connections/data/organisation-commerce-system";
import { createCommerceOutboxReconcileQueueMessage } from "@purin-labs/area-commerce-contract/server/queue-messages";
import { commerceProvider } from "../../../commerce-providers";
import {
  newRequestId,
  parseIntegrationAccountId,
  type OrganisationId,
  organisationIdUniquePart,
} from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import { createCommerceClient } from "@purin-labs/area-commerce-contract/server/client";
import {
  admitUserMutation,
  controlMutationScope,
  parseMutationBoundary,
  replayControlMutation,
  resolveMutationUser,
} from "@purin-labs/control/worker/admission/control-mutation";
import {
  authorizeOrganisationJsonPost,
  authorizeOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "@purin-labs/control/worker/http";
import { recordCommerceMutationReceipt } from "@purin-labs/control/worker/mutation-receipt";
import {
  ensureCreatedOrganisationActor,
  readOrganisationEnvironment,
} from "@purin-labs/agent/control/organisation-runtime";
import { assertNever, decodeBase64Url } from "@purin-labs/std";

export async function handleCommerceSystem(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method === "GET") {
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const resolved = await resolveOrganisationCommerceSystem({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
    });
    if (!resolved.ok) {
      return resolved.error.code === "commerce_system_not_found"
        ? controlJson({ ok: true, commerceSystem: null, sync: null })
        : controlError(resolved.error.code, 422);
    }
    const sync = await readCommerceSystemSyncStatus({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    return sync.ok
      ? controlJson({
          ok: true,
          commerceSystem: commerceSystemWire(resolved.value),
          sync: commerceSystemSyncWire(sync.value),
        })
      : controlError(sync.error.code, 503);
  }
  if (request.method !== "PUT") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("commerce_system_invalid", 422);
  const selection = parseCommerceSystemSelectionBody(body.value);
  if (!selection.ok) return controlError(selection.error.code, 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce-system`,
    operation: "commerce_system.select",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  if (selection.value.kind === "select_shopify") {
    const environment = await readOrganisationEnvironment(
      authorized.executionScope.database,
      authorized.organisationId,
    );
    if (environment === null)
      return controlError("organisation_not_found", 404);
    const integrationAccountId = parseIntegrationAccountId(
      `integration_commerce_entity_plane_${organisationIdUniquePart(authorized.organisationId)}`,
    );
    if (!integrationAccountId.ok)
      return controlError("commerce_binding_invalid", 422);
    const commerceEngine = createCommerceClient(env, undefined, {
      kind: "operator",
    });
    if (commerceEngine === null)
      return controlError("commerce_unavailable", 503);
    const suffix = organisationIdUniquePart(
      authorized.organisationId,
    ).replaceAll("-", "_");
    const merchantId = `merchant_entity_plane_${suffix}`;
    const publicKey = crypto.getRandomValues(new Uint8Array(32));
    const provisioned = await ensureEntityPlaneCommerceMerchantBinding({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      environment,
      bindingId: `commerce_binding_entity_plane_${suffix}`,
      integrationAccountId: integrationAccountId.value,
      merchantId,
      deliverySigningKeyId: `key_entity_plane_${suffix}`,
      deliverySigningPublicKey: publicKey,
      now,
      provision: async () => {
        const result = await commerceEngine.provisionMerchant({
          schemaVersion: "commerce.provision-merchant.v2",
          externalReference: authorized.organisationId,
          merchantId,
          createdAt: new Date(now).toISOString(),
        });
        return (
          result.ok &&
          result.value.externalReference === authorized.organisationId &&
          result.value.merchantId === merchantId &&
          (await installPantryCommerceApp(
            commerceEngine,
            String(authorized.organisationId),
            merchantId,
          ))
        );
      },
    });
    if (!provisioned.ok) {
      return controlError(
        provisioned.error.code,
        provisioned.error.code === "commerce_binding_conflict" ? 409 : 503,
      );
    }
  }
  const selected = await selectOrganisationCommerceSystem({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    selectedByUserId: authorized.authenticated.session.userId,
    selection: selection.value,
    now,
  });
  if (!selected.ok) return commerceSystemErrorResponse(selected.error.code);
  const responseBody = {
    ok: true,
    outcome: selected.value.kind,
    commerceSystem: commerceSystemWire(selected.value.commerceSystem),
  };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

type ConfigureCommerceCapabilityRequest = Readonly<{
  capability: CommerceCapability;
  scope: CapabilityScope;
  contractRevision: CapabilityContractRevision;
}>;

type CommerceCapabilityActionRequest =
  | Readonly<{ kind: "activate"; expectedRevision: number }>
  | Readonly<{ kind: "inactivate"; expectedRevision: number; reason: string }>;

export async function handleCommerceCapabilities(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  activationIdRaw: string | null,
  action: "activate" | "inactivate" | null,
): Promise<Response> {
  if (request.method === "GET" && action === null) {
    return readCommerceCapabilities(
      request,
      env,
      organisationIdRaw,
      activationIdRaw,
    );
  }
  if (
    request.method !== "POST" ||
    (activationIdRaw === null) !== (action === null)
  ) {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("capability_activation_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: capabilityMutationRoute(
      authorized.organisationId,
      activationIdRaw,
      action,
    ),
    operation: capabilityMutationOperation(action),
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const now = Date.now();
  const outcome =
    action === null
      ? await configureCapabilityFromRequest({
          db: authorized.executionScope.database,
          organisationId: authorized.organisationId,
          userId: authorized.authenticated.session.userId,
          body: body.value,
          now,
        })
      : await transitionCapabilityFromRequest({
          db: authorized.executionScope.database,
          organisationId: authorized.organisationId,
          userId: authorized.authenticated.session.userId,
          activationIdRaw: requireCapabilityActivationRouteId(activationIdRaw),
          action,
          body: body.value,
          now,
        });
  if (!outcome.ok) return capabilityActivationErrorResponse(outcome.error);
  const responseBody = {
    ok: true,
    outcome: outcome.value.kind,
    activation: outcome.value.activation,
  };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function readCommerceCapabilities(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  activationIdRaw: string | null,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  if (activationIdRaw === null) {
    const listed = await listCommerceCapabilityActivations({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
    });
    return listed.ok
      ? controlJson({ ok: true, activations: listed.value })
      : capabilityActivationErrorResponse(listed.error);
  }
  const activationId = parseCapabilityActivationId(activationIdRaw);
  if (!activationId.ok)
    return capabilityActivationErrorResponse(activationId.error);
  const activation = await readCommerceCapabilityActivation({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    activationId: activationId.value,
  });
  return activation.ok
    ? controlJson({ ok: true, activation: activation.value })
    : capabilityActivationErrorResponse(activation.error);
}

async function configureCapabilityFromRequest(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    userId: UserId;
    body: JsonRecord;
    now: number;
  }>,
): Promise<
  Result<
    Readonly<{
      kind: "configured" | "already_configured";
      activation: CommerceCapabilityActivation;
    }>,
    CapabilityActivationError
  >
> {
  const parsed = parseConfigureCapabilityRequest(input.body);
  if (!parsed.ok) return parsed;
  const activationId = parseCapabilityActivationId(
    `capability_activation_${crypto.randomUUID()}`,
  );
  if (!activationId.ok) return activationId;
  return configureCommerceCapability({
    db: input.db,
    activationId: activationId.value,
    organisationId: input.organisationId,
    capability: parsed.value.capability,
    scope: parsed.value.scope,
    contractRevision: parsed.value.contractRevision,
    configuredByUserId: input.userId,
    now: input.now,
  });
}

async function transitionCapabilityFromRequest(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    userId: UserId;
    activationIdRaw: string;
    action: "activate" | "inactivate";
    body: JsonRecord;
    now: number;
  }>,
): Promise<
  Result<
    Readonly<{
      kind: "activated" | "already_active" | "inactivated";
      activation: CommerceCapabilityActivation;
    }>,
    CapabilityActivationError
  >
> {
  const activationId = parseCapabilityActivationId(input.activationIdRaw);
  if (!activationId.ok) return activationId;
  const command = parseCapabilityActionRequest(input.action, input.body);
  if (!command.ok) return command;
  switch (command.value.kind) {
    case "activate":
      return activateCommerceCapability({
        db: input.db,
        organisationId: input.organisationId,
        activationId: activationId.value,
        expectedRevision: command.value.expectedRevision,
        activatedByUserId: input.userId,
        now: input.now,
      });
    case "inactivate":
      return inactivateCommerceCapability({
        db: input.db,
        organisationId: input.organisationId,
        activationId: activationId.value,
        expectedRevision: command.value.expectedRevision,
        reason: command.value.reason,
        inactivatedByUserId: input.userId,
        now: input.now,
      });
    default:
      return command.value satisfies never;
  }
}

function parseConfigureCapabilityRequest(
  body: JsonRecord,
): Result<ConfigureCommerceCapabilityRequest, CapabilityActivationError> {
  if (Object.keys(body).length !== 3) return capabilityInvalid("body");
  const capability = parseCommerceCapability(body.capability);
  const scope = parseCapabilityScope(body.scope);
  const contractRevision = parseCapabilityContractRevision(
    body.contractRevision,
  );
  return capability.ok && scope.ok && contractRevision.ok
    ? {
        ok: true,
        value: {
          capability: capability.value,
          scope: scope.value,
          contractRevision: contractRevision.value,
        },
      }
    : capabilityInvalid("body");
}

function parseCapabilityActionRequest(
  action: "activate" | "inactivate",
  body: JsonRecord,
): Result<CommerceCapabilityActionRequest, CapabilityActivationError> {
  const expectedRevision = body.expectedRevision;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    return capabilityInvalid("expectedRevision");
  }
  switch (action) {
    case "activate":
      return Object.keys(body).length === 1
        ? { ok: true, value: { kind: "activate", expectedRevision } }
        : capabilityInvalid("body");
    case "inactivate":
      return Object.keys(body).length === 2 &&
        typeof body.reason === "string" &&
        body.reason.length > 0 &&
        body.reason.length <= 200 &&
        body.reason === body.reason.trim()
        ? {
            ok: true,
            value: {
              kind: "inactivate",
              expectedRevision,
              reason: body.reason,
            },
          }
        : capabilityInvalid("body");
  }
}

function capabilityMutationRoute(
  organisationId: OrganisationId,
  activationIdRaw: string | null,
  action: "activate" | "inactivate" | null,
): string {
  const base = `/v1/control/organisations/${organisationId}/commerce-capabilities`;
  return activationIdRaw === null || action === null
    ? base
    : `${base}/${activationIdRaw}/${action}`;
}

function capabilityMutationOperation(
  action: "activate" | "inactivate" | null,
): string {
  switch (action) {
    case null:
      return "commerce_capability.configure";
    case "activate":
      return "commerce_capability.activate";
    case "inactivate":
      return "commerce_capability.inactivate";
  }
}

function capabilityActivationErrorResponse(
  error: CapabilityActivationError,
): Response {
  switch (error.code) {
    case "capability_activation_invalid":
      return controlError(error.code, 422);
    case "capability_activation_not_found":
      return controlError(error.code, 404);
    case "capability_activation_conflict":
    case "capability_activation_revision_conflict":
    case "capability_activation_lifecycle_conflict":
    case "capability_activation_authority_mismatch":
      return controlError(error.code, 409);
  }
}

function capabilityInvalid(
  field: string,
): Result<never, CapabilityActivationError> {
  return {
    ok: false,
    error: { code: "capability_activation_invalid", field },
  };
}

function commerceSystemSyncWire(sync: CommerceSystemSyncStatus): unknown {
  switch (sync.kind) {
    case "syncing":
      return {
        kind: sync.kind,
        acceptedResourceCount: sync.acceptedResourceCount,
      };
    case "ready":
    case "delayed":
      return {
        kind: sync.kind,
        acceptedResourceCount: sync.acceptedResourceCount,
        lastSyncedAt: sync.lastSyncedAt,
      };
    default:
      return assertNever(sync);
  }
}

export async function handleCommerceSystemSync(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const started = await authorizeOrganisationJsonPost(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
    "commerce_system_sync_invalid",
  );
  if (!started.ok) return started.response;
  const { authorized, body } = started;
  if (Object.keys(body).length !== 0)
    return controlError("commerce_system_sync_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body,
    boundary: "unversioned",
    user: "after_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce-system/sync`,
    operation: "commerce_system.sync",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  if (!authority.ok) return commerceSystemErrorResponse(authority.error.code);
  if (authority.value.provider !== "commerce") {
    return controlError("commerce_system_sync_managed_by_shopify", 409);
  }
  const now = Date.now();
  try {
    await env.EVENT_Q.send(
      createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: now,
        organisationId: authorized.organisationId,
        integrationAccountId: authority.value.integrationAccountId,
      }),
      { contentType: "json" },
    );
  } catch {
    return controlError("commerce_reconciliation_unavailable", 503);
  }
  const responseBody = {
    ok: true,
    outcome: "sync_queued",
    commerceSystem: commerceSystemWire(authority.value.commerceSystem),
  };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

function parseCommerceSystemSelectionBody(
  body: JsonRecord,
): Result<
  CommerceSystemSelection,
  { readonly code: "commerce_system_invalid" }
> {
  const expectedRevision = parseExpectedCommerceSystemRevision(
    body.expected_revision,
  );
  if (!expectedRevision.ok)
    return { ok: false, error: { code: "commerce_system_invalid" } };
  switch (body.kind) {
    case "select_builtin_commerce": {
      const bindingId = parseCommerceBindingId(body.commerce_binding_id);
      return bindingId.ok
        ? {
            ok: true,
            value: {
              kind: "select_builtin_commerce",
              expectedRevision: expectedRevision.value,
              commerceBindingId: bindingId.value,
            },
          }
        : { ok: false, error: { code: "commerce_system_invalid" } };
    }
    case "select_shopify": {
      const integrationAccountId =
        typeof body.integration_account_id === "string"
          ? parseIntegrationAccountId(body.integration_account_id)
          : null;
      return integrationAccountId !== null && integrationAccountId.ok
        ? {
            ok: true,
            value: {
              kind: "select_shopify",
              expectedRevision: expectedRevision.value,
              integrationAccountId: integrationAccountId.value,
            },
          }
        : { ok: false, error: { code: "commerce_system_invalid" } };
    }
    default:
      return { ok: false, error: { code: "commerce_system_invalid" } };
  }
}

function commerceSystemWire(system: CommerceSystem): unknown {
  return commerceProvider(system.kind).wire(system);
}

function commerceSystemErrorResponse(code: string): Response {
  switch (code) {
    case "commerce_system_not_found":
      return controlError(code, 404);
    case "commerce_system_invalid":
      return controlError(code, 422);
    case "commerce_system_authority_mismatch":
    case "commerce_system_revision_conflict":
    case "commerce_system_switch_requires_migration":
      return controlError(code, 409);
    default:
      return controlError("commerce_system_invalid", 422);
  }
}

export async function handlePantryCommerceDemo(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const started = await authorizeOrganisationJsonPost(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
    "builtin_commerce_setup_invalid",
  );
  if (!started.ok) return started.response;
  const { authorized, body } = started;
  const demo = parsePantryCommerceDemoRequest(body);
  if (demo === null) return controlError("builtin_commerce_setup_invalid", 422);
  const boundary = await parseMutationBoundary(
    request,
    body,
    "unversioned",
  );
  if (boundary instanceof Response) return boundary;
  await ensureCreatedOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  const scope = controlMutationScope(
    authorized,
    `/v1/control/organisations/${authorized.organisationId}/commerce-system/builtin-commerce/demo`,
    "builtin_commerce.demo.provision",
  );
  const replayed = await replayControlMutation({
    db: authorized.executionScope.database,
    scope,
    boundary,
  });
  if (replayed !== null) return replayed;
  const identity = await resolveMutationUser(
    env,
    authorized.authenticated.session.userId,
  );
  if (identity instanceof Response) return identity;
  const environment = await readOrganisationEnvironment(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  if (environment === null) return controlError("organisation_not_found", 404);
  const commerceEngine = createCommerceClient(env, undefined, {
    kind: "operator",
  });
  if (commerceEngine === null)
    return controlError("commerce_unavailable", 503);
  const now = Date.now();
  const suffix = organisationIdUniquePart(authorized.organisationId).replaceAll(
    "-",
    "_",
  );
  const merchantId = `merchant_pantry_${suffix}`;
  const snapshot = await commerceEngine.provisionDemo({
    schemaVersion: "commerce.provision-demo.v2",
    externalReference: authorized.organisationId,
    merchantId,
    profile: demo.profile,
    createdAt: new Date(now).toISOString(),
  });
  if (!snapshot.ok) return commerceDemoProvisionErrorResponse(snapshot.error);
  if (
    !(await installPantryCommerceApp(
      commerceEngine,
      String(authorized.organisationId),
      merchantId,
    ))
  )
    return controlError("commerce_unavailable", 503);
  const existingBinding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  const binding = existingBinding.ok
    ? existingBinding
    : await bindDemoCommerceMerchant({
        db: authorized.executionScope.database,
        organisationId: authorized.organisationId,
        environment,
        merchantId,
        suffix,
        snapshot: snapshot.value,
        now,
      });
  if (!binding.ok || binding.value.merchantId !== merchantId) {
    return controlError("commerce_binding_conflict", 409);
  }
  const current = await resolveOrganisationCommerceSystem({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  const selected = await selectOrganisationCommerceSystem({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    selectedByUserId: authorized.authenticated.session.userId,
    selection: {
      kind: "select_builtin_commerce",
      expectedRevision: current.ok ? current.value.revision : 0,
      commerceBindingId: binding.value.bindingId,
    },
    now,
  });
  if (!selected.ok) return commerceSystemErrorResponse(selected.error.code);
  try {
    await env.EVENT_Q.send(
      createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: now,
        organisationId: authorized.organisationId,
        integrationAccountId: binding.value.integrationAccountId,
      }),
      { contentType: "json" },
    );
  } catch {
    return controlError("commerce_reconciliation_unavailable", 503);
  }
  const responseBody = {
    ok: true,
    profile: demo.profile,
    commerceSystem: commerceSystemWire(selected.value.commerceSystem),
    products: snapshot.value.resources.products.length,
    orders: snapshot.value.resources.orders.length,
    sync: "queued",
  };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

type PantryCommerceDemoRequest = Readonly<{
  profile: CommerceDemoProfile;
}>;

function parsePantryCommerceDemoRequest(
  value: Readonly<Record<string, unknown>>,
): PantryCommerceDemoRequest | null {
  if (Object.keys(value).length !== 1) return null;
  switch (value.profile) {
    case "cafe_patisserie":
    case "pantry_ecommerce":
      return { profile: value.profile };
    default:
      return null;
  }
}

function commerceDemoProvisionErrorResponse(
  error: CommerceClientError,
): Response {
  switch (error.kind) {
    case "http":
      return error.status === 409
        ? controlError("commerce_demo_profile_conflict", 409)
        : controlError("commerce_demo_provision_failed", 503);
    case "network":
    case "invalid_response":
      return controlError("commerce_demo_provision_failed", 503);
    case "rejected":
      return controlError("commerce_demo_profile_conflict", 409);
    default:
      return assertNever(error);
  }
}

async function bindDemoCommerceMerchant(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    environment: OrganisationEnvironment;
    merchantId: string;
    suffix: string;
    snapshot: CommerceMerchantSnapshotV1;
    now: number;
  }>,
): Promise<Awaited<ReturnType<typeof bindCommerceMerchant>>> {
  const signingKeyId = normalizedCommerceIdentity(
    input.snapshot.deliverySigner.keyId,
    "key_",
  );
  const signingPublicKey = decodeBase64Url(
    input.snapshot.deliverySigner.publicKeyB64,
  );
  const integrationAccountId = parseIntegrationAccountId(
    `integration_commerce_pantry_${input.suffix}`,
  );
  if (
    signingKeyId === null ||
    signingPublicKey === null ||
    signingPublicKey.byteLength !== 32 ||
    !integrationAccountId.ok
  ) {
    return {
      ok: false,
      error: { code: "commerce_binding_invalid", field: "demo" },
    };
  }
  return bindCommerceMerchant({
    db: input.db,
    bindingId: `commerce_binding_pantry_${input.suffix}`,
    organisationId: input.organisationId,
    integrationAccountId: integrationAccountId.value,
    merchantId: input.merchantId,
    environment: input.environment,
    deliverySigningKeyId: signingKeyId,
    deliverySigningPublicKey: signingPublicKey,
    now: input.now,
  });
}

function normalizedCommerceIdentity(
  value: unknown,
  prefix: string,
): string | null {
  return typeof value === "string" &&
    value.startsWith(prefix) &&
    /^[a-z0-9_-]{8,160}$/u.test(value)
    ? value
    : null;
}

function requireCapabilityActivationRouteId(raw: string | null): string {
  if (raw === null)
    throw new Error("commerce capability activation route invariant failed");
  return raw;
}
