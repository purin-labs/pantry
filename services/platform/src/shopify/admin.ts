import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  readIntegrationAccountIdField,
  readStringField,
  readOrganisationIdField,
  type FieldError,
} from "../boundary";
import {
  compileAndStoreCueSnapshot,
  writeTierOneShopifySubscription,
} from "../cues/engine";
import {
  requireConnectionCredentialAuthority,
  resolveActiveProviderAccountContext,
  upsertProviderWebhook,
} from "@purin-labs/connections/data/integration-account";
import type { Env } from "@purin-labs/kernel/env";
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
} from "@purin-labs/kernel/ids";
import {
  traceLog,
  traceWarn,
} from "@purin-labs/kernel/observability";
import { registerShopifyWebhooks } from "./connector/webhook-registration";
import type {
  ShopifyWebhookRegistration,
  ShopifyWebhookRegistrationError,
} from "./connector";
import { resolveShopifyWriteCredential } from "./action-execution";
import {
  acquireShopifyAdminAccess,
  isShopifyAdminDomain,
  isShopifyClientId,
  isShopifyClientSecret,
  type ShopifyAuthError,
} from "./auth";
import {
  triggerShopifyDevelopmentOrder,
  type ShopifyDevelopmentOrderTriggerError,
} from "./acceptance";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseVaultHandle,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/index";
import { assertNever } from "@purin-labs/std";
import { createActiveAdminIntegration } from "../integrations/contract/admin-integration";
import {
  fieldErrorResponse,
  isAuthorizedOrganisationAdminRequest,
  jsonBodyErrorResponse,
  parsePublicServiceUrl,
  readCueChannelRequest,
} from "../gateway/request-helpers";

export async function handleConfigureShopifyCredential(
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
  const shopDomain = readStringField(body.value, "shopDomain");
  const clientId = readStringField(body.value, "clientId");
  const clientSecret = readStringField(body.value, "clientSecret");

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

  if (!shopDomain.ok || !isShopifyAdminDomain(shopDomain.value)) {
    return errorResponse(
      "invalid_field",
      "Shopify shopDomain is invalid.",
      422,
    );
  }

  if (!clientId.ok || !isShopifyClientId(clientId.value)) {
    return errorResponse("invalid_field", "Shopify clientId is invalid.", 422);
  }

  if (!clientSecret.ok || !isShopifyClientSecret(clientSecret.value)) {
    return errorResponse(
      "invalid_field",
      "Shopify clientSecret is invalid.",
      422,
    );
  }

  const access = await acquireShopifyAdminAccess({
    shopDomain: shopDomain.value,
    credentials: { clientId: clientId.value, clientSecret: clientSecret.value },
    fetcher: runtimeFetch,
    now: Date.now(),
  });

  if (!access.ok) {
    return shopifyAuthErrorResponse(access.error);
  }

  const handle = parseVaultHandle(
    `vault:shopify:admin:${shopDomain.value.replaceAll(".", "-")}`,
  );

  if (!handle.ok) {
    return errorResponse(
      "invalid_vault_handle",
      "Shopify Vault handle is invalid.",
      500,
    );
  }

  const now = Date.now();
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: organisationId.value,
    handle: handle.value,
    secret: {
      kind: "oauth_client_credentials",
      clientId: clientId.value,
      clientSecret: clientSecret.value,
    },
    now,
  });

  if (!stored.ok) {
    return errorResponse(
      stored.error.code,
      "Shopify credential was not stored.",
      500,
    );
  }

  const connected = await createActiveAdminIntegration({
    scope,
    now,
    seed: {
      provider: "shopify",
      authMode: "api_key",
      authority: { kind: "connection_credential", credentialRef: handle.value },
      grantedScopes: access.value.scopes,
      providerAccountId: shopDomain.value,
      accountKind: "store",
      displayName: shopDomain.value,
      capabilities: [
        "orders.read",
        "inventory.read",
        "inventory.propose",
        "fulfillment.propose",
      ],
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

  traceLog("shopify.credential_configured", {
    requestId: newRequestId(),
    organisation_id: organisationId.value,
    shop_domain: shopDomain.value,
    vault_handle: handle.value,
  });
  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    integrationAccountId: connected.account.integrationAccountId,
    credential: {
      provider: "shopify",
      shopDomain: shopDomain.value,
      scopes: access.value.scopes,
      tokenExpiresAt: access.value.expiresAt,
    },
  });
}

