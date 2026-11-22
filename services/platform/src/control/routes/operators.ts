import { configuredOrganisationDatabases } from "@purin-labs/tenancy/organisation-execution-scope";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import { requireActiveOrganisationActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  parseVaultRootRotationId,
  parseVaultRotationBatchLimit,
  pauseVaultRootRotation,
  readVaultRootRotation,
  resumeVaultRootRotation,
  runVaultRootRotationStep,
  startVaultRootRotation,
  type VaultRootRotationError,
} from "@purin-labs/authority/credential-vault/index";
import type { ActivationMutation } from "../../data/activation";
import { disableIntegrationAccount } from "@purin-labs/connections/data/integration-account";
import { inboxServices } from "../../mail-inbox/contract/inbox-services";
import {
  hashOpaqueSecret,
  type ActiveControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import {
  prepareControlMutationReceipt,
  prepareOnboardingAuditEvent,
  type ControlMutationReceiptScope,
} from "@purin-labs/tenancy/data/control-mutation";
import {
  lookupOperatorOnboardingCases,
  readMerchantSupportDiagnostics,
  resolveControlSupportRole,
  type OperatorOnboardingLookup,
} from "../../data/onboarding-support";
import {
  inspectOrganisationHarnessHistory,
  readOrganisationHarnessErasureReceipts,
  reconcileOrganisationOnboarding,
} from "../../data/onboarding-reconciliation";
import {
  cancelProviderAttempt,
  providerAttemptWire,
} from "@purin-labs/connections/data/provider-attempt";
import { archiveOrganisation } from "@purin-labs/tenancy/data/organisation-lifecycle";
import {
  parseIntegrationAccountId,
  parseProviderConnectionAttemptId,
  parseOrganisationId,
  type IntegrationAccountId,
  type ProviderConnectionAttemptId,
} from "@purin-labs/kernel/ids";
import { holdOrganisationPolicyDistribution } from "@purin-labs/authority/policy-snapshot";
import {
  controlMutationIdentity,
  parseMutationBoundary,
  replayControlMutation,
  resolveMutationUser,
} from "@purin-labs/control/worker/admission/control-mutation";
import {
  authenticateControlMutation,
  authenticateControlRead,
  authorizeOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "@purin-labs/control/worker/http";
import {
  activationErrorStatus,
  runtimeAdmissionStatus,
} from "../onboarding-runtime";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isPositiveInteger } from "@purin-labs/std";
import { readOnboardingRow } from "@purin-labs/tenancy/data/organisation-onboarding-row";
import { operatorSupportAccessStatement } from "../../data/onboarding-support-audit";

type OperatorOnboardingAction =
  | {
      readonly kind: "invalidate_attempt";
      readonly attemptId: ProviderConnectionAttemptId;
    }
  | {
      readonly kind: "disable_account";
      readonly integrationAccountId: IntegrationAccountId;
      readonly replacementIntegrationAccountId: IntegrationAccountId | null;
    }
  | {
      readonly kind: "resume_activation";
      readonly readinessVersion: number;
      readonly readinessHash: string;
    }
  | { readonly kind: "archive_ownerless_legacy_organisation" };

export type OperatorControlRoute =
  | Readonly<{
      kind: "merchantSupport";
      organisationIdRaw: string;
      supportReferenceRaw: string;
    }>
  | Readonly<{ kind: "operatorOnboarding" }>
  | Readonly<{ kind: "operatorGmailPilotBudget" }>
  | Readonly<{ kind: "operatorVaultRootRotations" }>
  | Readonly<{ kind: "operatorVaultRootRotation"; rotationIdRaw: string }>
  | Readonly<{
      kind: "operatorVaultRootRotationAction";
      rotationIdRaw: string;
      action: "step" | "pause" | "resume";
    }>
  | Readonly<{ kind: "operatorReconcile"; organisationIdRaw: string }>
  | Readonly<{ kind: "operatorAction"; organisationIdRaw: string }>
  | Readonly<{ kind: "operatorHarnessHistory"; organisationIdRaw: string }>
  | Readonly<{ kind: "operatorHarnessErasure"; organisationIdRaw: string }>;

export function matchOperatorControlRoute(
  pathname: string,
): OperatorControlRoute | null {
  switch (pathname) {
    case "/v1/control/operator/onboarding":
      return { kind: "operatorOnboarding" };
    case "/v1/control/operator/gmail-pilot-budget":
      return { kind: "operatorGmailPilotBudget" };
    case "/v1/control/operator/vault/root-rotations":
      return { kind: "operatorVaultRootRotations" };
  }
  const rotationAction =
    /^\/v1\/control\/operator\/vault\/root-rotations\/([^/]+)\/(step|pause|resume)$/u.exec(
      pathname,
    );
  if (
    rotationAction?.[1] !== undefined &&
    isRotationAction(rotationAction[2])
  ) {
    return {
      kind: "operatorVaultRootRotationAction",
      rotationIdRaw: decodeURIComponent(rotationAction[1]),
      action: rotationAction[2],
    };
  }
  const rotation =
    /^\/v1\/control\/operator\/vault\/root-rotations\/([^/]+)$/u.exec(pathname);
  if (rotation?.[1] !== undefined) {
    return {
      kind: "operatorVaultRootRotation",
      rotationIdRaw: decodeURIComponent(rotation[1]),
    };
  }
  const support =
    /^\/v1\/control\/organisations\/([^/]+)\/support\/([^/]+)$/u.exec(pathname);
  if (support?.[1] !== undefined && support[2] !== undefined) {
    return {
      kind: "merchantSupport",
      organisationIdRaw: decodeURIComponent(support[1]),
      supportReferenceRaw: decodeURIComponent(support[2]),
    };
  }
  const operator =
    /^\/v1\/control\/operator\/organisations\/([^/]+)\/(reconcile|actions|harness-history|harness-erasure)$/u.exec(
      pathname,
    );
  if (operator?.[1] === undefined || operator[2] === undefined) return null;
  const organisationIdRaw = decodeURIComponent(operator[1]);
  switch (operator[2]) {
    case "reconcile":
      return { kind: "operatorReconcile", organisationIdRaw };
    case "actions":
      return { kind: "operatorAction", organisationIdRaw };
    case "harness-history":
      return { kind: "operatorHarnessHistory", organisationIdRaw };
    case "harness-erasure":
      return { kind: "operatorHarnessErasure", organisationIdRaw };
    default:
      return null;
  }
}

function isRotationAction(
  value: string | undefined,
): value is "step" | "pause" | "resume" {
  return value === "step" || value === "pause" || value === "resume";
}

export function handleOperatorControlRoute(
  request: Request,
  env: Env,
  route: OperatorControlRoute,
  url: URL,
): Promise<Response> {
  switch (route.kind) {
    case "merchantSupport":
      return handleMerchantSupport(
        request,
        env,
        route.organisationIdRaw,
        route.supportReferenceRaw,
      );
    case "operatorOnboarding":
      return handleOperatorOnboarding(request, env, url);
    case "operatorGmailPilotBudget":
      return handleOperatorGmailPilotBudget(request, env);
    case "operatorVaultRootRotations":
      return handleOperatorVaultRootRotations(request, env);
    case "operatorVaultRootRotation":
      return handleOperatorVaultRootRotation(request, env, route.rotationIdRaw);
    case "operatorVaultRootRotationAction":
      return handleOperatorVaultRootRotationAction(
        request,
        env,
        route.rotationIdRaw,
        route.action,
      );
    case "operatorReconcile":
      return handleOperatorReconcile(request, env, route.organisationIdRaw);
    case "operatorAction":
      return handleOperatorAction(request, env, route.organisationIdRaw);
    case "operatorHarnessHistory":
      return handleOperatorHarnessHistory(
        request,
        env,
        route.organisationIdRaw,
      );
    case "operatorHarnessErasure":
      return handleOperatorHarnessErasure(
        request,
        env,
        route.organisationIdRaw,
      );
    default:
      return assertNever(route);
  }
}

async function handleMerchantSupport(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  supportReferenceRaw: string,
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
  if (!/^PANTRY-[A-Za-z0-9-]{16,80}$/u.test(supportReferenceRaw)) {
    return controlError("support_reference_not_found", 404);
  }
  const diagnostics = await readMerchantSupportDiagnostics({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    supportReference: supportReferenceRaw,
  });
  return diagnostics.ok
    ? controlJson({ kind: "success", diagnostics: diagnostics.value })
    : controlError(diagnostics.error.code, 404);
}

/**
 * Consumption of the Google project's test-user allowance.
 *
 * This is deployment-wide, not organisation-scoped, so it stays behind the support
 * role: telling one organisation how many Google accounts every other organisation has
 * connected would disclose Pantry's customer count to its customers. Operators
 * need it because the allowance is a lifetime budget — capacity spent is not
 * returned when a mailbox is revoked — and verification has to be started
 * before the budget runs out, not after.
 */
async function handleOperatorGmailPilotBudget(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authenticated = await authenticateControlRead(request, env);
  if (!authenticated.ok) return authenticated.response;
  const role = await resolveControlSupportRole({
    db: env.DB,
    userId: authenticated.value.session.userId,
  });
  if (role === null) return controlError("support_role_required", 403);
  const budgets = await Promise.all(
    (["development", "production"] as const).map((environment) =>
      inboxServices.use().readGmailPilotBudget({
        databases: configuredOrganisationDatabases(env),
        environment,
        operatingCap: positiveConfigInteger(env.GMAIL_PILOT_ACCOUNT_CAP, 80),
        submissionTrigger: positiveConfigInteger(
          env.GMAIL_PILOT_SUBMISSION_TRIGGER,
          50,
        ),
      }),
    ),
  );
  return controlJson({
    ok: true,
    budgets: budgets.map((budget) => ({
      environment: budget.environment,
      consumed_google_accounts: budget.consumed,
      operating_cap: budget.operatingCap,
      submission_trigger: budget.submissionTrigger,
      remaining: budget.remaining,
      status: budget.status,
    })),
  });
}

function positiveConfigInteger(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = Number(raw ?? "");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function handleOperatorOnboarding(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authenticated = await authenticateControlRead(request, env);
  if (!authenticated.ok) {
    return authenticated.response;
  }
  const role = await resolveControlSupportRole({
    db: env.DB,
    userId: authenticated.value.session.userId,
  });
  if (role === null) {
    return controlError("support_role_required", 403);
  }
  const lookup = parseOperatorOnboardingLookup(url.searchParams);
  if (lookup === null) {
    return controlError("support_lookup_invalid", 422);
  }
  const cases = await lookupOperatorOnboardingCases({ env, lookup });
  const now = Date.now();
  const lookupHash = await hashOpaqueSecret(lookup.value);
  const statements: D1PreparedStatement[] = [];
  if (cases.length === 0) {
    statements.push(
      operatorSupportAccessStatement(
        env.DB,
        role.userId,
        role.kind,
        lookup,
        lookupHash,
        null,
        now,
      ),
    );
  } else {
    for (const onboardingCase of cases) {
      statements.push(
        operatorSupportAccessStatement(
          env.DB,
          role.userId,
          role.kind,
          lookup,
          lookupHash,
          onboardingCase.organisationId,
          now,
        ),
      );
    }
  }
  await env.DB.batch(statements);
  return controlJson({ kind: "success", cases });
}

async function handleOperatorVaultRootRotations(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }

  const authorized = await authorizeSupportAdmin(request, env, true);

  if (!authorized.ok) {
    return authorized.response;
  }

  const body = await readJsonRecord(request);

  if (
    !body.ok ||
    Object.keys(body.value).length !== 1 ||
    (body.value.sourceVersion !== "v1" && body.value.sourceVersion !== "v2")
  ) {
    return controlError("vault_root_rotation_request_invalid", 422);
  }

  const rotationId = parseVaultRootRotationId(
    `vrot_${crypto.randomUUID().toLowerCase()}`,
  );

  if (!rotationId.ok) {
    throw new Error("generated Vault root rotation id is invalid");
  }

  const started = await startVaultRootRotation({
    db: env.DB,
    databases: configuredOrganisationDatabases(env),
    keys: env,
    rotationId: rotationId.value,
    sourceVersion: body.value.sourceVersion,
    now: Date.now(),
  });

  return started.ok
    ? controlJson({ kind: "success", rotation: started.value }, 201)
    : vaultRootRotationErrorResponse(started.error);
}

async function handleOperatorVaultRootRotation(
  request: Request,
  env: Env,
  rotationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }

  const authorized = await authorizeSupportAdmin(request, env, false);

  if (!authorized.ok) {
    return authorized.response;
  }

  const rotationId = parseVaultRootRotationId(rotationIdRaw);

  if (!rotationId.ok) {
    return controlError("vault_root_rotation_not_found", 404);
  }

  const loaded = await readVaultRootRotation({
    db: env.DB,
    rotationId: rotationId.value,
  });

  return loaded.ok
    ? controlJson({ kind: "success", rotation: loaded.value })
    : vaultRootRotationErrorResponse(loaded.error);
}

