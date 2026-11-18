import { OrganisationExecutionScope } from "../../../organisation-execution-scope";
import type { Env } from "../../../env";
import { parseGmailAuthorizationProduct } from "../../../mail/gmail-authorization";
import {
  authorizeCloudflareAuthoritativeMutation,
  type CloudflareAuthoritativeMutationError,
} from "../../../data/authoritative-runtime-cutover";
import { resolveUser } from "../../../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  parseControlMutationBoundary,
  readControlMutationReplay,
  type ControlMutationBoundary,
  type ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import {
  integrationAccountAllowsCredentialMutation,
  providerConnectionAllowsCredentialMutation,
  resolveIntegrationAccount,
  resolveProviderConnection,
} from "../../../data/integration-account";
import { recordProviderStartFailure } from "../../../data/onboarding-support";
import {
  cancelProviderAttempt,
  expireProviderAttemptIfDue,
  providerAttemptWire,
  readProviderAttempt,
} from "../../../data/provider-attempt";
import {
  parseIntegrationAccountId,
  parseProviderConnectionAttemptId,
  type OrganisationId,
} from "../../../ids";
import {
  beginProviderOAuth,
  providerAuthorizationUrlForMutation,
} from "../../../provider-lifecycle/authorization";
import type { OnboardingProvider } from "../../../provider-lifecycle/domain";
import type { ProviderStartContext } from "../../../provider-adapters/domain";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../../http";
import { controlCausationId } from "../../mutation";
import type { Variant } from "@seams/type-utils";
import { assertNever, isRecord } from "@seams/std";
import { readOnboardingRow } from "../../../data/organisation-onboarding-row";
import { account } from "../integrations";
import { providerContextForExistingAccount } from "../../../provider-lifecycle/existing-account-context";

export async function handleExistingAccountProviderStart(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
  purpose: "reconnect" | "rotate",
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
  const now = Date.now();
  const authority = await authorizeCloudflareAuthoritativeMutation({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    occurredAt: now,
  });
  if (!authority.ok) {
    return providerStartAuthorityFailure(authority.error);
  }
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!integrationAccountId.ok) {
    return controlError("integration_account_not_found", 404);
  }
  const account = await resolveIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
  });
  if (!account.ok) {
    return controlError(account.error.code, 404);
  }
  if (
    !integrationAccountAllowsCredentialMutation(
      account.value.lifecycle,
      purpose,
    )
  ) {
    return controlError("provider_account_ineligible", 409);
  }
  const connection = await resolveProviderConnection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    providerConnectionId: account.value.providerConnectionId,
  });
  if (
    !connection.ok ||
    !providerConnectionAllowsCredentialMutation(
      connection.value.lifecycle,
      purpose,
    )
  ) {
    return controlError("provider_account_ineligible", 409);
  }
  const context = providerContextForExistingAccount(
    account.value.provider,
    account.value.providerAccountId,
    connection.ok &&
      account.value.provider === "gmail" &&
      connection.value.authorizationProduct.kind === "gmail"
      ? connection.value.authorizationProduct.product
      : null,
  );
  if (context === null) {
    return controlError("provider_context_invalid", 422);
  }
  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("provider_context_invalid", 422);
  }
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: true,
  });
  if (!boundary.ok || boundary.value.kind !== "configuration_versioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const route = `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId.value}/${purpose}`;
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route,
    operation: `provider.account.${purpose}`,
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "replay") {
    return providerStartReplayResponse({
      env,
      context,
      boundary: boundary.value,
      scope,
      receipt: replay.receipt,
    });
  }
  const started = await beginProviderOAuth({
    env,
    session: authorized.authenticated.session,
    organisationId: authorized.organisationId,
    context,
    existingIntegrationAccountId: integrationAccountId.value,
    purpose,
    returnPath:
      typeof body.value.returnPath === "string"
        ? body.value.returnPath
        : `/portal/${authorized.organisationId}`,
    mutation: {
      boundary: boundary.value,
      scope,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          identity.issuer,
          identity.subject,
        ),
        causationId: controlCausationId(request),
        now,
      }),
    },
    now,
  });
  return started.ok
    ? controlJson(
        {
          kind: "success",
          attempt: started.value.attempt,
          authorization_url: started.value.authorizationUrl,
          receipt: {
            receipt_id: started.value.receiptId,
            organisation_id: authorized.organisationId,
          },
        },
        201,
      )
    : started.error.code === "provider_configuration_missing"
      ? providerStartConfigurationFailure({
          scope: authorized.executionScope,
          organisationId: authorized.organisationId,
          provider: account.value.provider,
          userId: identity.userId,
          route: scope.route,
          now,
        })
      : controlError(
          started.error.code,
          providerErrorStatus(started.error.code),
        );
}