export async function handleConfigureShopifyConnector(
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

  const integrationAccountId = readIntegrationAccountIdField(body.value);
  if (!integrationAccountId.ok) {
    return fieldErrorResponse(integrationAccountId.error);
  }

  const provisioning = parseShopifyWebhookProvisioning(body.value);
  if (!provisioning.ok) {
    return fieldErrorResponse(provisioning.error);
  }

  const publicOrigin = parsePublicServiceUrl(env.PANTRY_PUBLIC_ORIGIN);

  if (publicOrigin === null) {
    return errorResponse(
      "public_origin_invalid",
      "Public Worker origin is invalid.",
      500,
    );
  }

  const credential = await resolveShopifyWriteCredential({
    env,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    fetcher: runtimeFetch,
    now: Date.now(),
  });

  if (!credential.ok) {
    return errorResponse(
      credential.error.code,
      "Shopify credential is unavailable.",
      503,
    );
  }

  const accountContext = await resolveActiveProviderAccountContext({
    db: scope.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
  });

  if (!accountContext.ok) {
    return errorResponse(
      accountContext.error.code,
      "Shopify account is unavailable.",
      409,
    );
  }

  if (accountContext.value.account.provider !== "shopify") {
    return errorResponse(
      "shopify_integration_account_invalid",
      "Shopify account is invalid.",
      422,
    );
  }

  const providerSigningSecret = env.SHOPIFY_CLIENT_SECRET;
  if (
    providerSigningSecret === undefined ||
    !isShopifyClientSecret(providerSigningSecret)
  ) {
    return errorResponse(
      "provider_configuration_missing",
      "Shopify webhook signing configuration is unavailable.",
      503,
    );
  }

  const endpointUrl = `${publicOrigin}/hook/shopify/${encodeURIComponent(organisationId.value)}`;
  const handle = parseVaultHandle(
    `vault:shopify:webhook:${organisationId.value.toLowerCase().replaceAll("_", "-")}`,
  );

  if (!handle.ok) {
    return errorResponse(
      "invalid_vault_handle",
      "Shopify webhook handle is invalid.",
      500,
    );
  }

  const registration = await provisionShopifyWebhooks({
    provisioning: provisioning.value,
    shopDomain: credential.value.shopDomain,
    accessToken: credential.value.accessToken,
    providerSigningSecret,
    fetcher: runtimeFetch,
    endpointUrl,
  });

  if (!registration.ok) {
    return registration.response;
  }

  const now = Date.now();
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId: organisationId.value,
    handle: handle.value,
    secret: {
      kind: "header",
      header: "x-shopify-hmac-sha256",
      value: registration.signingSecret,
    },
    now,
  });

  if (!stored.ok) {
    return errorResponse(
      stored.error.code,
      "Shopify webhook secret was not stored.",
      500,
    );
  }

  await upsertProviderWebhook({
    db: scope.database,
    organisationId: organisationId.value,
    integrationAccountId: accountContext.value.account.integrationAccountId,
    provider: "shopify",
    environment: accountContext.value.account.environment,
    providerNativeId: credential.value.shopDomain,
    eventType: "commerce_events",
    signingSecretRef: handle.value,
    credentialGeneration: requireConnectionCredentialAuthority(
      accountContext.value.connection,
    ).credentialGeneration,
    lifecycle: { kind: "live", lastVerifiedAt: now },
    now,
  });

  traceShopifyConnectorConfigured({
    organisationId: organisationId.value,
    shopDomain: credential.value.shopDomain,
    endpointUrl,
    registration: registration.registration,
  });
  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    integrationAccountId: accountContext.value.account.integrationAccountId,
    provider: "shopify",
    shopDomain: credential.value.shopDomain,
    endpointUrl,
    webhookStatus: "live",
    subscriptions: registration.registration,
  });
}

type ShopifyWebhookProvisioning =
  { kind: "provider_api" } | { kind: "merchant_admin"; signingSecret: string };

type ShopifyWebhookProvisioningResult =
  | {
      kind: "provider_api";
      registration: ShopifyWebhookRegistration;
      signingSecret: string;
    }
  | {
      kind: "merchant_admin";
      registration: {
        kind: "merchant_admin";
        topics: readonly [
          "ORDERS_CREATE",
          "INVENTORY_LEVELS_UPDATE",
          "PRODUCTS_CREATE",
          "PRODUCTS_UPDATE",
        ];
      };
      signingSecret: string;
    };