async function handleOperatorVaultRootRotationAction(
  request: Request,
  env: Env,
  rotationIdRaw: string,
  action: "step" | "pause" | "resume",
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }

  const authorized = await authorizeSupportAdmin(request, env, true);

  if (!authorized.ok) {
    return authorized.response;
  }

  const rotationId = parseVaultRootRotationId(rotationIdRaw);

  if (!rotationId.ok) {
    return controlError("vault_root_rotation_not_found", 404);
  }

  const body = await readJsonRecord(request);

  if (!body.ok) {
    return controlError("vault_root_rotation_request_invalid", 422);
  }

  const now = Date.now();

  switch (action) {
    case "step": {
      if (Object.keys(body.value).length !== 1) {
        return controlError("vault_root_rotation_request_invalid", 422);
      }

      const limit = parseVaultRotationBatchLimit(body.value.limit);

      if (!limit.ok) {
        return controlError("vault_root_rotation_batch_limit_invalid", 422);
      }

      const stepped = await runVaultRootRotationStep({
        db: env.DB,
        databases: configuredOrganisationDatabases(env),
        keys: env,
        rotationId: rotationId.value,
        limit: limit.value,
        now,
      });

      return stepped.ok
        ? controlJson({ kind: "success", rotation: stepped.value })
        : vaultRootRotationErrorResponse(stepped.error);
    }
    case "pause": {
      if (Object.keys(body.value).length !== 0) {
        return controlError("vault_root_rotation_request_invalid", 422);
      }

      const paused = await pauseVaultRootRotation({
        db: env.DB,
        rotationId: rotationId.value,
        now,
      });

      return paused.ok
        ? controlJson({ kind: "success", rotation: paused.value })
        : vaultRootRotationErrorResponse(paused.error);
    }
    case "resume": {
      if (Object.keys(body.value).length !== 0) {
        return controlError("vault_root_rotation_request_invalid", 422);
      }

      const resumed = await resumeVaultRootRotation({
        db: env.DB,
        rotationId: rotationId.value,
        now,
      });

      return resumed.ok
        ? controlJson({ kind: "success", rotation: resumed.value })
        : vaultRootRotationErrorResponse(resumed.error);
    }
    default:
      return assertNever(action);
  }
}