export async function providerStartConfigurationFailure(input: {
  readonly scope: OrganisationExecutionScope;
  readonly organisationId: OrganisationId;
  readonly provider: string;
  readonly userId: Parameters<
    typeof recordProviderStartFailure
  >[0]["actorUserId"];
  readonly route: string;
  readonly now: number;
}): Promise<Response> {
  const row = await readOnboardingRow(
    input.scope.database,
    input.organisationId,
  );
  if (row?.environment !== "development" && row?.environment !== "production") {
    return controlError("organisation_not_found", 404);
  }
  const support = await recordProviderStartFailure({
    db: input.scope.database,
    organisationId: input.organisationId,
    environment: row.environment,
    actorUserId: input.userId,
    provider: input.provider,
    route: input.route,
    reasonCode: "provider_distribution_disabled",
    retryable: true,
    now: input.now,
  });
  return controlJson(
    {
      kind: "retryable_failure",
      reason_code: "provider_configuration_missing",
      correlation_id: support.correlationId,
      support_reference: support.supportReference,
      message:
        "Provider configuration is unavailable. Retry after the provider is configured.",
    },
    503,
  );
}

export async function handleProviderStart(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  provider: OnboardingProvider,
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
  const now = Date.now();
  const authority = await authorizeCloudflareAuthoritativeMutation({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    occurredAt: now,
  });
  if (!authority.ok) {
    return providerStartAuthorityFailure(authority.error);
  }
  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("provider_context_invalid", 400);
  }
  const context = providerStartContext(provider, body.value);
  if (context === null) {
    return controlError("provider_context_invalid", 400);
  }
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: true,
  });
  if (!boundary.ok || boundary.value.kind !== "configuration_versioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/providers/${provider}/start`,
    operation: "provider.attempt.start",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "replay") {
    return providerStartReplayResponse({
      env,
      context,
      boundary: boundary.value,
      scope,
      receipt: replay.receipt,
    });
  }
  const started = await beginProviderOAuth({
    env,
    session: authorized.authenticated.session,
    organisationId: authorized.organisationId,
    context,
    existingIntegrationAccountId: null,
    purpose: "connect",
    returnPath:
      typeof body.value.returnPath === "string"
        ? body.value.returnPath
        : `/portal/${authorized.organisationId}`,
    mutation: {
      boundary: boundary.value,
      scope,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          identity.issuer,
          identity.subject,
        ),
        causationId: controlCausationId(request),
        now,
      }),
    },
    now,
  });
  return started.ok
    ? controlJson(
        {
          kind: "success",
          attempt: started.value.attempt,
          authorization_url: started.value.authorizationUrl,
          receipt: {
            receipt_id: started.value.receiptId,
            organisation_id: authorized.organisationId,
          },
        },
        201,
      )
    : started.error.code === "provider_configuration_missing"
      ? providerStartConfigurationFailure({
          scope: authorized.executionScope,
          organisationId: authorized.organisationId,
          provider,
          userId: identity.userId,
          route: scope.route,
          now,
        })
      : controlError(
          started.error.code,
          providerErrorStatus(started.error.code),
        );
}

export function providerStartAuthorityFailure(
  error: CloudflareAuthoritativeMutationError,
): Response {
  switch (error.code) {
    case "runtime_not_authoritative":
    case "mutation_precedes_activation":
      return controlError(error.code, 409);
    case "organisation_not_found":
      return controlError(error.code, 404);
    case "runtime_cutover_state_invalid":
    case "runtime_cutover_transition_invalid":
      return controlError(error.code, 503);
    default:
      return assertNever(error);
  }
}

