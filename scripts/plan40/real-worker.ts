import gateway from "../../services/platform/src/integration-gateway";
import { reconcileCommerceOutbox } from "../../services/platform/src/commerce/outbox-worker";
import { newRequestId, parseIntegrationAccountId } from "../../foundation/kernel/ids";
import { ensureCreatedOrganisationActor } from "../../services/platform/src/control/organisation-runtime";
import {
  bootstrapOrganisation,
  issueControlSession,
  upsertUser,
  type User,
  type IssuedControlSession,
} from "../../services/platform/src/data/control-plane";
import { newControlMutationIdentity, type ControlMutationReceiptScope } from "../../services/platform/src/data/control-mutation";
import { CaseDO } from "../../services/platform/src/actors/case";
import { ConnectorDO } from "../../services/platform/src/actors/connector";
import { SessionDO } from "../../services/platform/src/actors/agent-session";
import { OrganisationDO } from "../../services/platform/src/actors/organisation";
import { parseInitialOrganisationPlacement } from "../../services/platform/src/placement";
import type { Env } from "../../foundation/kernel/env";
import {
  CommerceAdminClient,
  type PrepareCommerceCatalogListingV1,
  type CommerceMerchantSnapshotV1,
} from "../../packages/commerce-client/src/index.ts";

const SETUP_TOKEN = "plan40-local-setup-token";
const PRODUCT_ID = "product_plan40_browser";
const INTEGRATION_ACCOUNT_ID = "integration_plan40_browser";
const PROVIDER_CONNECTION_ID = "provider_plan40_browser";
const BINDING_ID = "commerce_binding_plan40_browser";
const MERCHANT_ID = "merchant_plan40_browser";
const PRODUCT_DESCRIPTION = "Freshly baked browser acceptance product.";

type ControlClient = Readonly<{
  readonly identity: User;
  readonly session: IssuedControlSession;
}>;

export class Plan40OrganisationDO extends OrganisationDO {}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__plan40/demo/owner" || pathname === "/__plan40/demo/editor") {
      return handleDemoLogin(request, env, pathname.endsWith("/owner") ? "owner" : "editor");
    }
    if (pathname === "/__plan40/setup") {
      return handleSetup(request, env);
    }
    return gateway.fetch(request, env, ctx);
  },
  queue: gateway.queue,
  scheduled: gateway.scheduled,
};

export { CaseDO, ConnectorDO, SessionDO };

async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" || request.headers.get("x-plan40-setup-token") !== SETUP_TOKEN) {
    return new Response("not found", { status: 404 });
  }
  const now = Date.now();
  const owner = await createControlClient(env, "plan40-browser-owner", "Plan 40 Owner", now);
  const editor = await createControlClient(env, "plan40-browser-editor", "Plan 40 Editor", now);
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "plan40-browser",
    locationHint: "wnam",
  });
  if (!placement.ok) return Response.json({ ok: false, error: placement.error.path }, { status: 500 });
  const organisation = await bootstrapOrganisation({
    db: env.DB,
    owner: owner.identity,
    organisationName: "Plan 40 Browser Acceptance",
    environment: "development",
    placement: placement.value,
    mutation: bootstrapMutation(owner.identity, now),
    now,
  });
  const commerceEngine = createCommerceAdminClient(env);
  if (commerceEngine === null) return setupFailure("commerce_unconfigured");
  const provisioned = await commerceEngine.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: organisation.organisationId,
    merchantId: MERCHANT_ID,
    createdAt: new Date(now).toISOString(),
  });
  if (!provisioned.ok) return setupFailure("commerce_provision_failed");
  const merchantSnapshot = await commerceEngine.readSnapshot(MERCHANT_ID);
  if (!merchantSnapshot.ok) return setupFailure("commerce_snapshot_failed");
  await addEditorAndCommerceBinding(
    env,
    organisation.organisationId,
    owner.identity,
    editor.identity,
    merchantSnapshot.value,
    now,
  );
  const prepared = await commerceEngine.prepareCatalogListing(
    catalogListing(organisation.organisationId, now),
  );
  if (!prepared.ok || prepared.value.outcome !== "applied") {
    return setupFailure("commerce_catalog_seed_failed");
  }
  await ensureCreatedOrganisationActor({ env, organisationId: organisation.organisationId, now });
  const integrationAccountId = parseIntegrationAccountId(INTEGRATION_ACCOUNT_ID);
  if (!integrationAccountId.ok) return setupFailure("integration_account_invalid");
  const reconciled = await reconcileCommerceOutbox({
    env,
    message: {
      type: "commerce.outbox_reconcile.v1",
      requestId: newRequestId(),
      receivedAt: now,
      organisationId: organisation.organisationId,
      integrationAccountId: integrationAccountId.value,
    },
    now,
  });
  if (reconciled.kind !== "drained") return setupFailure(`commerce_projection_failed:${reconciled.kind}`);
  await env.POLICY_KV.put("plan40-demo-path",
    `/portal/${organisation.organisationHandle}/${organisation.workspace.workspaceHandle}/products/${PRODUCT_ID}`);
  return Response.json({
    ok: true,
    origin: env.PANTRY_PUBLIC_ORIGIN,
    organisationId: organisation.organisationId,
    organisationHandle: organisation.organisationHandle,
    workspaceHandle: organisation.workspace.workspaceHandle,
    productId: PRODUCT_ID,
    owner: browserSession(owner),
    editor: browserSession(editor),
  });
}