async function handleOperatorReconcile(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authenticated = await authenticateControlMutation(request, env);
  if (!authenticated.ok) {
    return authenticated.response;
  }
  const role = await resolveControlSupportRole({
    db: env.DB,
    userId: authenticated.value.session.userId,
  });
  if (role?.kind !== "support_admin") {
    return controlError("support_admin_role_required", 403);
  }
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) {
    return controlError("organisation_not_found", 404);
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const placement = execution.value;
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("reconciliation_request_invalid", 422);
  }
  const boundary = await parseMutationBoundary(
    request,
    body.value,
    "configuration_versioned",
  );
  if (boundary instanceof Response) return boundary;
  const before = await readOnboardingRow(
    placement.database,
    organisationId.value,
  );
  if (before === null) {
    return controlError("organisation_not_found", 404);
  }
  if (before.configurationVersion !== boundary.expectedConfigurationVersion) {
    return controlError("configuration_version_conflict", 409);
  }
  if (
    (before.environment !== "development" &&
      before.environment !== "production") ||
    typeof before.lifecycle !== "string"
  ) {
    throw new Error("operator reconciliation organisation state is invalid");
  }
  const identity = await resolveMutationUser(env, role.userId);
  if (identity instanceof Response) return identity;
  const scope: ControlMutationReceiptScope = {
    userId: role.userId,
    organisationScope: organisationId.value,
    route: `/v1/control/operator/organisations/${organisationId.value}/reconcile`,
    operation: "onboarding.reconcile",
  };
  const replayed = await replayControlMutation({
    db: placement.database,
    scope,
    boundary,
  });
  if (replayed !== null) return replayed;
  const now = Date.now();
  const mutationIdentity = await controlMutationIdentity(
    request,
    identity,
    now,
  );
  const reconciled = await reconcileOrganisationOnboarding({
    env,
    db: placement.database,
    archive: env.ARCHIVE,
    sessionNamespace: env.SESSION,
    connectorNamespace: env.CONNECTOR,
    organisationNamespace: env.ORGANISATION,
    organisationId: organisationId.value,
    now,
  });
  if (!reconciled.ok) {
    return controlError(reconciled.error.code, 404);
  }
  const after = await readOnboardingRow(
    placement.database,
    organisationId.value,
  );
  if (
    after === null ||
    typeof after.configurationVersion !== "number" ||
    typeof after.projectionRevision !== "number"
  ) {
    throw new Error("operator reconciliation result state is invalid");
  }
  const responseBody = {
    kind: "success",
    receipt: {
      receipt_id: mutationIdentity.receiptId,
      organisation_id: organisationId.value,
    },
    summary: reconciled.value,
  };
  const session = placement.database.withSession("first-primary");
  await session.batch([
    prepareControlMutationReceipt(session, {
      scope,
      boundary,
      identity: mutationIdentity,
      responseStatus: 200,
      responseBody,
    }),
    prepareOnboardingAuditEvent(session, mutationIdentity, {
      organisationId: organisationId.value,
      environment: before.environment,
      actorUserId: role.userId,
      operation: "onboarding.reconcile",
      targetKind: "organisation",
      targetId: organisationId.value,
      oldLifecycle: before.lifecycle,
      newLifecycle: before.lifecycle,
      configurationVersion: after.configurationVersion,
      projectionRevision: after.projectionRevision,
      reasonCode: "support_admin_requested",
    }),
  ]);
  return controlJson(responseBody);
}