function parseShopifyWebhookProvisioning(
  body: JsonObject,
): Result<ShopifyWebhookProvisioning, FieldError> {
  const mode = readStringField(body, "provisioningMode");

  if (!mode.ok) {
    return mode;
  }

  switch (mode.value) {
    case "provider_api":
      return { ok: true, value: { kind: "provider_api" } };
    case "merchant_admin": {
      const signingSecret = readStringField(body, "webhookSigningSecret");

      if (!signingSecret.ok) {
        return signingSecret;
      }
      if (signingSecret.value.length < 16 || /\s/u.test(signingSecret.value)) {
        return {
          ok: false,
          error: { code: "invalid_field", field: "webhookSigningSecret" },
        };
      }

      return {
        ok: true,
        value: { kind: "merchant_admin", signingSecret: signingSecret.value },
      };
    }
    default:
      return {
        ok: false,
        error: { code: "invalid_field", field: "provisioningMode" },
      };
  }
}

async function provisionShopifyWebhooks(input: {
  provisioning: ShopifyWebhookProvisioning;
  shopDomain: string;
  accessToken: string;
  providerSigningSecret: string;
  endpointUrl: string;
  fetcher: typeof fetch;
}): Promise<
  | {
      ok: true;
      registration: ShopifyWebhookProvisioningResult["registration"];
      signingSecret: string;
    }
  | { ok: false; response: Response }
> {
  switch (input.provisioning.kind) {
    case "merchant_admin":
      return {
        ok: true,
        registration: {
          kind: "merchant_admin",
          topics: [
            "ORDERS_CREATE",
            "INVENTORY_LEVELS_UPDATE",
            "PRODUCTS_CREATE",
            "PRODUCTS_UPDATE",
          ],
        },
        signingSecret: input.provisioning.signingSecret,
      };
    case "provider_api": {
      const registration = await registerShopifyWebhooks({
        shopDomain: input.shopDomain,
        accessToken: input.accessToken,
        endpointUrl: input.endpointUrl,
        fetcher: input.fetcher,
      });

      if (!registration.ok) {
        traceWarn("shopify.connector_registration_failed", {
          requestId: newRequestId(),
          shop_domain: input.shopDomain,
          operation: registration.error.operation,
          code: registration.error.code,
        });
        return {
          ok: false,
          response: shopifyRegistrationErrorResponse(registration.error),
        };
      }

      return {
        ok: true,
        registration: registration.value,
        signingSecret: input.providerSigningSecret,
      };
    }
    default:
      return assertNever(input.provisioning);
  }
}

function traceShopifyConnectorConfigured(input: {
  organisationId: string;
  shopDomain: string;
  endpointUrl: string;
  registration: ShopifyWebhookProvisioningResult["registration"];
}): void {
  traceLog("shopify.connector_configured", {
    requestId: newRequestId(),
    organisation_id: input.organisationId,
    shop_domain: input.shopDomain,
    endpoint_url: input.endpointUrl,
    provisioning_kind: input.registration.kind,
  });
}

export async function handleConfigureShopifyCues(
  request: Request,
  env: Env,
): Promise<Response> {
  const cueRequest = await readCueChannelRequest(request, env);
  if (!cueRequest.ok) return cueRequest.error;
  const { scope, organisationId, workspaceId, channelId, threadKey } =
    cueRequest.value;

  await writeTierOneShopifySubscription({
    db: scope.database,
    organisationId,
    subscriptionId: "shopify-order-created-main",
    workspaceId,
    channelId,
    threadKey,
    eventType: "orders/create",
    template:
      "A Shopify order was created. Review fulfillment and customer risk before proposing the next action.",
    delivery: { kind: "immediate" },
    debounceMs: 0,
    maxPerHour: 20,
  });
  await writeTierOneShopifySubscription({
    db: scope.database,
    organisationId,
    subscriptionId: "shopify-inventory-level-updated-main",
    workspaceId,
    channelId,
    threadKey,
    eventType: "inventory_levels/update",
    template:
      "Shopify inventory changed. Review the affected item and location for stock risk.",
    delivery: { kind: "digest", windowMs: 60 * 60 * 1000 },
    debounceMs: 0,
    maxPerHour: 20,
  });
  const snapshot = await compileAndStoreCueSnapshot({
    db: scope.database,
    kv: env.POLICY_KV,
    organisationId,
    now: Date.now(),
  });

  return jsonResponse({
    ok: true,
    organisationId,
    subscriptionIds: [
      "shopify-order-created-main",
      "shopify-inventory-level-updated-main",
    ],
    snapshotVersion: snapshot.version,
  });
}