export async function handleProviderAttempt(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  attemptIdRaw: string,
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
  const attemptId = parseProviderConnectionAttemptId(attemptIdRaw);
  if (!attemptId.ok) {
    return controlError("provider_attempt_not_found", 404);
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const attempt = await expireProviderAttemptIfDue({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    attemptId: attemptId.value,
    portalSubjectHash: await hashPortalSubject(
      identity.issuer,
      identity.subject,
    ),
    now: Date.now(),
  });
  return attempt.ok
    ? controlJson({
        kind: "success",
        attempt: providerAttemptWire(attempt.value),
      })
    : controlError(attempt.error.code, 404);
}

export async function handleCancelProviderAttempt(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  attemptIdRaw: string,
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
  const attemptId = parseProviderConnectionAttemptId(attemptIdRaw);
  if (!attemptId.ok) {
    return controlError("provider_attempt_not_found", 404);
  }
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("provider_attempt_cancel_request_invalid", 422);
  }
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: true,
  });
  if (!boundary.ok || boundary.value.kind !== "configuration_versioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/provider-attempts/${attemptId.value}/cancel`,
    operation: "provider.attempt.cancel",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "replay") {
    const current = await readProviderAttempt({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      attemptId: attemptId.value,
    });
    if (!current.ok) {
      return controlError(current.error.code, 404);
    }
    return controlJson(
      {
        kind: "success",
        attempt: providerAttemptWire(current.value),
        receipt: replay.receipt.responseBody,
      },
      replay.receipt.responseStatus,
    );
  }
  const now = Date.now();
  const cancelled = await cancelProviderAttempt({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    attemptId: attemptId.value,
    actorUserId: identity.userId,
    reasonCode: "authorization_cancelled",
    mutation: {
      boundary: boundary.value,
      scope,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          identity.issuer,
          identity.subject,
        ),
        causationId: controlCausationId(request),
        now,
      }),
    },
    now,
  });
  return cancelled.ok
    ? controlJson({
        kind: "success",
        attempt: providerAttemptWire(cancelled.value.attempt),
        receipt: {
          receipt_id: cancelled.value.receiptId,
          organisation_id: authorized.organisationId,
        },
      })
    : controlError(
        cancelled.error.code,
        cancelled.error.code === "provider_attempt_not_found" ? 404 : 409,
      );
}

export function providerStartContext(
  provider: OnboardingProvider,
  body: JsonRecord,
): ProviderStartContext | null {
  switch (provider) {
    case "airtable":
      return { provider: "airtable" };
    case "dropbox":
      return { provider: "dropbox" };
    case "notion":
      return { provider: "notion" };
    case "slack":
      return { provider: "slack" };
    case "square":
      return { provider: "square" };
    case "stripe":
      return { provider: "stripe" };
    case "gmail":
      if (body.authorizationProduct === undefined) {
        return {
          provider: "gmail",
          authorizationProduct: "full_mailbox_pilot",
        };
      }
      const authorizationProduct = parseGmailAuthorizationProduct(
        body.authorizationProduct,
      );
      return authorizationProduct === null
        ? null
        : { provider: "gmail", authorizationProduct };
    case "google_drive":
      return { provider: "google_drive" };
    case "whatsapp":
      return { provider: "whatsapp" };
    case "shopify":
      return typeof body.shopDomain === "string"
        ? {
            provider: "shopify",
            shopDomain: body.shopDomain.trim().toLowerCase(),
          }
        : null;
  }
}

export function providerErrorStatus(code: string): number {
  switch (code) {
    case "provider_oauth_denied":
    case "provider_state_invalid":
    case "provider_state_replayed":
    case "authorization_expired":
    case "provider_callback_signature_invalid":
    case "provider_account_ineligible":
    case "provider_asset_missing":
    case "provider_scope_missing":
    case "provider_environment_mismatch":
    case "provider_identity_unverified":
      return 400;
    case "provider_attempt_not_found":
      return 404;
    case "provider_attempt_open":
    case "provider_attempt_terminal":
    case "provider_attempt_state_conflict":
    case "configuration_version_conflict":
    case "provider_account_already_assigned":
    case "provider_mailbox_identity_claimed":
      return 409;
    case "provider_configuration_missing":
      return 503;
    default:
      return 502;
  }
}

export async function providerStartReplayResponse(input: {
  readonly env: Env;
  readonly context: ProviderStartContext;
  readonly boundary: Variant<
    ControlMutationBoundary,
    "configuration_versioned"
  >;
  readonly scope: ControlMutationReceiptScope;
  readonly receipt: {
    readonly responseStatus: number;
    readonly responseBody: unknown;
  };
}): Promise<Response> {
  if (
    !isRecord(input.receipt.responseBody) ||
    input.receipt.responseBody.kind !== "success" ||
    !isRecord(input.receipt.responseBody.attempt) ||
    !isRecord(input.receipt.responseBody.receipt)
  ) {
    throw new Error("provider start mutation receipt is invalid");
  }
  const authorizationUrl = await providerAuthorizationUrlForMutation({
    env: input.env,
    context: input.context,
    mutation: {
      boundary: input.boundary,
      scope: input.scope,
    },
  });
  return controlJson(
    {
      kind: "success",
      attempt: input.receipt.responseBody.attempt,
      authorization_url: authorizationUrl,
      receipt: input.receipt.responseBody.receipt,
    },
    input.receipt.responseStatus,
  );
}