async function handleOperatorAction(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authenticated = await authenticateControlMutation(request, env);
  if (!authenticated.ok) {
    return authenticated.response;
  }
  const supportRole = await resolveControlSupportRole({
    db: env.DB,
    userId: authenticated.value.session.userId,
  });
  if (supportRole?.kind !== "support_admin") {
    return controlError("support_admin_role_required", 403);
  }
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) {
    return controlError("organisation_not_found", 404);
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const placement = execution.value;
  const body = await readJsonRecord(request);
  const action = body.ok ? parseOperatorOnboardingAction(body.value) : null;
  if (!body.ok || action === null) {
    return controlError("operator_action_invalid", 422);
  }
  const boundary = await parseMutationBoundary(
    request,
    body.value,
    "configuration_versioned",
  );
  if (boundary instanceof Response) return boundary;
  const identity = await resolveMutationUser(env, supportRole.userId);
  if (identity instanceof Response) return identity;
  const scope: ControlMutationReceiptScope = {
    userId: supportRole.userId,
    organisationScope: organisationId.value,
    route: `/v1/control/operator/organisations/${organisationId.value}/actions`,
    operation: operatorActionOperation(action),
  };
  const replayed = await replayControlMutation({
    db: placement.database,
    scope,
    boundary,
    replay: (receipt) =>
      controlJson(
        {
          kind: "success",
          action: action.kind,
          receipt: receipt.responseBody,
        },
        receipt.responseStatus,
      ),
  });
  if (replayed !== null) return replayed;
  const now = Date.now();
  const mutation = {
    boundary,
    scope,
    identity: await controlMutationIdentity(request, identity, now),
  };
  switch (action.kind) {
    case "invalidate_attempt":
      return executeOperatorAttemptInvalidation({
        env,
        execution: placement,
        action,
        userId: supportRole.userId,
        mutation,
        now,
      });
    case "disable_account":
      return executeOperatorAccountDisable({
        env,
        execution: placement,
        action,
        userId: supportRole.userId,
        mutation,
        now,
      });
    case "resume_activation":
      return executeOperatorActivationResume({
        env,
        execution: placement,
        action,
        mutation,
        now,
      });
    case "archive_ownerless_legacy_organisation":
      return executeOperatorLegacyOrganisationArchive({
        env,
        execution: placement,
        userId: supportRole.userId,
        mutation,
        now,
      });
    default:
      return assertNever(action);
  }
}

