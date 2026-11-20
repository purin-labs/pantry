import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { createCueQueueMessage } from "../cues/engine";
import type { Env } from "../env";
import type { JsonObject } from "../http";
import { revokeAccountRemovedAtProvider } from "../integrations/contract/provider-revocation";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
} from "../http";
import { createCommerceDeliveryQueueMessage } from "../commerce/contract/queue-messages";
import { createShopifyCommerceRefreshQueueMessage } from "./queue-messages";
import {
  newRequestId,
  parseOrganisationId,
  type IntegrationAccountId,
} from "../ids";
import {
  traceLog,
  traceWarn,
} from "../observability";
import {
  parseShopifyCommerceCatalogEnvelopeBody,
  parseShopifyCommerceInventoryLevelEnvelopeBody,
  parseShopifyCommerceProductDeletionBody,
  parseShopifyCommerceRefreshTarget,
  parseShopifyCueEventBody,
  parseShopifyWebhookBody,
  resolveShopifyWebhookSecret,
  verifyShopifyWebhookSignature,
} from "./connector/webhook-ingress";
import type { ShopifyWebhookError } from "./connector";
import {
  normalizeShopifyCommerceCatalogDelivery,
  normalizeShopifyCommerceInventoryDelivery,
} from "../commerce/commerce-wasm";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import { commerceObservationIdentity } from "../gateway/support";
import { decodePathSegmentValue } from "../gateway/request-helpers";

function isShopifyWebhookShopDomain(raw: string | null): raw is string {
  return raw !== null && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(raw);
}

