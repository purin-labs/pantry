import { CommerceAdminClient } from "@purin-labs/commerce-client";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import {
  createAccessGrant,
  readAccessGrant,
  type CreateAccessGrantInput,
} from "../../src/data/access-grants";
import {
  readOrganisationCapabilityPolicies,
  writeOrganisationCapabilityPolicy,
} from "../../src/data/capability-policy";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

export async function seedMerchantFixture(
  env: Env,
  identity: {
    readonly organisationId: OrganisationId;
    readonly userId: UserId;
    readonly role: "admin" | "owner";
  },
): Promise<void> {
  if (!env.COMMERCE_SERVICE_TOKEN || !env.COMMERCE_BASE_URL)
    throw new Error("merchant_fixture_binding_missing");
  const merchantId = `merchant_${identity.organisationId}`;
  const client = new CommerceAdminClient({
    baseUrl: env.COMMERCE_BASE_URL,
    serviceToken: env.COMMERCE_SERVICE_TOKEN,
    fetch: env.COMMERCE.fetch.bind(env.COMMERCE),
  });
  const occurredAt = "2026-10-05T00:00:00.000Z";
  const provisioned = await client.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: identity.organisationId,
    merchantId,
    createdAt: occurredAt,
  });
  if (!provisioned.ok) throw new Error("merchant_fixture_provision_failed");
  const prepared = await client.prepareCatalogListing({
    merchantId,
    expectedMerchantRevision: 0,
    idempotencyKey: "plan55-cookie-catalog-v1",
    salesChannel: {
      id: "channel_plan55_online",
      revision: 1,
      name: "Online",
      kind: "online",
      lifecycle: { state: "active", activeAt: occurredAt },
      occurredAt,
    },
    product: {
      id: "product_plan55_cookies",
      revision: 1,
      title: "Cookie box",
      description: "Six assorted cookies.",
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active" as const,
      occurredAt,
    },
    variant: {
      id: "variant_plan55_cookies",
      revision: 1,
      productId: "product_plan55_cookies",
      sku: "P55-COOKIES",
      title: "Six cookies",
      options: [],
      media: [],
      barcode: null,
      status: "active" as const,
      occurredAt,
    },
    offer: {
      id: "offer_plan55_cookies",
      revision: 1,
      variantId: "variant_plan55_cookies",
      salesChannelId: "channel_plan55_online",
      price: { amountMinor: 2400, currency: "JPY" },
      compareAtPrice: null,
      availability: { state: "available" },
      lifecycle: { state: "prepared", preparedAt: occurredAt },
      occurredAt,
    },
    consumptionPlan: {
      consumptionPlanId: "plan_plan55_cookies",
      variantId: "variant_plan55_cookies",
      revision: 1,
      scope: { kind: "organisation" },
      mode: { kind: "untracked" },
      lifecycle: "active",
    },
  });
  if (!prepared.ok) throw new Error("merchant_fixture_catalog_failed");
  const snapshot = await client.readSnapshot(merchantId);
  if (!snapshot.ok || snapshot.value.merchantId !== merchantId)
    throw new Error("merchant_fixture_snapshot_failed");
  const scope = await OrganisationExecutionScope.resolve(
    env,
    identity.organisationId,
  );
  if (!scope.ok) throw new Error(scope.error.code);
  const now = Date.now();
  const bindingId = `commerce_binding_${identity.organisationId}`;
  await scope.value.database.batch([
    scope.value.database
      .prepare(
        `INSERT INTO commerce_merchant_binding
       (binding_id, organisation_id, integration_account_id, merchant_id, environment,
        delivery_signing_key_id, delivery_signing_public_key_b64, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'development', ?, ?, 1, ?, ?)
       ON CONFLICT (binding_id) DO NOTHING`,
      )
      .bind(
        bindingId,
        identity.organisationId,
        `integration_${identity.organisationId}`,
        merchantId,
        snapshot.value.deliverySigner.keyId,
        snapshot.value.deliverySigner.publicKeyB64,
        now,
        now,
      ),
    scope.value.database
      .prepare(
        `INSERT INTO organisation_commerce_system
       (organisation_id, system_kind, commerce_binding_id, shopify_integration_account_id,
        revision, selected_at, selected_by_user_id)
       VALUES (?, 'builtin_commerce', ?, NULL, 1, ?, ?)
       ON CONFLICT (organisation_id) DO NOTHING`,
      )
      .bind(identity.organisationId, bindingId, now, identity.userId),
  ]);
  const policies = await readOrganisationCapabilityPolicies({
    db: scope.value.database,
    organisationId: identity.organisationId,
  });
  if (!policies.ok) throw new Error(policies.error.code);
  for (const capabilityId of [
    "commerce.entity_plane.context",
    "commerce.entity.read",
  ] as const) {
    let revision: number | null = null;
    let alreadyEnabled = false;
    for (const policy of policies.value) {
      if (policy.capabilityId !== capabilityId) continue;
      revision = policy.revision;
      alreadyEnabled = policy.mode === "enabled";
    }
    if (alreadyEnabled) continue;
    if (revision === null) throw new Error("merchant_fixture_policy_missing");
    const enabled = await writeOrganisationCapabilityPolicy({
      scope: scope.value,
      write: {
        kind: "change",
        capabilityId,
        expectedRevision: revision,
        mode: "enabled",
        provenance: {
          kind: "operator",
          userId: identity.userId,
          mutationReceiptId: `p55_${capabilityId}`,
        },
        now,
      },
    });
    if (!enabled.ok) throw new Error(enabled.error.code);
  }
  const contextGrant = await ensureFixtureGrant({
    db: scope.value.database,
    organisationId: identity.organisationId,
    grantId: `grant_${identity.organisationId}_commerce_context`,
    subject: { kind: "organisation_role", role: identity.role },
    target: {
      kind: "platform_capability",
      capabilityId: "commerce.entity_plane.context",
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "p55_merchant",
    },
    now,
  });
  if (!contextGrant.ok) throw new Error(contextGrant.error.code);
  const readGrant = await ensureFixtureGrant({
    db: scope.value.database,
    organisationId: identity.organisationId,
    grantId: `grant_${identity.organisationId}_products`,
    subject: { kind: "organisation_role", role: identity.role },
    target: {
      kind: "commerce_read",
      capabilityId: "commerce.entity.read",
      capabilityVersion: 1,
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: "product" },
      },
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "p55_merchant",
    },
    now,
  });
  if (!readGrant.ok) throw new Error(readGrant.error.code);
}

async function ensureFixtureGrant(input: CreateAccessGrantInput) {
  const existing = await readAccessGrant(input);
  if (existing.ok) {
    if (existing.value.lifecycle.kind !== "active")
      throw new Error("merchant_fixture_grant_inactive");
    return existing;
  }
  if (existing.error.code !== "access_grant_not_found") return existing;
  return createAccessGrant(input);
}