async function handleOperatorHarnessHistory(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeSupportAdmin(request, env, false);
  if (!authorized.ok) {
    return authorized.response;
  }
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) {
    return controlError("organisation_not_found", 404);
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const placement = execution.value;
  const inventory = await inspectOrganisationHarnessHistory({
    db: placement.database,
    directory: env.DB,
    sessionNamespace: env.SESSION,
    organisationId: organisationId.value,
    inspectedAt: Date.now(),
  });
  if (!inventory.ok) {
    return controlError(
      inventory.error.code,
      inventory.error.code === "organisation_harness_history_registry_changed"
        ? 409
        : 503,
    );
  }
  return controlJson({ kind: "success", inventory: inventory.value });
}

async function handleOperatorHarnessErasure(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeSupportAdmin(request, env, false);
  if (!authorized.ok) {
    return authorized.response;
  }
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) {
    return controlError("organisation_not_found", 404);
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const placement = execution.value;
  const receipts = await readOrganisationHarnessErasureReceipts(
    placement.database,
    organisationId.value,
    Date.now(),
  );
  if (!receipts.ok) {
    return controlError(receipts.error.code, 500);
  }
  return controlJson({ kind: "success", receipts: receipts.value });
}

async function executeOperatorAttemptInvalidation(input: {
  readonly env: Env;
  readonly execution: OrganisationExecutionScope;
  readonly action: Variant<OperatorOnboardingAction, "invalidate_attempt">;
  readonly userId: ActiveControlSession["userId"];
  readonly mutation: Parameters<typeof cancelProviderAttempt>[0]["mutation"];
  readonly now: number;
}): Promise<Response> {
  const cancelled = await cancelProviderAttempt({
    db: input.execution.database,
    organisationId: input.execution.organisationId,
    attemptId: input.action.attemptId,
    actorUserId: input.userId,
    reasonCode: "support_admin_invalidated",
    mutation: input.mutation,
    now: input.now,
  });
  return cancelled.ok
    ? controlJson({
        kind: "success",
        action: input.action.kind,
        attempt: providerAttemptWire(cancelled.value.attempt),
        receipt: {
          receipt_id: cancelled.value.receiptId,
          organisation_id: input.execution.organisationId,
        },
      })
    : controlError(
        cancelled.error.code,
        cancelled.error.code === "provider_attempt_not_found" ? 404 : 409,
      );
}

