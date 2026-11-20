import { requireActiveOrganisationActor } from "../actors/actor-router";
import { parseShopifyLocationObservationEnvelope } from "./location-observation";
import {
  normalizeShopifyCommerceCatalogDelivery,
  normalizeShopifyCommerceInventoryDelivery,
  normalizeShopifyCommerceOrderDelivery,
  normalizeShopifyCommerceResourceDelivery,
} from "../commerce/commerce-wasm";
import type { VaultHandle } from "../credential-vault";
import {
  createConnectedIntegration,
  finalizeConnectedIntegrationAccount,
  requireConnectionCredentialAuthority,
  upsertProviderWebhook,
  type IntegrationAccount,
} from "../data/integration-account";
import type { ProvisioningProviderConnectionAttempt } from "../data/provider-attempt";
import { persistProviderResourceSnapshot } from "../data/provider-resource";
import type { Env } from "../env";
import {
  newRequestId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import { createCommerceDeliveryQueueMessage } from "../commerce/queue-messages";
import {
  discoverShopifyIdentity,
  exchangeShopifyAuthorizationCode,
  shopifyOnboardingAdapter,
  verifyShopifyCallback,
} from "./provider-adapter";
import { providerIngressOrigin } from "../provider-lifecycle/authorization";
import type {
  CompleteProviderInput,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "../provider-lifecycle/domain";
import {
  advanceProviderPhase,
  completeProviderCredentialCutover,
  failProviderCompletion,
  finishProviderCompletion,
  providerCredentialHandle,
  providerSigningHandle,
  storeBearerCredential,
  storeHeaderCredential,
  verifyExistingAccountIdentity,
} from "../provider-lifecycle/provisioning";
import type { Result } from "../result";
import { fetchShopifyInitialCommerce } from "./connector/initial-sync";
import { registerShopifyWebhooks } from "./connector/webhook-registration";
import type {
  ShopifyLocationSnapshotAccess,
  ShopifyPublicationSnapshotAccess,
  ShopifyWebhookRegistration,
  ShopifyWebhookSubscriptionResult,
  ShopifyWebhookTopic,
} from "./connector";

export async function connectShopify(
  input: CompleteProviderInput,
  attempt: ProviderOAuthAttempt,
  provisioning: ProvisioningProviderConnectionAttempt,
  code: string,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  let current = provisioning;
  const base = attempt.state.attempt;
  if (attempt.context.provider !== "shopify") {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_context_invalid",
    });
  }
  const clientId = input.env.SHOPIFY_CLIENT_ID;
  const clientSecret = input.env.SHOPIFY_CLIENT_SECRET;
  if (clientId === undefined || clientSecret === undefined) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_configuration_missing",
    });
  }
  if (!(await verifyShopifyCallback(input.url, clientSecret))) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_callback_signature_invalid",
    });
  }
  const token = await exchangeShopifyAuthorizationCode({
    shopDomain: attempt.context.shopDomain,
    clientId,
    clientSecret,
    code,
    fetcher: input.fetcher,
  });
  if (!token.ok) {
    return failProviderCompletion(input, attempt, current, token.error);
  }
  if (!scopesAreComplete(token.value.scopes)) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_scope_missing",
    });
  }
  const shop = await discoverShopifyIdentity({
    fetcher: input.fetcher,
    shopDomain: attempt.context.shopDomain,
    accessToken: token.value.accessToken,
  });
  if (!shop.ok) {
    return failProviderCompletion(input, attempt, current, shop.error);
  }
  if (
    shop.value.environment !== base.environment ||
    shop.value.myshopifyDomain !== attempt.context.shopDomain
  ) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_environment_mismatch",
    });
  }
  const accountIdentity = await verifyExistingAccountIdentity(
    input.scope.database,
    base,
    "shopify",
    shop.value.myshopifyDomain,
  );
  if (!accountIdentity.ok) {
    return failProviderCompletion(
      input,
      attempt,
      current,
      accountIdentity.error,
    );
  }
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_identity",
    {
      provider_subject_id: shop.value.shopId,
      shop_domain: shop.value.myshopifyDomain,
      shop_plan: shop.value.planDisplayName,
      scope_count: token.value.scopes.length,
    },
    "persisting_credential",
  );
  const credentialRef = providerCredentialHandle(
    base.organisationId,
    "shopify",
    attempt.context.shopDomain,
    input.now,
  );
  const stored = await storeBearerCredential(
    input.env,
    input.scope,
    credentialRef,
    token.value.accessToken,
    input.now,
  );
  if (!stored.ok) {
    return failProviderCompletion(input, attempt, current, stored.error);
  }
  current = await advanceProviderPhase(
    input,
    current,
    "persisting_credential",
    {
      credential_ref: credentialRef,
      credential_verified: true,
    },
    "discovering_accounts",
  );
  const registration = await registerShopifyWebhooks({
    shopDomain: attempt.context.shopDomain,
    accessToken: token.value.accessToken,
    endpointUrl: `${providerIngressOrigin(input.env)}/hook/shopify/${base.organisationId}`,
    fetcher: input.fetcher,
  });
  if (!registration.ok) {
    console.error("shopify.onboarding_webhook_registration_failed", {
      organisationId: base.organisationId,
      provider: "shopify",
      reasonCode: registration.error.code,
      operation: "provider.callback.provision",
    });
    return failProviderCompletion(input, attempt, current, {
      code: "provider_webhook_registration_failed",
    });
  }
  const signingSecretRef = providerSigningHandle(
    base.organisationId,
    "shopify",
    attempt.context.shopDomain,
    input.now,
  );
  const signingStored = await storeHeaderCredential(
    input.env,
    input.scope,
    signingSecretRef,
    "x-shopify-hmac-sha256",
    clientSecret,
    input.now,
  );
  if (!signingStored.ok) {
    return failProviderCompletion(input, attempt, current, signingStored.error);
  }
  const connected = await createConnectedIntegration(input.scope.database, {
    organisationId: base.organisationId,
    provider: "shopify",
    providerSubjectId: shop.value.shopId,
    environment: base.environment,
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef },
    grantedScopes: token.value.scopes,
    createdByUserId: base.userId,
    providerAccountId: shop.value.myshopifyDomain,
    accountKind: "store",
    displayName: shop.value.displayName,
    capabilities: shopifyCapabilities(registration.value),
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now: input.now,
  });
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_accounts",
    {
      integration_account_ids: [connected.account.integrationAccountId],
    },
    "reconciling_webhooks",
  );
  await persistShopifyWebhooks(
    input,
    attempt,
    connected.account,
    requireConnectionCredentialAuthority(connected.connection)
      .credentialGeneration,
    signingSecretRef,
    registration.value,
  );
  current = await advanceProviderPhase(
    input,
    current,
    "reconciling_webhooks",
    {
      registered_topics: registeredShopifyWebhooks(registration.value).length,
      webhook_manifest_reconciled: true,
    },
    "discovering_resources",
  );
  const snapshotRevision = await persistProviderResourceSnapshot({
    db: input.scope.database,
    organisationId: base.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    provider: "shopify",
    environment: base.environment,
    resources: [
      {
        canonicalResourceId: attempt.context.shopDomain,
        providerResourceId: attempt.context.shopDomain,
        providerAccountId: attempt.context.shopDomain,
        displayLabel: attempt.context.shopDomain,
        accessState: "accessible",
        providerRevision: `shopify-shop:${attempt.context.shopDomain}`,
        resourceKind: "store",
      },
    ],
    now: input.now,
  });
  current = await advanceProviderPhase(
    input,
    current,
    "discovering_resources",
    {
      shop_summary_discovered: true,
      snapshot_revision: snapshotRevision,
      resource_count: 1,
    },
    "verifying_connection",
  );
  const initialSync = await queueShopifyInitialCommerce({
    env: input.env,
    shopDomain: attempt.context.shopDomain,
    accessToken: token.value.accessToken,
    organisationId: base.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    observedAt: input.now,
    locationAccess: shopifyLocationSnapshotAccess(token.value.scopes),
    publicationAccess: shopifyPublicationSnapshotAccess(token.value.scopes),
    fetcher: input.fetcher,
  });
  if (!initialSync.ok) {
    return failProviderCompletion(input, attempt, current, initialSync.error);
  }
  current = await advanceProviderPhase(
    input,
    current,
    "verifying_connection",
    {
      provider_identity_verified: true,
      required_scopes_verified: true,
      webhook_coverage_verified: true,
      initial_catalog_events_queued: initialSync.value.catalogCount,
      initial_inventory_events_queued: initialSync.value.inventoryCount,
      initial_location_observations_accepted: initialSync.value.locationCount,
      initial_location_query: initialSync.value.locationQuery,
      initial_order_events_queued: initialSync.value.orderCount,
      initial_publication_query: initialSync.value.publicationQuery,
      initial_resource_events_queued: initialSync.value.resourceCount,
    },
    "finalizing",
  );
  const finalized = await finalizeConnectedIntegrationAccount({
    db: input.scope.database,
    organisationId: base.organisationId,
    integrationAccountId: connected.account.integrationAccountId,
    now: input.now,
  });
  if (!finalized.ok) {
    return failProviderCompletion(input, attempt, current, {
      code: "provider_oauth_response_invalid",
    });
  }
  const cutover = await completeProviderCredentialCutover(
    input,
    base.organisationId,
    connected.connection.providerConnectionId,
    requireConnectionCredentialAuthority(connected.connection)
      .credentialGeneration,
  );
  if (!cutover.ok) {
    return failProviderCompletion(input, attempt, current, cutover.error);
  }
  return finishProviderCompletion(
    input,
    attempt,
    current,
    connected.connection.providerConnectionId,
    [finalized.value.integrationAccountId],
    { kind: "healthy", evidenceCode: "provider_webhook_verified" },
  );
}

