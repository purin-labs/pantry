import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect } from "vitest";
import type { OrganisationId, IntegrationAccountId } from "../../src/ids";
import { createAccessGrant } from "../../src/data/access-grants";
import { readCurrentOrganisationPolicySnapshot } from "../../src/policy-snapshot";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import { parseCommerceGraphQuery } from "@purin-labs/commerce-client";

export async function seedPurchasingContext(
  organisationId: OrganisationId,
  userId: string,
  mailboxAccountId: IntegrationAccountId,
): Promise<string> {
  const merchantId = `merchant_mail_purchasing_${crypto.randomUUID()}`;
  const connectionId = `provider_connection_${crypto.randomUUID()}`;
  const accountId = `integration_${crypto.randomUUID()}`;
  const bindingId = `commerce_binding_${crypto.randomUUID()}`;
  const now = Date.now();
  const provision = await env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer commerce-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: "commerce.provision-merchant.v2",
        externalReference: organisationId,
        merchantId,
        createdAt: new Date(now).toISOString(),
      }),
    },
  );
  expect(provision.status, await provision.text()).toBe(200);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO provider_connection (provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation, credential_ref, provider_application, application_credential_generation, asset_grant_revision, lifecycle, granted_scopes, created_by_user_id, created_at, updated_at, disabled_at, revoked_at, environment, provider_subject_id) VALUES (?, ?, 'commerce', 'api_key', 'connection_credential', 1, 'vault:mail:purchasing:e2e', NULL, NULL, NULL, 'active', '[]', ?, ?, ?, NULL, NULL, 'development', '')`,
      )
      .bind(connectionId, organisationId, userId, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO integration_account (integration_account_id, organisation_id, provider_connection_id, provider, provider_account_id, account_kind, display_name, lifecycle, lifecycle_reason_code, capability_set, audience_policy, retention_policy, created_at, updated_at, disabled_by_user_id, disabled_at, revoked_at, environment, is_default_for_provider) VALUES (?, ?, ?, 'commerce', ?, 'merchant', 'Mail purchasing acceptance', 'active', NULL, '[]', '{}', '{}', ?, ?, NULL, NULL, NULL, 'development', 0)`,
      )
      .bind(accountId, organisationId, connectionId, merchantId, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO commerce_merchant_binding (binding_id, organisation_id, integration_account_id, merchant_id, environment, delivery_signing_key_id, delivery_signing_public_key_b64, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'development', 'key_mail_e2e', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, ?, ?)`,
      )
      .bind(bindingId, organisationId, accountId, merchantId, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_commerce_system (organisation_id, system_kind, commerce_binding_id, shopify_integration_account_id, revision, selected_at, selected_by_user_id) VALUES (?, 'builtin_commerce', ?, NULL, 1, ?, ?)`,
      )
      .bind(organisationId, bindingId, now, userId),
  ]);
  const seeded = await purchasingFixture(organisationId, merchantId, "seed");
  expect(seeded.status, await seeded.text()).toBe(200);
  for (const listId of ["supplier_directory", "replenishment_queue"]) {
    const query = parseCommerceGraphQuery({
      kind: "commerce_list_page",
      listId,
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 2, cursor: null },
    });
    if (query.kind !== "commerce_list_page")
      throw new Error("Invalid purchasing list");
    const grant = await createAccessGrant({
      db: fixtureDatabase(),
      organisationId,
      grantId: `grant_mail_${listId}`,
      subject: {
        kind: "agent_mailbox",
        integrationAccountId: mailboxAccountId,
        mailboxBindingId: "binding_work",
        bindingRevision: 1,
      },
      target: {
        kind: "commerce_read",
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
        scope: { kind: "commerce_list", listId: query.listId },
      },
      provenance: {
        kind: "integration_setup",
        integrationAccountId: accountId,
        setupRevision: 1,
        materializationReceiptId: `mail_${listId}`,
      },
      now,
    });
    if (!grant.ok) throw new Error(grant.error.code);
    const operatorGrant = await createAccessGrant({
      db: fixtureDatabase(),
      organisationId,
      grantId: `grant_mail_operator_${listId}`,
      subject: { kind: "organisation_role", role: "owner" },
      target: grant.value.target,
      provenance: {
        kind: "integration_setup",
        integrationAccountId: accountId,
        setupRevision: 1,
        materializationReceiptId: `mail_operator_${listId}`,
      },
      now,
    });
    if (!operatorGrant.ok) throw new Error(operatorGrant.error.code);
  }
  const policy = await readCurrentOrganisationPolicySnapshot(
    fixtureDatabase(),
    organisationId,
  );
  if (!policy.ok) throw new Error("Missing purchasing policy");
  policy.value.authz.allowedTools.push(CAPABILITY_KEYS.commerceEntityRead);
  await fixtureDatabase()
    .prepare(
      "UPDATE policy_snapshot SET body = ? WHERE organisation_id = ? AND version = 1",
    )
    .bind(JSON.stringify(policy.value), organisationId)
    .run();
  await env.POLICY_KV.put(
    `policy:${organisationId}:latest`,
    JSON.stringify(policy.value),
  );
  await env.POLICY_KV.put(
    `policy:${organisationId}:v1`,
    JSON.stringify(policy.value),
  );
  return merchantId;
}
const PURCHASING_SCENARIO = {
  seed: "mail_purchasing",
  ambiguous: "mail_supplier_ambiguous",
  order: "mail_order",
} as const;