async function executeOperatorAccountDisable(input: {
  readonly env: Env;
  readonly execution: OrganisationExecutionScope;
  readonly action: Variant<OperatorOnboardingAction, "disable_account">;
  readonly userId: ActiveControlSession["userId"];
  readonly mutation: Parameters<
    typeof disableIntegrationAccount
  >[0]["mutation"];
  readonly now: number;
}): Promise<Response> {
  const disabled = await disableIntegrationAccount({
    db: input.execution.database,
    organisationId: input.execution.organisationId,
    integrationAccountId: input.action.integrationAccountId,
    replacementIntegrationAccountId:
      input.action.replacementIntegrationAccountId,
    disabledByUserId: input.userId,
    reasonCode: "support_admin_disabled",
    mutation: input.mutation,
    now: input.now,
  });
  if (!disabled.ok) {
    return controlError(
      disabled.error.code,
      disabled.error.code === "integration_account_not_found" ? 404 : 409,
    );
  }
  return controlJson({
    kind: "success",
    action: input.action.kind,
    account: disabled.value.account,
    receipt: {
      receipt_id: disabled.value.receiptId,
      organisation_id: input.execution.organisationId,
    },
  });
}

async function executeOperatorActivationResume(input: {
  readonly env: Env;
  readonly execution: OrganisationExecutionScope;
  readonly action: Variant<OperatorOnboardingAction, "resume_activation">;
  readonly mutation: ActivationMutation;
  readonly now: number;
}): Promise<Response> {
  if (
    (await runtimeAdmissionStatus(
      input.env,
      input.execution.organisationId,
      input.now,
    )) === "unavailable"
  ) {
    return controlError("runtime_admission_unavailable", 503);
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    placement: input.execution.placement,
    env: input.env,
    organisationId: input.execution.organisationId,
    now: input.now,
  });
  const activated = await organisation.activateOnboarding({
    organisationId: input.execution.organisationId,
    readinessVersion: input.action.readinessVersion,
    readinessHash: input.action.readinessHash,
    mutation: input.mutation,
    now: input.now,
  });
  if (!activated.ok) {
    return "supportReference" in activated.error
      ? controlJson(
          {
            kind: activated.error.retryable
              ? "retryable_failure"
              : "terminal_failure",
            action: input.action.kind,
            reason_code: activated.error.code,
            correlation_id: activated.error.correlationId,
            support_reference: activated.error.supportReference,
          },
          activated.error.retryable ? 503 : 422,
        )
      : controlError(
          activated.error.code,
          activationErrorStatus(activated.error.code),
        );
  }
  return controlJson({
    kind: "success",
    action: input.action.kind,
    receipt: {
      receipt_id: input.mutation.identity.receiptId,
      organisation_id: input.execution.organisationId,
      activation_receipt_id: activated.value.activationReceiptId,
      first_task: activated.value.firstTask,
    },
  });
}