async function queueShopifyInitialCommerce(input: {
  readonly env: Env;
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly locationAccess: ShopifyLocationSnapshotAccess;
  readonly publicationAccess: ShopifyPublicationSnapshotAccess;
  readonly fetcher: typeof fetch;
}): Promise<
  Result<
    {
      readonly catalogCount: number;
      readonly inventoryCount: number;
      readonly locationCount: number;
      readonly locationQuery: "queried" | "skipped_scope";
      readonly orderCount: number;
      readonly publicationQuery: "queried" | "skipped_scope";
      readonly resourceCount: number;
    },
    ProviderOnboardingError
  >
> {
  const snapshot = await fetchShopifyInitialCommerce(input);
  if (!snapshot.ok) {
    console.error("shopify.initial_sync_failed", {
      organisationId: input.organisationId,
      resource: snapshot.error.resource,
      reasonCode: snapshot.error.code,
    });
    return { ok: false, error: { code: "provider_initial_sync_failed" } };
  }

  let locationCount = 0;
  if (snapshot.value.locations.length > 0) {
    try {
      const organisation = await requireActiveOrganisationActor({
        env: input.env,
        organisationId: input.organisationId,
        now: input.observedAt,
      });
      for (const envelope of snapshot.value.locations) {
        const parsed = parseShopifyLocationObservationEnvelope(
          envelope,
          input.observedAt,
        );
        if (!parsed.ok) {
          return { ok: false, error: { code: "provider_initial_sync_failed" } };
        }
        const accepted = await organisation.acceptShopifyLocationObservation(
          parsed.value,
        );
        if (!accepted.ok) {
          return { ok: false, error: { code: "provider_initial_sync_failed" } };
        }
        locationCount += 1;
      }
    } catch {
      return { ok: false, error: { code: "provider_initial_sync_failed" } };
    }
  }

  let catalogCount = 0;
  for (const envelope of snapshot.value.catalog) {
    const normalized = normalizeShopifyCommerceCatalogDelivery(envelope);
    if (!normalized.ok) {
      console.error("shopify.initial_sync_normalization_failed", {
        organisationId: input.organisationId,
        resource: "catalog",
        error: normalized.error,
      });
      return { ok: false, error: { code: "provider_initial_sync_failed" } };
    }
    await input.env.EVENT_Q.send(
      createCommerceDeliveryQueueMessage({
        requestId: newRequestId(),
        receivedAt: input.observedAt,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        labRunId: null,
        canonicalDeliveryJson: JSON.stringify(normalized.value),
        canonicalCueFactsJson: "[]",
      }),
    );
    catalogCount += 1;
  }

  let orderCount = 0;

  let inventoryCount = 0;
  for (const envelope of snapshot.value.inventory) {
    const normalized = normalizeShopifyCommerceInventoryDelivery(envelope);
    if (!normalized.ok) {
      console.error("shopify.initial_sync_normalization_failed", {
        organisationId: input.organisationId,
        resource: "inventory",
        error: normalized.error,
      });
      return { ok: false, error: { code: "provider_initial_sync_failed" } };
    }
    await input.env.EVENT_Q.send(
      createCommerceDeliveryQueueMessage({
        requestId: newRequestId(),
        receivedAt: input.observedAt,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        labRunId: null,
        canonicalDeliveryJson: JSON.stringify(normalized.value),
        canonicalCueFactsJson: "[]",
      }),
    );
    inventoryCount += 1;
  }

  for (const envelope of snapshot.value.orders) {
    const normalized = normalizeShopifyCommerceOrderDelivery(envelope);
    if (!normalized.ok) {
      console.error("shopify.initial_sync_normalization_failed", {
        organisationId: input.organisationId,
        resource: "orders",
        error: normalized.error,
      });
      return { ok: false, error: { code: "provider_initial_sync_failed" } };
    }
    await input.env.EVENT_Q.send(
      createCommerceDeliveryQueueMessage({
        requestId: newRequestId(),
        receivedAt: input.observedAt,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        labRunId: null,
        canonicalDeliveryJson: JSON.stringify(normalized.value),
        canonicalCueFactsJson: "[]",
      }),
    );
    orderCount += 1;
  }

  let resourceCount = 0;
  for (const envelope of snapshot.value.resources) {
    const normalized = normalizeShopifyCommerceResourceDelivery(envelope);
    if (!normalized.ok) {
      console.error("shopify.initial_sync_normalization_failed", {
        organisationId: input.organisationId,
        resource: envelope.resource.kind,
        error: normalized.error,
      });
      return { ok: false, error: { code: "provider_initial_sync_failed" } };
    }
    await input.env.EVENT_Q.send(
      createCommerceDeliveryQueueMessage({
        requestId: newRequestId(),
        receivedAt: input.observedAt,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        labRunId: null,
        canonicalDeliveryJson: JSON.stringify(normalized.value),
        canonicalCueFactsJson: "[]",
      }),
    );
    resourceCount += 1;
  }

  return {
    ok: true,
    value: {
      catalogCount,
      inventoryCount,
      locationCount,
      locationQuery: snapshot.value.locationQuery,
      orderCount,
      publicationQuery: snapshot.value.publicationQuery,
      resourceCount,
    },
  };
}