export function purchasingFixture(
  organisationId: string,
  merchantId: string,
  kind: "seed" | "ambiguous" | "order",
): Promise<Response> {
  return env.COMMERCE.fetch(
    `http://commerce.test/v1/admin/merchants/${merchantId}/test-fixture`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer commerce-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ organisationId, kind: PURCHASING_SCENARIO[kind] }),
    },
  );
}

/**
 * The customer order of the mail sources journey. The Commerce fixture
 * Worker (scenario mail_order) writes the same identity.
 */
export const MAIL_SOURCE_ORDER_ID = "order_1042";
/** The owner's grant to read orders, which the sources journey revokes. */
export const MAIL_OWNER_ORDER_GRANT = "grant_mail_operator_order";

const ORDER_READ_TARGET = {
  kind: "commerce_read",
  capabilityId: "commerce.entity.read",
  capabilityVersion: 1,
  scope: {
    kind: "entity_type",
    entityTypeId: { origin: "system", typeId: "order" },
  },
} as const;

/**
 * Writes one shop order and lets the mailbox agent and the owner read
 * orders. Seed it before any turn reads commerce: the write moves the
 * merchant's revision.
 */
export async function seedMailOrderAccess(
  organisationId: OrganisationId,
  merchantId: string,
  mailboxAccountId: IntegrationAccountId,
): Promise<void> {
  const seeded = await purchasingFixture(organisationId, merchantId, "order");
  expect(seeded.status, await seeded.text()).toBe(200);
  await grantOrderRead(organisationId, merchantId, "grant_mail_order", {
    kind: "agent_mailbox",
    integrationAccountId: mailboxAccountId,
    mailboxBindingId: "binding_work",
    bindingRevision: 1,
  });
  await grantOwnerOrderRead(organisationId, merchantId, MAIL_OWNER_ORDER_GRANT);
}

/** Gives the owner role a grant to read orders, under the given identity. */
export async function grantOwnerOrderRead(
  organisationId: OrganisationId,
  merchantId: string,
  grantId: string,
): Promise<void> {
  await grantOrderRead(organisationId, merchantId, grantId, {
    kind: "organisation_role",
    role: "owner",
  });
}

/** Gives one subject a grant to read orders, under the given identity. */
export async function grantOrderRead(
  organisationId: OrganisationId,
  merchantId: string,
  grantId: string,
  subject: Parameters<typeof createAccessGrant>[0]["subject"],
): Promise<void> {
  const binding = await fixtureDatabase()
    .prepare(
      "SELECT integration_account_id AS accountId FROM commerce_merchant_binding WHERE organisation_id = ? AND merchant_id = ?",
    )
    .bind(organisationId, merchantId)
    .first<{ accountId: string }>();
  if (binding === null) throw new Error("Missing Commerce binding");
  const grant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId,
    grantId,
    subject,
    target: ORDER_READ_TARGET,
    provenance: {
      kind: "integration_setup",
      integrationAccountId: binding.accountId,
      setupRevision: 1,
      materializationReceiptId: grantId,
    },
    now: Date.now(),
  });
  if (!grant.ok) throw new Error(grant.error.code);
}