async function executeOperatorLegacyOrganisationArchive(input: {
  readonly env: Env;
  readonly execution: OrganisationExecutionScope;
  readonly userId: ActiveControlSession["userId"];
  readonly mutation: Parameters<typeof archiveOrganisation>[0]["mutation"];
  readonly now: number;
}): Promise<Response> {
  const archived = await archiveOrganisation({
    identityDatabase: input.env.DB,
    execution: input.execution,
    actorUserId: input.userId,
    mutation: input.mutation,
    authority: {
      kind: "support_admin",
      subjectHash: input.mutation.identity.portalSubjectHash,
      reasonCode: "legacy_cutover",
    },
    reasonCode: "legacy_cutover",
    now: input.now,
  });
  if (archived.ok) {
    await holdOrganisationPolicyDistribution({
      kv: input.env.POLICY_KV,
      organisationId: input.execution.organisationId,
    });
  }
  return archived.ok
    ? controlJson({
        kind: "success",
        action: "archive_ownerless_legacy_organisation",
        receipt: {
          receipt_id: archived.value.receiptId,
          organisation_id: archived.value.organisationId,
          archived_at: archived.value.archivedAt,
          purge_after: archived.value.purgeAfter,
        },
      })
    : controlError(
        archived.error.code,
        archived.error.code === "organisation_not_found" ? 404 : 409,
      );
}