function shopifyLocationSnapshotAccess(
  scopes: readonly string[],
): ShopifyLocationSnapshotAccess {
  if (scopes.includes("read_locations")) {
    return { kind: "read_locations", scope: "read_locations" };
  }
  if (scopes.includes("read_markets_home")) {
    return { kind: "read_markets_home", scope: "read_markets_home" };
  }
  return { kind: "inventory_only", scope: "read_inventory" };
}

function shopifyPublicationSnapshotAccess(
  scopes: readonly string[],
): ShopifyPublicationSnapshotAccess {
  return scopes.includes("read_publications")
    ? { kind: "read_publications", scope: "read_publications" }
    : { kind: "scope_missing", requiredScope: "read_publications" };
}

async function persistShopifyWebhooks(
  input: CompleteProviderInput,
  attempt: ProviderOAuthAttempt,
  account: IntegrationAccount,
  credentialGeneration: number,
  signingSecretRef: VaultHandle,
  registration: ShopifyWebhookRegistration,
): Promise<void> {
  const rows = registeredShopifyWebhooks(registration);
  for (const row of rows) {
    const base = attempt.state.attempt;
    await upsertProviderWebhook({
      db: input.scope.database,
      organisationId: base.organisationId,
      integrationAccountId: account.integrationAccountId,
      provider: "shopify",
      environment: base.environment,
      providerNativeId: row.subscriptionId,
      eventType: row.topic,
      signingSecretRef,
      credentialGeneration,
      lifecycle: { kind: "live", lastVerifiedAt: input.now },
      now: input.now,
    });
  }
}

