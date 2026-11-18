import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { fixtureDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { HttpResponseResolver } from "msw";
import { isRecord } from "@seams/std";
import { CommerceAdminClient } from "@seams/commerce-client";
import type { CommerceProjection } from "@seams/contracts";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import type { OrganisationDO } from "../../src/actors/organisation";
import { APPROVAL_GRANT_COOKIE } from "../../src/control/authorization";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { writeOrganisationCapabilityPolicy } from "../../src/data/capability-policy";
import { commerceCanonicalResourceId } from "../../src/commerce/provider";
import { requireUserId } from "../test-ids";
import {
  ORGANISATION_ID,
  WORKSPACE_ID,
  CHANNEL_ID,
  ROOT_TS,
  createRequiredGrant,
  openRouterText,
  openRouterToolCall,
  signedSlackRequest,
  slackEnvelope,
} from "./slack-journey-support";

export const MERCHANT = "merchant_bakery_c3_pi_sdk_effect";
export const PRODUCT = "product_pi_cookie_box";
export const ACCOUNT = "integration_pi_effect";
export const OWNER = requireUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
export const VARIANT = "variant_pi_cookies";
export const OFFER = "offer_pi_cookies";
export const SALES_CHANNEL = "channel_pi_online";

export async function installEffectAuthority(
  slackAccountId: string,
  scenario: "listing" | "price" | "report_denial" | "plugin",
  /** False leaves proposals off and ungranted, for an agent to ask. */
  proposals = true,
): Promise<IssuedControlSession> {
  const now = Date.now();
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, OWNER)
    .run();
  const session = await issueControlSession({
    db: env.DB,
    userId: OWNER,
    now,
    ttlMs: 30 * 60_000,
  });
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_activation_attempt (
       activation_attempt_id, organisation_id, readiness_version, readiness_hash,
       status, started_at, updated_at, completed_at
     ) VALUES ('activation_attempt_pi_effect', ?, 1, 'pi-effect-ready',
       'completed', ?, ?, ?)`,
      )
      .bind(ORGANISATION_ID, now, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_activation_receipt (
       activation_receipt_id, activation_attempt_id, organisation_id, readiness_hash,
       policy_snapshot_id, cue_snapshot_id, capability_profile, activated_at
     ) VALUES ('activation_receipt_pi_effect', 'activation_attempt_pi_effect', ?,
       'pi-effect-ready', 'setup_policy_pi_effect', 'setup_cue_pi_effect',
       'approved_provider_writes', ?)`,
      )
      .bind(ORGANISATION_ID, now),
    fixtureDatabase()
      .prepare(
        `UPDATE organisation_onboarding SET lifecycle = 'active',
       capability_profile = 'approved_provider_writes', configuration_version = 1,
       activation_receipt_id = 'activation_receipt_pi_effect', activated_at = ?
       WHERE organisation_id = ?`,
      )
      .bind(now, ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_onboarding_selection (
       organisation_id, policy_template_id, policy_template_version, cue_preset_id,
       cue_preset_version, cue_workspace_id, cue_channel_id,
       selected_by_user_id, selected_at
     ) VALUES (?, 'commerce_operator', 1, 'commerce_operator', 1, ?, ?, ?, ?)`,
      )
      .bind(ORGANISATION_ID, WORKSPACE_ID, CHANNEL_ID, OWNER, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO underclerk_merchant_binding (
      binding_id, organisation_id, integration_account_id, merchant_id, environment,
      delivery_signing_key_id, delivery_signing_public_key_b64, revision, created_at, updated_at
    ) VALUES ('underclerk_binding_pi_effect', ?, ?, ?, 'development', 'key_pi_effect_e2e',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, ?, ?)`,
      )
      .bind(ORGANISATION_ID, ACCOUNT, MERCHANT, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_commerce_system (
      organisation_id, system_kind, underclerk_binding_id, shopify_integration_account_id,
      revision, selected_at, selected_by_user_id
    ) VALUES (?, 'satyr_commerce', 'underclerk_binding_pi_effect', NULL, 1, ?, ?)`,
      )
      .bind(ORGANISATION_ID, now, OWNER),
  ]);
  if (proposals)
    await createRequiredGrant({
      grantId: "grant_pi_effect",
      subject: { kind: "organisation_role", role: "owner" },
      target: {
        kind: "provider_resource",
        capabilityId: "commerce.action.propose",
        capabilityVersion: 1,
        integrationAccountId: ACCOUNT,
        resourceScope: "*",
      },
      now,
    });
  for (const capabilityId of [
    ...(proposals ? (["commerce.action.propose"] as const) : []),
    "commerce.entity_plane.context",
    "commerce.entity.read",
  ] as const) {
    const capability = await writeOrganisationCapabilityPolicy({
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      write: {
        kind: "change",

        capabilityId,
        expectedRevision: 1,
        mode: "enabled",
        provenance: {
          kind: "operator",
          userId: OWNER,
          mutationReceiptId: "receipt_pi_effect_capability",
        },
        now,
      },
    });
    if (!capability.ok) throw new Error(capability.error.code);
  }
  await createRequiredGrant({
    grantId: "grant_pi_entity_context",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: "commerce.entity_plane.context",
      capabilityVersion: 1,
    },
    now,
  });
  for (const typeId of [
    "product",
    "sellable_variant",
    "offer",
    "sales_channel",
    "order",
  ] as const) {
    const target = {
      kind: "commerce_read" as const,
      capabilityId: "commerce.entity.read" as const,
      capabilityVersion: 1,
      scope: {
        kind: "entity_type" as const,
        entityTypeId: { origin: "system" as const, typeId },
      },
    };
    await createRequiredGrant({
      grantId: `grant_pi_read_${typeId}`,
      subject: { kind: "organisation_role", role: "owner" },
      target,
      now,
    });
    await createRequiredGrant({
      grantId: `grant_pi_channel_${typeId}`,
      subject: {
        kind: "conversation",
        integrationAccountId: slackAccountId,
        conversationId: CHANNEL_ID,
      },
      target,
      now,
    });
  }
  if (scenario === "listing" || scenario === "price")
    await seedProviderProduct(scenario === "listing");
  if (scenario === "plugin") await provisionProviderMerchant();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  if (scenario === "listing" || scenario === "price")
    await runInDurableObject(organisation, seedProductProjection);
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now,
  });
  if (!published.ok) throw new Error(published.error.code);
  return session;
}

export function providerClient(): CommerceAdminClient {
  return new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
}

export async function provisionProviderMerchant(): Promise<void> {
  const provisioned = await providerClient().provisionMerchant({
    schemaVersion: "underclerk.provision-merchant.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT,
    createdAt: new Date().toISOString(),
  });
  if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));
}

export async function seedProviderProduct(
  loseFirstPublish = true,
): Promise<void> {
  const client = providerClient();
  const now = new Date().toISOString();
  await provisionProviderMerchant();
  if (loseFirstPublish) await armLostPublish();
  const prepared = await client.prepareCatalogListing({
    merchantId: MERCHANT,
    expectedMerchantRevision: 0,
    idempotencyKey: "pi-effect-seed",
    salesChannel: {
      id: "channel_pi_online",
      revision: 1,
      name: "Online",
      kind: "online",
      lifecycle: { state: "active", activeAt: now },
      occurredAt: now,
    },
    product: {
      id: PRODUCT,
      revision: 1,
      title: "Cookie box",
      description: "Six assorted cookies.",
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active" as const,
      occurredAt: now,
    },
    variant: {
      id: "variant_pi_cookies",
      revision: 1,
      productId: PRODUCT,
      sku: "PI-COOKIES",
      title: "Six cookies",
      options: [],
      media: [],
      barcode: null,
      status: "active" as const,
      occurredAt: now,
    },
    offer: {
      id: "offer_pi_cookies",
      revision: 1,
      variantId: "variant_pi_cookies",
      salesChannelId: "channel_pi_online",
      price: { amountMinor: 2400, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: now },
      occurredAt: now,
    },
    consumptionPlan: {
      consumptionPlanId: "plan_pi_cookies",
      variantId: "variant_pi_cookies",
      revision: 1,
      scope: { kind: "organisation" },
      mode: { kind: "untracked" },
      lifecycle: "active",
    },
  });
  expect(prepared).toMatchObject({ ok: true, value: { outcome: "applied" } });
}

/**
 * Commerce's fixture Worker loses the response of the first committed
 * publish for this merchant and counts mutations and receipt reads.
 */
async function armLostPublish(): Promise<void> {
  const armed = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${MERCHANT}/test-fixture`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer underclerk-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "lose_first_committed_publish" }),
    },
  );
  if (!armed.ok) throw new Error(await armed.text());
}