function parseOperatorOnboardingAction(
  body: JsonRecord,
): OperatorOnboardingAction | null {
  switch (body.kind) {
    case "invalidate_attempt": {
      if (typeof body.attemptId !== "string") {
        return null;
      }
      const attemptId = parseProviderConnectionAttemptId(body.attemptId);
      return attemptId.ok
        ? { kind: "invalidate_attempt", attemptId: attemptId.value }
        : null;
    }
    case "disable_account": {
      if (typeof body.integrationAccountId !== "string") {
        return null;
      }
      const integrationAccountId = parseIntegrationAccountId(
        body.integrationAccountId,
      );
      const replacement =
        body.replacementIntegrationAccountId === null ||
        body.replacementIntegrationAccountId === undefined
          ? { ok: true as const, value: null }
          : typeof body.replacementIntegrationAccountId === "string"
            ? parseIntegrationAccountId(body.replacementIntegrationAccountId)
            : { ok: false as const };
      return integrationAccountId.ok && replacement.ok
        ? {
            kind: "disable_account",
            integrationAccountId: integrationAccountId.value,
            replacementIntegrationAccountId: replacement.value,
          }
        : null;
    }
    case "resume_activation":
      return isPositiveInteger(body.readinessVersion) &&
        typeof body.readinessHash === "string" &&
        body.readinessHash.length > 0
        ? {
            kind: "resume_activation",
            readinessVersion: body.readinessVersion,
            readinessHash: body.readinessHash,
          }
        : null;
    case "archive_ownerless_legacy_organisation":
      return { kind: "archive_ownerless_legacy_organisation" };
    default:
      return null;
  }
}

function operatorActionOperation(action: OperatorOnboardingAction): string {
  switch (action.kind) {
    case "invalidate_attempt":
      return "provider.attempt.invalidate";
    case "disable_account":
      return "provider.account.disable";
    case "resume_activation":
      return "organisation.activation.resume";
    case "archive_ownerless_legacy_organisation":
      return "organisation.archive.legacy_cutover";
    default:
      return assertNever(action);
  }
}

function parseOperatorOnboardingLookup(
  search: URLSearchParams,
): OperatorOnboardingLookup | null {
  const candidates: readonly {
    readonly parameter: string;
    readonly kind: OperatorOnboardingLookup["kind"];
  }[] = [
    { parameter: "supportReference", kind: "support_reference" },
    { parameter: "organisationId", kind: "organisation_id" },
    { parameter: "providerAccount", kind: "provider_account" },
    { parameter: "correlationId", kind: "correlation_id" },
  ];
  let selected: OperatorOnboardingLookup | null = null;
  for (const candidate of candidates) {
    const value = search.get(candidate.parameter);
    if (value === null) {
      continue;
    }
    const normalized = value.trim();
    if (
      selected !== null ||
      normalized.length === 0 ||
      normalized.length > 256
    ) {
      return null;
    }
    selected = { kind: candidate.kind, value: normalized };
  }
  return selected;
}

async function authorizeSupportAdmin(
  request: Request,
  env: Env,
  mutation: boolean,
): Promise<
  | {
      readonly ok: true;
      readonly userId: ActiveControlSession["userId"];
    }
  | { readonly ok: false; readonly response: Response }
> {
  const authenticated = mutation
    ? await authenticateControlMutation(request, env)
    : await authenticateControlRead(request, env);
  if (!authenticated.ok) return authenticated;

  const role = await resolveControlSupportRole({
    db: env.DB,
    userId: authenticated.value.session.userId,
  });
  return role?.kind === "support_admin"
    ? { ok: true, userId: role.userId }
    : { ok: false, response: controlError("support_admin_role_required", 403) };
}

function vaultRootRotationErrorResponse(
  error: VaultRootRotationError,
): Response {
  switch (error.code) {
    case "rotation_unknown":
      return controlError("vault_root_rotation_not_found", 404);
    case "rotation_id_invalid":
    case "rotation_batch_limit_invalid":
      return controlError(error.code, 422);
    case "rotation_active_exists":
    case "rotation_state_conflict":
    case "rotation_source_matches_target":
    case "rotation_source_root_unavailable":
      return controlError(error.code, 409);
    case "rotation_keyring_invalid":
      return controlError(error.code, 503);
    case "rotation_persistence_failed":
    case "rotation_persisted_state_invalid":
      return controlError(error.code, 500);
    default:
      return assertNever(error);
  }
}
