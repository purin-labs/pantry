import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  readIntegrationAccountIdField,
  readStringField,
  readOrganisationIdField,
} from "@purin-labs/contracts/boundary";
import type { Env } from "@purin-labs/kernel/env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from "@purin-labs/kernel/http";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";
import {
  triggerStripeFailedCharge,
  type StripeFailedChargeTriggerError,
} from "./acceptance";
import { resolveStripeWriteCredential } from "./action-execution";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseVaultHandle,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import {
  assertNever,
  isRecord,
} from "@purin-labs/std";
import { createActiveAdminIntegration } from "@purin-labs/area-integrations-contract/server/admin-integration";
import { fieldErrorResponse, isAuthorizedOrganisationAdminRequest, jsonBodyErrorResponse, readJsonFailure } from "@purin-labs/control/worker/gateway/request-helpers";

export async function handleConfigureStripeTestCredential(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const organisationId = readOrganisationIdField(body.value);
  const secret = readStringField(body.value, "secret");

  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const scope = execution.value;

  if (!secret.ok) {
    return fieldErrorResponse(secret.error);
  }

  if (!secret.value.startsWith("sk_test_") || secret.value.length < 24) {
    return errorResponse(
      "stripe_test_credential_invalid",
      "A Stripe test-mode secret key is required.",
      422,
    );
  }

  const stripeAccount = await discoverStripeAccount(secret.value, runtimeFetch);

  if (!stripeAccount.ok) {
    return errorResponse(
      stripeAccount.error.code,
      "Stripe account discovery failed.",
      403,
    );
  }

  const handle = parseVaultHandle(
    `vault:stripe:write:${organisationId.value.toLowerCase().replaceAll("_", "-")}`,
  );

  if (!handle.ok) {
    return errorResponse(
      "invalid_vault_handle",
      "Stripe Vault handle is invalid.",
      500,
    );
  }

  const now = Date.now();
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: organisationId.value,
    handle: handle.value,
    secret: { kind: "bearer", value: secret.value },
    now,
  });

  if (!stored.ok) {
    return errorResponse(
      stored.error.code,
      "Stripe credential was not stored.",
      500,
    );
  }

  const connected = await createActiveAdminIntegration({
    scope,
    now,
    seed: {
      provider: "stripe",
      authMode: "api_key",
      authority: { kind: "connection_credential", credentialRef: handle.value },
      grantedScopes: ["test_mode"],
      providerAccountId: stripeAccount.value.accountId,
      accountKind: "merchant_account",
      displayName: stripeAccount.value.displayName,
      capabilities: ["payments.read", "refunds.propose", "refunds.execute"],
      audiencePolicy: { kind: "operator" },
      retentionPolicy: { kind: "organisation_default" },
    },
  });

  if (connected === null) {
    return errorResponse(
      "organisation_owner_missing",
      "Organisation owner identity is unavailable.",
      409,
    );
  }
  traceLog("stripe.test_credential_configured", {
    requestId: newRequestId(),
    organisation_id: organisationId.value,
    vault_handle: handle.value,
  });
  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    integrationAccountId: connected.account.integrationAccountId,
    credential: { provider: "stripe", name: "write", mode: "test" },
  });
}

export async function discoverStripeAccount(
  secret: string,
  fetcher: typeof fetch,
): Promise<
  Result<
    { readonly accountId: string; readonly displayName: string },
    {
      readonly code: "stripe_account_discovery_failed";
    }
  >
> {
  let response: Response;

  try {
    response = await fetcher("https://api.stripe.com/v1/account", {
      headers: { authorization: `Bearer ${secret}` },
    });
  } catch {
    return { ok: false, error: { code: "stripe_account_discovery_failed" } };
  }

  const raw: unknown = await response.json().catch(readJsonFailure);

  if (!response.ok || !isRecord(raw) || typeof raw.id !== "string") {
    return { ok: false, error: { code: "stripe_account_discovery_failed" } };
  }

  const displayName =
    isRecord(raw.business_profile) &&
    typeof raw.business_profile.name === "string" &&
    raw.business_profile.name.length > 0
      ? raw.business_profile.name
      : raw.id;
  return { ok: true, value: { accountId: raw.id, displayName } };
}

export async function handleTriggerStripeTestFailure(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const organisationId = readOrganisationIdField(body.value);
  const integrationAccountId = readIntegrationAccountIdField(body.value);

  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  if (!integrationAccountId.ok) {
    return fieldErrorResponse(integrationAccountId.error);
  }

  const credential = await resolveStripeWriteCredential({
    env,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
  });

  if (!credential.ok) {
    return errorResponse(
      credential.error.code,
      "Stripe test credential is unavailable.",
      503,
    );
  }

  const triggered = await triggerStripeFailedCharge({
    credential: credential.value,
    fetcher: runtimeFetch,
  });

  if (!triggered.ok) {
    return stripeFailedChargeTriggerErrorResponse(triggered.error);
  }

  traceLog("stripe.test_charge_failed_triggered", {
    requestId: newRequestId(),
    organisation_id: organisationId.value,
    provider_request_id: triggered.value.requestId,
    charge_id: triggered.value.chargeId,
    decline_code: triggered.value.declineCode,
  });
  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    trigger: triggered.value,
  });
}

export function stripeFailedChargeTriggerErrorResponse(
  error: StripeFailedChargeTriggerError,
): Response {
  switch (error.code) {
    case "stripe_test_credential_invalid":
      return errorResponse(
        error.code,
        "A Stripe test-mode credential is required.",
        403,
      );
    case "stripe_test_failure_transport":
      return errorResponse(
        error.code,
        "Stripe test trigger transport failed.",
        503,
      );
    case "stripe_test_failure_response_invalid":
      return errorResponse(
        error.code,
        "Stripe did not return the expected decline.",
        502,
      );
    default:
      return assertNever(error);
  }
}