export function seedProductProjection(
  _actor: OrganisationDO,
  state: DurableObjectState,
): void {
  const now = Date.now();
  const occurredAt = new Date(now).toISOString();
  const product: CommerceProjection = {
    kind: "product",
    projection: {
      provenance: {
        organisationId: ORGANISATION_ID,
        integrationAccountId: ACCOUNT,
        source: "underclerk",
        resourceType: "product",
        resourceId: commerceCanonicalResourceId(MERCHANT, PRODUCT),
        revision: 1,
        occurredAt,
        observedAt: occurredAt,
      },
      title: "Cookie box",
      description: "Six assorted cookies.",
    },
  };
  const variant: CommerceProjection = {
    kind: "sellable_variant",
    projection: {
      provenance: listingProvenance("sellable_variant", VARIANT, occurredAt),
      productId: commerceCanonicalResourceId(MERCHANT, PRODUCT),
      variantId: commerceCanonicalResourceId(MERCHANT, VARIANT),
      sku: "PI-COOKIES",
      title: "Six cookies",
      options: [],
      media: [],
    },
  };
  const offer: CommerceProjection = {
    kind: "offer",
    projection: {
      provenance: listingProvenance("offer", OFFER, occurredAt),
      variantId: commerceCanonicalResourceId(MERCHANT, VARIANT),
      salesChannelId: commerceCanonicalResourceId(MERCHANT, SALES_CHANNEL),
      price: { amountMinor: 2400, currency: "JPY" },
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: occurredAt },
    },
  };
  const channel: CommerceProjection = {
    kind: "sales_channel",
    projection: {
      provenance: listingProvenance("sales_channel", SALES_CHANNEL, occurredAt),
      name: "Online",
      kind: "online",
      lifecycle: { state: "active", activeAt: occurredAt },
    },
  };
  for (const projection of [product, variant, offer, channel]) {
    const canonicalId = projection.projection.provenance.resourceId;
    state.storage.sql.exec(
      `INSERT INTO commerce_projection (
    organisation_id, projection_kind, canonical_id, integration_account_id,
    revision, lifecycle, projection_json, updated_at, validated_at, lab_run_id
  ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?, NULL)`,
      ORGANISATION_ID,
      projection.kind,
      canonicalId,
      ACCOUNT,
      JSON.stringify(projection),
      now,
      now,
    );
    state.storage.sql.exec(
      `INSERT INTO commerce_projection_relation_text (
     organisation_id, projection_kind, canonical_id, integration_account_id,
     display_name_folded, search_text_folded
   ) VALUES (?, ?, ?, ?, 'cookie box', 'cookie box')`,
      ORGANISATION_ID,
      projection.kind,
      canonicalId,
      ACCOUNT,
    );
  }
}