async function handleDemoLogin(request: Request, env: Env, persona: "owner" | "editor"): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const path = await env.POLICY_KV.get("plan40-demo-path");
  if (path === null) return new Response(null, { status: 503 });
  const client = await createControlClient(env, `plan40-browser-${persona}`,
    persona === "owner" ? "Plan 40 Owner" : "Plan 40 Editor", Date.now());
  const cookies = browserSession(client);
  const headers = new Headers({ location: path, "cache-control": "no-store" });
  headers.append("set-cookie", `${cookies.sessionCookie}; Path=/; HttpOnly; SameSite=Lax`);
  headers.append("set-cookie", `${cookies.csrfCookie}; Path=/; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

function createCommerceAdminClient(env: Env): CommerceAdminClient | null {
  if (env.COMMERCE_BASE_URL === undefined || env.COMMERCE_SERVICE_TOKEN === undefined) return null;
  try {
    return new CommerceAdminClient({
      baseUrl: env.COMMERCE_BASE_URL,
      serviceToken: env.COMMERCE_SERVICE_TOKEN,
      fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
    });
  } catch {
    return null;
  }
}

function catalogListing(organisationId: string, now: number): PrepareCommerceCatalogListingV1 {
  const requestedAt = new Date(now).toISOString();
  const variantId = "variant_plan40_browser";
  const salesChannelId = "sales_channel_plan40_browser";
  return {
    schemaVersion: "commerce.prepare-catalog-listing.v1",
    organisationId,
    merchantId: MERCHANT_ID,
    expectedMerchantRevision: 0,
    idempotencyKey: "plan40-browser-catalog",
    actionNonce: "plan40-browser-catalog",
    requestedAt,
    salesChannel: {
      id: salesChannelId,
      revision: 1,
      name: "Plan 40 Browser Storefront",
      kind: "online",
      lifecycle: { state: "active", activeAt: requestedAt },
      occurredAt: requestedAt,
    },
    product: {
      id: PRODUCT_ID,
      revision: 1,
      title: "Plan 40 Browser Product",
      description: PRODUCT_DESCRIPTION,
      occurredAt: requestedAt,
    },
    variant: {
      id: variantId,
      revision: 1,
      productId: PRODUCT_ID,
      sku: "plan40-browser-product",
      title: "Plan 40 Browser Product",
      options: [],
      media: [],
      occurredAt: requestedAt,
    },
    offer: {
      id: "offer_plan40_browser",
      revision: 1,
      variantId,
      salesChannelId,
      price: { amountMinor: 1200, currency: "JPY" },
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: requestedAt },
      occurredAt: requestedAt,
    },
    consumptionPlan: {
      consumptionPlanId: "consumption_plan40_browser",
      variantId,
      revision: 1,
      scope: { kind: "organisation" },
      mode: { kind: "untracked" },
      lifecycle: "active",
    },
  };
}

function setupFailure(error: string): Response {
  return Response.json({ ok: false, error }, { status: 500 });
}

async function createControlClient(env: Env, subject: string, displayName: string, now: number): Promise<ControlClient> {
  const identity = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "urn:pantry:plan40-local",
      subject,
      email: `${subject}@plan40.local`,
      displayName,
      emailVerified: true,
    },
    now,
  });
  const session = await issueControlSession({ db: env.DB, userId: identity.userId, now, ttlMs: 60 * 60 * 1_000 });
  return { identity, session };
}

function bootstrapMutation(owner: User, now: number) {
  const scope: ControlMutationReceiptScope = {
    userId: owner.userId,
    organisationScope: "organisation:create",
    route: "/v1/control/organisations",
    operation: "organisation.create",
  };
  return {
    scope,
    boundary: {
      kind: "unversioned" as const,
      idempotencyKey: `plan40-browser-${crypto.randomUUID()}`,
      requestHash: "plan40-browser-bootstrap",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "plan40-browser-owner",
      causationId: `plan40-browser-${crypto.randomUUID()}`,
      now,
    }),
  };
}

async function addEditorAndCommerceBinding(
  env: Env,
  organisationId: string,
  owner: User,
  editor: User,
  merchantSnapshot: CommerceMerchantSnapshotV1,
  now: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)`)
      .bind(organisationId, "person_plan40_editor", editor.displayName),
    env.DB.prepare(`INSERT INTO organisation_membership (organisation_id, user_id, person_id, role, status, created_at, revoked_at)
      VALUES (?, ?, ?, 'operator', 'active', ?, NULL)`)
      .bind(organisationId, editor.userId, "person_plan40_editor", now),
    env.DB.prepare(`INSERT INTO provider_connection (
      provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
      credential_generation, credential_ref, provider_application,
      application_credential_generation, asset_grant_revision, lifecycle,
      granted_scopes, created_by_user_id, created_at, updated_at,
      disabled_at, revoked_at, environment, provider_subject_id
    ) VALUES (?, ?, 'shopify', 'api_key', 'connection_credential', 1, ?, NULL, NULL, NULL,
      'active', '[]', ?, ?, ?, NULL, NULL, 'development', '')`)
      .bind(PROVIDER_CONNECTION_ID, organisationId, "local:plan40-commerce", owner.userId, now, now),
    env.DB.prepare(`INSERT INTO integration_account (
      integration_account_id, organisation_id, provider_connection_id, provider,
      provider_account_id, account_kind, display_name, lifecycle, lifecycle_reason_code,
      capability_set, audience_policy, retention_policy, created_at, updated_at,
      disabled_by_user_id, disabled_at, revoked_at, environment, is_default_for_provider
    ) VALUES (?, ?, ?, 'shopify', ?, 'merchant', ?, 'active', NULL, '[]', '{"kind":"operator"}', '{"kind":"organisation_default"}', ?, ?, NULL, NULL, NULL, 'development', 0)`)
      .bind(INTEGRATION_ACCOUNT_ID, organisationId, PROVIDER_CONNECTION_ID, MERCHANT_ID, "Plan 40 Commerce", now, now),
    env.DB.prepare(`INSERT INTO commerce_merchant_binding (
      binding_id, organisation_id, integration_account_id, merchant_id, environment,
      delivery_signing_key_id, delivery_signing_public_key_b64, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'development', ?, ?, 1, ?, ?)`)
      .bind(BINDING_ID, organisationId, INTEGRATION_ACCOUNT_ID, MERCHANT_ID,
        merchantSnapshot.deliverySigner.keyId, merchantSnapshot.deliverySigner.publicKeyB64, now, now),
    env.DB.prepare(`INSERT INTO organisation_commerce_system (
      organisation_id, system_kind, commerce_binding_id, shopify_integration_account_id,
      revision, selected_at, selected_by_user_id
    ) VALUES (?, 'builtin_commerce', ?, NULL, 1, ?, ?)`)
      .bind(organisationId, BINDING_ID, now, owner.userId),
  ]);
}

function browserSession(client: ControlClient): Readonly<{ readonly sessionCookie: string; readonly csrfCookie: string; readonly displayName: string }> {
  return {
    sessionCookie: `pantry_session=${encodeURIComponent(client.session.token)}`,
    csrfCookie: `pantry_csrf=${encodeURIComponent(client.session.csrfToken)}`,
    displayName: client.identity.displayName,
  };
}