function shopifyCapabilities(
  registration: ShopifyWebhookRegistration,
): readonly string[] {
  const capabilities = [
    "orders.read",
    "inventory.read",
    "catalog.read",
    "inventory.propose",
    "fulfillment.propose",
    "inventory.events",
  ];

  if (
    registration.ordersCreate.kind === "live" ||
    registration.ordersUpdated.kind === "live"
  ) {
    capabilities.push("orders.events");
  }

  capabilities.push("catalog.events");

  return capabilities;
}

function registeredShopifyWebhooks(
  registration: ShopifyWebhookRegistration,
): readonly ShopifyWebhookSubscriptionResult<ShopifyWebhookTopic>[] {
  const rows: ShopifyWebhookSubscriptionResult<ShopifyWebhookTopic>[] = [
    registration.inventoryLevelsUpdate,
    registration.productsCreate,
    registration.productsDelete,
    registration.productsUpdate,
  ];

  if (registration.ordersCreate.kind === "live") {
    rows.unshift(registration.ordersCreate.subscription);
  }
  if (registration.ordersUpdated.kind === "live") {
    rows.unshift(registration.ordersUpdated.subscription);
  }

  return rows;
}

function scopesAreComplete(grantedScopes: readonly string[]): boolean {
  const granted = new Set(grantedScopes);
  return shopifyOnboardingAdapter.requiredScopes.every((requiredScope) =>
    shopifyOnboardingAdapter.scopeIsGranted(requiredScope, granted),
  );
}