export function listingProvenance(
  resourceType: CommerceProjection["kind"],
  resourceId: string,
  occurredAt: string,
): CommerceProjection["projection"]["provenance"] {
  return {
    organisationId: ORGANISATION_ID,
    integrationAccountId: ACCOUNT,
    source: "underclerk",
    resourceType,
    resourceId: commerceCanonicalResourceId(MERCHANT, resourceId),
    revision: 1,
    occurredAt,
    observedAt: occurredAt,
  };
}

export class ListingProvider {
  readonly requests: Record<string, unknown>[] = [];

  constructor(
    private readonly proposedReply = "PI_LISTING_AWAITING_APPROVAL",
  ) {}

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("Invalid listing model request");
    this.requests.push(body);
    switch (this.requests.length) {
      case 1:
        return openRouterToolCall(
          "tool_search",
          {
            query: "commerce_entity_context",
            limit: 1,
          },
          "pi_listing_discover",
        );
      case 2:
        return openRouterToolCall(
          "tool_search",
          { query: "commerce_propose_action", limit: 1 },
          "pi_listing_action_discover",
        );
      case 3:
        return openRouterToolCall(
          "codemode",
          { code: listingReadCode() },
          "pi_listing_read",
        );
      case 4:
        expect(lastListingToolText(body)).toContain('"entities":4');
        return openRouterToolCall(
          "commerce_propose_action",
          { request: listingProposalRequest() },
          "pi_listing_propose",
        );
      case 5:
        expect(lastListingToolText(body)).toContain("commerce_action_proposed");
        return openRouterText(this.proposedReply, "pi_listing_waiting");
      case 6:
        return openRouterToolCall(
          "codemode",
          { code: "text(load('catalog'));" },
          "pi_listing_restored",
        );
      case 7:
        expect(lastListingToolText(body)).toContain('"entities":4');
        expect(JSON.stringify(body.messages)).toContain(
          "commerce_action_proposed",
        );
        return openRouterText("PI_LISTING_RESTORED", "pi_listing_final");
      default:
        throw new Error("Unexpected listing model request");
    }
  }
}