export async function handleShopifyWebhook(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const organisationId = parseOrganisationId(
    decodePathSegmentValue(organisationIdRaw),
  );

  if (!organisationId.ok) {
    return notFound();
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  const scope = execution.value;

  const shopDomain = request.headers.get("x-shopify-shop-domain");

  if (!isShopifyWebhookShopDomain(shopDomain)) {
    return shopifyWebhookErrorResponse({ code: "shopify_event_invalid" });
  }

  const secret = await resolveShopifyWebhookSecret(env, scope, shopDomain);

  if (!secret.ok) {
    traceWarn("shopify.webhook_verification_unavailable", {
      requestId: newRequestId(),
      organisation_id: organisationId.value,
      shop_domain: shopDomain,
      reason_code: secret.error.code,
    });
    return shopifyWebhookErrorResponse(secret.error);
  }

  const rawBody = await request.text();
  const verified = await verifyShopifyWebhookSignature({
    rawBody,
    signatureHeader: request.headers.get("x-shopify-hmac-sha256"),
    signingSecret: secret.value.signingSecret,
  });

  if (!verified.ok) {
    return shopifyWebhookErrorResponse(verified.error);
  }

  const receivedAt = Date.now();
  const headers = {
    topic: request.headers.get("x-shopify-topic"),
    webhookId: request.headers.get("x-shopify-webhook-id"),
    shopDomain,
    triggeredAt: request.headers.get("x-shopify-triggered-at"),
  };
  const body = parseShopifyWebhookBody(rawBody);

  if (!body.ok) {
    return shopifyWebhookErrorResponse(body.error);
  }

  if (headers.topic === "app/uninstalled") {
    return revokeUninstalledShopifyAccount({
      env,
      scope,
      shopDomain,
      integrationAccountId: secret.value.integrationAccountId,
      body: body.value,
      receivedAt,
    });
  }

  const event = parseShopifyCueEventBody({
    body: body.value,
    headers,
    organisationId: organisationId.value,
    integrationAccountId: secret.value.integrationAccountId,
    receivedAt,
  });
  const commerceRefresh = parseShopifyCommerceRefreshTarget({
    body: body.value,
    headers,
  });
  const commerceCatalog = parseShopifyCommerceCatalogEnvelopeBody({
    body: body.value,
    headers,
    organisationId: organisationId.value,
    integrationAccountId: secret.value.integrationAccountId,
    receivedAt,
  });
  const inventoryEnvelope = parseShopifyCommerceInventoryLevelEnvelopeBody({
    body: body.value,
    headers,
    organisationId: organisationId.value,
    integrationAccountId: secret.value.integrationAccountId,
    receivedAt,
  });
  const commerceDeletion = parseShopifyCommerceProductDeletionBody({
    body: body.value,
    headers,
    organisationId: organisationId.value,
    integrationAccountId: secret.value.integrationAccountId,
    receivedAt,
  });

  const candidates = [
    event,
    commerceRefresh,
    commerceCatalog,
    inventoryEnvelope,
    commerceDeletion,
  ];
  const errors = candidates
    .filter(
      (candidate): candidate is VariantBy<typeof event, "ok", false> =>
        !candidate.ok,
    )
    .filter(
      (candidate) => candidate.error.code !== "shopify_event_unsupported",
    );

  const firstError = errors[0];
  if (
    !candidates.some((candidate) => candidate.ok) &&
    firstError !== undefined
  ) {
    return shopifyWebhookErrorResponse(firstError.error);
  }

  if (!candidates.some((candidate) => candidate.ok)) {
    return jsonResponse({ ok: true, ignored: true });
  }

  const requestId = newRequestId();

  if (commerceRefresh.ok && headers.webhookId !== null) {
    await env.EVENT_Q.send(
      createShopifyCommerceRefreshQueueMessage({
        requestId,
        receivedAt,
        organisationId: organisationId.value,
        integrationAccountId: secret.value.integrationAccountId,
        shopDomain,
        webhookId: headers.webhookId,
        target: commerceRefresh.value,
      }),
      { contentType: "json" },
    );
    traceLog("shopify.commerce_refresh_queued", {
      requestId,
      organisation_id: organisationId.value,
      integration_account_id: secret.value.integrationAccountId,
      webhook_id: headers.webhookId,
      target_kind: commerceRefresh.value.kind,
    });
  }

  if (commerceDeletion.ok) {
    await env.EVENT_Q.send(
      createCommerceDeliveryQueueMessage({
        requestId,
        receivedAt,
        organisationId: organisationId.value,
        integrationAccountId: secret.value.integrationAccountId,
        labRunId: null,
        canonicalDeliveryJson: JSON.stringify(commerceDeletion.value),
        canonicalCueFactsJson: "[]",
      }),
      { contentType: "json" },
    );
  }

  if (commerceCatalog.ok) {
    const canonical = normalizeShopifyCommerceCatalogDelivery(
      commerceCatalog.value,
    );
    if (canonical.ok) {
      const observation = canonical.value.observations[0];
      if (observation === undefined) {
        throw new Error(
          "validated Shopify catalog delivery has no observation",
        );
      }
      const identity = commerceObservationIdentity(observation);
      await env.EVENT_Q.send(
        createCommerceDeliveryQueueMessage({
          requestId,
          receivedAt,
          organisationId: organisationId.value,
          integrationAccountId: secret.value.integrationAccountId,
          labRunId: null,
          canonicalDeliveryJson: JSON.stringify(canonical.value),
          canonicalCueFactsJson: "[]",
        }),
        { contentType: "json" },
      );
      traceLog("shopify.commerce_catalog_queued", {
        requestId,
        organisation_id: organisationId.value,
        integration_account_id: secret.value.integrationAccountId,
        provider_delivery_id: canonical.value.providerDeliveryId,
        projection_kind: identity.kind,
        canonical_id: identity.canonicalId,
      });
    } else {
      traceWarn("shopify.commerce_catalog_projection_skipped", {
        requestId,
        organisation_id: organisationId.value,
        reason: canonical.error.code,
      });
    }
  }

  if (inventoryEnvelope.ok) {
    const canonical = normalizeShopifyCommerceInventoryDelivery(
      inventoryEnvelope.value,
    );
    if (canonical.ok) {
      const observation = canonical.value.observations[0];
      if (observation === undefined) {
        throw new Error(
          "validated Shopify inventory delivery has no observation",
        );
      }
      const identity = commerceObservationIdentity(observation);
      await env.EVENT_Q.send(
        createCommerceDeliveryQueueMessage({
          requestId,
          receivedAt,
          organisationId: organisationId.value,
          integrationAccountId: secret.value.integrationAccountId,
          labRunId: null,
          canonicalDeliveryJson: JSON.stringify(canonical.value),
          canonicalCueFactsJson: "[]",
        }),
        { contentType: "json" },
      );
      traceLog("shopify.commerce_inventory_queued", {
        requestId,
        organisation_id: organisationId.value,
        integration_account_id: secret.value.integrationAccountId,
        provider_delivery_id: canonical.value.providerDeliveryId,
        projection_kind: identity.kind,
        canonical_id: identity.canonicalId,
      });
    } else {
      traceWarn("shopify.commerce_inventory_projection_skipped", {
        requestId,
        organisation_id: organisationId.value,
        reason: canonical.error.code,
      });
    }
  }

  if (event.ok) {
    await env.CUE_Q.send(
      createCueQueueMessage({
        requestId,
        receivedAt,
        event: event.value,
      }),
      { contentType: "json" },
    );
    traceLog("shopify.webhook_queued", {
      requestId,
      organisation_id: organisationId.value,
      integration_account_id: event.value.integrationAccountId,
      native_id: event.value.nativeId,
      event_type: event.value.eventType,
    });
  }

  return jsonResponse({ ok: true });
}

/**
 * The merchant uninstalled Pantry's app from the shop. The account goes to
 * the credential revocation. Shopify signs the body but not the topic
 * header, so the body must be the shop that the header names: a signed
 * order body with a changed topic revokes nothing.
 */
async function revokeUninstalledShopifyAccount(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    shopDomain: string;
    integrationAccountId: IntegrationAccountId;
    body: JsonObject;
    receivedAt: number;
  }>,
): Promise<Response> {
  const shop = input.body.myshopify_domain;
  if (
    typeof shop !== "string" ||
    shop.toLowerCase() !== input.shopDomain.toLowerCase()
  ) {
    return shopifyWebhookErrorResponse({ code: "shopify_event_invalid" });
  }
  const outcome = await revokeAccountRemovedAtProvider({
    env: input.env,
    scope: input.scope,
    integrationAccountId: input.integrationAccountId,
    provider: "shopify",
    providerAccountId: input.shopDomain,
    reason: "shopify_app_uninstalled",
    now: input.receivedAt,
  });
  if (!outcome.ok) {
    return shopifyWebhookErrorResponse({ code: "shopify_connector_missing" });
  }
  return jsonResponse({ ok: true, revoked: outcome.value.kind === "revoked" });
}

function shopifyWebhookErrorResponse(error: ShopifyWebhookError): Response {
  switch (error.code) {
    case "shopify_signature_missing":
    case "shopify_signature_invalid":
      return errorResponse(error.code, "Shopify signature was rejected.", 401);
    case "shopify_event_invalid":
      return errorResponse(error.code, "Shopify event is invalid.", 400);
    case "shopify_event_unsupported":
      return errorResponse(error.code, "Shopify event is unsupported.", 422);
    case "shopify_connector_missing":
      return notFound();
    case "shopify_connector_inactive":
      return errorResponse(error.code, "Shopify connector is inactive.", 503);
    case "shopify_connector_ambiguous":
      return errorResponse(
        error.code,
        "Shopify webhook account is ambiguous.",
        409,
      );
    case "shopify_webhook_secret_invalid":
    case "vault_handle_unknown":
    case "credential_rule_inactive":
    case "vault_secret_revoked":
    case "vault_root_unavailable":
    case "vault_root_invalid":
    case "vault_ciphertext_invalid":
    case "vault_plaintext_invalid":
      return errorResponse(
        error.code,
        "Shopify webhook verification is unavailable.",
        503,
      );
    default:
      return assertNever(error);
  }
}
