import { OrganisationExecutionScope } from "../../../organisation-execution-scope";
import type { Env } from "../../../env";
import { parseGmailAuthorizationProduct } from "../../../mail/gmail-authorization";
import { hashPortalSubject } from "../../../data/control-mutation";
import {
  integrationAccountAllowsCredentialMutation,
  providerConnectionAllowsCredentialMutation,
  resolveIntegrationAccount,
  resolveProviderConnection,
} from "../../../data/integration-account";
import {
  recordProviderStartFailure,
} from "../../../organisation/contract/provider-support-references";
import {
  cancelProviderAttempt,
  expireProviderAttemptIfDue,
  providerAttemptWire,
  readProviderAttempt,
} from "../../../data/provider-attempt";
import {
  parseProviderConnectionAttemptId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../../ids";
import {
  beginProviderOAuth,
  providerAuthorizationUrlForMutation,
} from "../../../provider-lifecycle/authorization";
import type { OnboardingProvider } from "../../../integrations/contract/provider-lifecycle";
import type { ProviderStartContext } from "../../../integrations/contract/provider-adapter";
import {
  type AdmittedMutation,
  admitUserMutation,
  controlMutationIdentity,
  resolveMutationUser,
} from "../../admission/control-mutation";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../../http";
import { isRecord } from "@purin-labs/std";
import { readOnboardingRow } from "../../../data/organisation-onboarding-row";
import { account } from "../integrations";
import { providerContextForExistingAccount } from "../../../provider-lifecycle/existing-account-context";
import { authorizeAccountRequest } from "./account-request";

export async function handleExistingAccountProviderStart(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
  purpose: "reconnect" | "rotate",
): Promise<Response> {
  const target = await authorizeAccountRequest(
    request,
    env,
    organisationIdRaw,
    integrationAccountIdRaw,
    "POST",
    "admin",
  );
  if (target instanceof Response) return target;
  const { authorized, integrationAccountId } = target;
  const now = Date.now();
  const account = await resolveIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId,
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
  return startProviderAttempt({
    request,
    env,
    authorized,
    body: body.value,
    context,
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId}/${purpose}`,
    operation: `provider.account.${purpose}`,
    existingIntegrationAccountId: integrationAccountId,
    purpose,
    provider: account.value.provider,
    now,
  });
}

/**
 * Starts one provider authorization attempt, or answers the replay of an
 * earlier start with a fresh authorization URL.
 */
async function startProviderAttempt(input: {
  readonly request: Request;
  readonly env: Env;
  readonly authorized: AuthorizedOrganisationRequest;
  readonly body: JsonRecord;
  readonly context: ProviderStartContext;
  readonly route: string;
  readonly operation: string;
  readonly existingIntegrationAccountId: IntegrationAccountId | null;
  readonly purpose: "connect" | "reconnect" | "rotate";
  readonly provider: string;
  readonly now: number;
}): Promise<Response> {
  const { request, env, authorized, context, now } = input;
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: input.body,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: input.route,
    operation: input.operation,
    replay: (receipt, mutation) =>
      providerStartReplayResponse({ env, context, mutation, receipt }),
  });
  if (admitted instanceof Response) return admitted;
  const started = await beginProviderOAuth({
    env,
    session: authorized.authenticated.session,
    organisationId: authorized.organisationId,
    context,
    existingIntegrationAccountId: input.existingIntegrationAccountId,
    purpose: input.purpose,
    returnPath:
      typeof input.body.returnPath === "string"
        ? input.body.returnPath
        : `/portal/${authorized.organisationId}`,
    mutation: {
      boundary: admitted.boundary,
      scope: admitted.scope,
      identity: await controlMutationIdentity(request, admitted.user, now),
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
          provider: input.provider,
          userId: admitted.user.userId,
          route: admitted.scope.route,
          now,
        })
      : controlError(
          started.error.code,
          providerErrorStatus(started.error.code),
        );
}

async function providerStartConfigurationFailure(input: {
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
  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("provider_context_invalid", 400);
  }
  const context = providerStartContext(provider, body.value);
  if (context === null) {
    return controlError("provider_context_invalid", 400);
  }
  return startProviderAttempt({
    request,
    env,
    authorized,
    body: body.value,
    context,
    route: `/v1/control/organisations/${authorized.organisationId}/providers/${provider}/start`,
    operation: "provider.attempt.start",
    existingIntegrationAccountId: null,
    purpose: "connect",
    provider,
    now,
  });
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
  const identity = await resolveMutationUser(
    env,
    authorized.authenticated.session.userId,
  );
  if (identity instanceof Response) return identity;
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
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/provider-attempts/${attemptId.value}/cancel`,
    operation: "provider.attempt.cancel",
    replay: async (receipt) => {
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
          receipt: receipt.responseBody,
        },
        receipt.responseStatus,
      );
    },
  });
  if (admitted instanceof Response) return admitted;
  const now = Date.now();
  const cancelled = await cancelProviderAttempt({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    attemptId: attemptId.value,
    actorUserId: admitted.user.userId,
    reasonCode: "authorization_cancelled",
    mutation: {
      boundary: admitted.boundary,
      scope: admitted.scope,
      identity: await controlMutationIdentity(request, admitted.user, now),
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

function providerStartContext(
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

async function providerStartReplayResponse(input: {
  readonly env: Env;
  readonly context: ProviderStartContext;
  readonly mutation: AdmittedMutation<"configuration_versioned">;
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
    mutation: input.mutation,
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