export async function handleTriggerShopifyTestOrder(
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

  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  const integrationAccountId = readIntegrationAccountIdField(body.value);
  if (!integrationAccountId.ok) {
    return fieldErrorResponse(integrationAccountId.error);
  }

  const credential = await resolveShopifyWriteCredential({
    env,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    fetcher: runtimeFetch,
    now: Date.now(),
  });

  if (!credential.ok) {
    return errorResponse(
      credential.error.code,
      "Shopify credential is unavailable.",
      503,
    );
  }

  const sourceIdentifier = `pantry-m8-${newRequestId()}`;
  const triggered = await triggerShopifyDevelopmentOrder({
    shopDomain: credential.value.shopDomain,
    accessToken: credential.value.accessToken,
    sourceIdentifier,
    fetcher: runtimeFetch,
  });

  if (!triggered.ok) {
    return shopifyDevelopmentOrderTriggerErrorResponse(triggered.error);
  }

  traceLog("shopify.test_order_submitted", {
    requestId: newRequestId(),
    organisation_id: organisationId.value,
    shop_domain: triggered.value.shopDomain,
    source_identifier: triggered.value.sourceIdentifier,
  });
  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    trigger: triggered.value,
  });
}

function shopifyAuthErrorResponse(error: ShopifyAuthError): Response {
  switch (error.code) {
    case "shopify_client_credential_invalid":
      return errorResponse(
        error.code,
        "Shopify client credentials are invalid.",
        422,
      );
    case "shopify_auth_transport_failed":
      return errorResponse(
        error.code,
        "Shopify authentication transport failed.",
        503,
      );
    case "shopify_auth_request_failed":
      return errorResponse(
        error.code,
        "Shopify rejected the client credentials.",
        403,
      );
    case "shopify_auth_response_invalid":
      return errorResponse(
        error.code,
        "Shopify authentication response was invalid.",
        502,
      );
    default:
      return assertNever(error);
  }
}

function shopifyRegistrationErrorResponse(
  error: ShopifyWebhookRegistrationError,
): Response {
  switch (error.code) {
    case "shopify_registration_failed":
      return errorResponse(
        error.code,
        "Shopify webhook registration failed.",
        error.status,
      );
    case "shopify_registration_transport_failed":
      return errorResponse(
        error.code,
        "Shopify webhook registration transport failed.",
        503,
      );
    case "shopify_registration_graphql_error":
    case "shopify_registration_rejected":
      return errorResponse(
        error.code,
        "Shopify rejected the webhook registration.",
        422,
      );
    case "shopify_registration_invalid":
      return errorResponse(
        error.code,
        "Shopify returned an invalid webhook response.",
        502,
      );
    default:
      return assertNever(error);
  }
}

function shopifyDevelopmentOrderTriggerErrorResponse(
  error: ShopifyDevelopmentOrderTriggerError,
): Response {
  switch (error.code) {
    case "shopify_acceptance_credential_invalid":
      return errorResponse(
        error.code,
        "Shopify acceptance credential is invalid.",
        503,
      );
    case "shopify_acceptance_store_not_development":
      return errorResponse(
        error.code,
        "Shopify acceptance requires a development store.",
        403,
      );
    case "shopify_acceptance_variant_not_found":
      return errorResponse(
        error.code,
        "The marked Shopify acceptance variant is unavailable.",
        409,
      );
    case "shopify_acceptance_order_rejected":
      return errorResponse(
        error.code,
        "Shopify rejected the acceptance order.",
        422,
      );
    case "shopify_acceptance_transport_failed":
      return errorResponse(
        error.code,
        "Shopify acceptance transport failed.",
        503,
      );
    case "shopify_acceptance_request_failed":
      return errorResponse(
        error.code,
        "Shopify acceptance request failed.",
        error.status,
      );
    case "shopify_acceptance_graphql_error":
      return errorResponse(
        error.code,
        "Shopify returned a GraphQL error.",
        422,
      );
    case "shopify_acceptance_response_invalid":
      return errorResponse(
        error.code,
        "Shopify returned an invalid acceptance response.",
        502,
      );
    default:
      return assertNever(error);
  }
}