/** One read request for each record of the prepared listing. */
export function listingReadRequests() {
  const requests = [];
  for (const [typeId, entityId] of [
    ["product", PRODUCT],
    ["sellable_variant", VARIANT],
    ["offer", OFFER],
    ["sales_channel", SALES_CHANNEL],
  ]) {
    requests.push({
      selection: {
        kind: "entity_seeds",
        seeds: [{ origin: "system", typeId, entityId }],
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      allowedSensitivity: "internal",
      allowedAttributeIds: [],
      freshnessRequirement: "current_only",
    });
  }
  return requests;
}

export function listingReadCode(): string {
  return `let entities = 0;\nfor (const request of ${JSON.stringify(listingReadRequests())}) {\n  const graph = await tools.commerce_entity_context({ request });\n  if (!graph.ok) throw new Error(graph.error.message);\n  entities += graph.result.entities.length;\n}\nstore('catalog', { entities });\ntext(load('catalog'));`;
}

export function listingProposalRequest() {
  return {
    kind: "publish_catalog_listing",
    productId: commerceCanonicalResourceId(MERCHANT, PRODUCT),
    productRevision: 1,
    variantId: commerceCanonicalResourceId(MERCHANT, VARIANT),
    variantRevision: 1,
    offerId: commerceCanonicalResourceId(MERCHANT, OFFER),
    offerRevision: 1,
    salesChannelId: commerceCanonicalResourceId(MERCHANT, SALES_CHANNEL),
    salesChannelRevision: 1,
    expectedOfferRevision: null,
    expectedPolicyRevision: null,
    proposedPriceMinor: null,
    currency: null,
    resourceId: null,
    expectedRevision: null,
    reason: null,
    refund: null,
    restock: null,
    notifyCustomer: null,
    note: null,
    description: null,
    fulfillmentId: null,
    fulfillmentRevision: null,
    shipmentId: null,
    shipmentRevision: null,
    trackingNumber: null,
  };
}

export function lastListingToolText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages))
    throw new Error("Missing listing messages");
  for (const message of body.messages.toReversed()) {
    if (
      isRecord(message) &&
      message.role === "tool" &&
      typeof message.content === "string"
    )
      return message.content;
  }
  throw new Error("Missing listing tool result");
}

export function listingNonce(
  requests: readonly Record<string, unknown>[],
): string {
  for (const request of requests.toReversed()) {
    const match = lastListingToolText(request).match(/"nonce":"([^"]+)"/u);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error("Missing Pi listing nonce");
}

export async function sendListingMessage(
  kind: "app_mention" | "message",
  eventId: string,
  ts: string,
  text: string,
  threadTs = ROOT_TS,
): Promise<void> {
  const body = slackEnvelope({
    eventType: kind,
    eventId,
    messageTs: ts,
    threadTs,
    text,
  });
  const response = await exports.default.fetch(await signedSlackRequest(body));
  expect(response.status).toBe(200);
}

export async function postControl(
  session: IssuedControlSession,
  suffix: string,
  body: unknown,
  identity: string,
  approvalGrant = "",
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/commerce/actions${suffix}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://localhost",
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}; ${APPROVAL_GRANT_COOKIE}=${approvalGrant}`,
        "x-satyr-csrf": session.csrfToken,
        "idempotency-key": identity,
      },
      body: JSON.stringify(body),
    },
  );
}

export async function effectEvidence(): Promise<unknown> {
  const response = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${MERCHANT}/e2e-evidence`,
    { headers: { authorization: "Bearer underclerk-e2e-token" } },
  );
  return response.json();
}
