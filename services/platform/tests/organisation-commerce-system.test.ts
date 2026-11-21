import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bindCommerceMerchant } from "../src/data/commerce-merchant-binding";
import {
  resolveOrganisationCommerceSystem,
  selectOrganisationCommerceSystem,
} from "../src/data/organisation-commerce-system";
import { d1Database } from "./sqlite-d1";
import {
  requireUserId,
  requireIntegrationAccountId,
  requireOrganisationId,
} from "./test-ids";

describe("organisation commerce system", () => {
  it("selects one Seams Checkout binding and replays the same selection", async () => {
    const db = createDatabase();
    const organisationId = requireOrganisationId("organisation_commerce_system");
    const userId = requireUserId(
      "user_750a8a95-1835-5f02-879b-102426a62ea3",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_commerce_system",
    );
    await seedConfiguringOrganisation(db, organisationId, userId);
    const binding = await bindCommerceMerchant({
      db,
      bindingId: "commerce_binding_system",
      organisationId,
      integrationAccountId,
      merchantId: "merchant_system",
      environment: "development",
      deliverySigningKeyId: "key_commerce_system",
      deliverySigningPublicKey: new Uint8Array(32).fill(4),
      now: 10,
    });
    if (!binding.ok) throw new Error(binding.error.code);

    const selected = await selectOrganisationCommerceSystem({
      db,
      organisationId,
      selectedByUserId: userId,
      selection: {
        kind: "select_builtin_commerce",
        expectedRevision: 0,
        commerceBindingId: binding.value.bindingId,
      },
      now: 20,
    });
    expect(selected).toMatchObject({
      ok: true,
      value: {
        kind: "selected",
        commerceSystem: {
          kind: "builtin_commerce",
          organisationId,
          bindingId: binding.value.bindingId,
          merchantId: binding.value.merchantId,
          revision: 1,
        },
      },
    });
    await expect(
      resolveOrganisationCommerceSystem({ db, organisationId }),
    ).resolves.toEqual(
      selected.ok
        ? { ok: true, value: selected.value.commerceSystem }
        : selected,
    );
    await expect(
      selectOrganisationCommerceSystem({
        db,
        organisationId,
        selectedByUserId: userId,
        selection: {
          kind: "select_builtin_commerce",
          expectedRevision: 1,
          commerceBindingId: binding.value.bindingId,
        },
        now: 21,
      }),
    ).resolves.toMatchObject({ ok: true, value: { kind: "already_selected" } });
  });

  it("rejects invalid persisted union branches and active authority changes", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const db = createDatabase(sqlite);
    const organisationId = requireOrganisationId("organisation_commerce_invalid");
    const userId = requireUserId(
      "user_954b0a36-9058-5dba-9d44-98c1d5a70775",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_commerce_invalid",
    );
    await seedConfiguringOrganisation(db, organisationId, userId);
    const binding = await bindCommerceMerchant({
      db,
      bindingId: "commerce_binding_invalid",
      organisationId,
      integrationAccountId,
      merchantId: "merchant_invalid",
      environment: "development",
      deliverySigningKeyId: "key_commerce_invalid",
      deliverySigningPublicKey: new Uint8Array(32).fill(5),
      now: 10,
    });
    if (!binding.ok) throw new Error(binding.error.code);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO organisation_commerce_system (
         organisation_id, system_kind, commerce_binding_id,
         shopify_integration_account_id, revision, selected_at,
         selected_by_user_id
       ) VALUES (?, 'builtin_commerce', ?, ?, 1, 20, ?)`,
        )
        .run(
          organisationId,
          binding.value.bindingId,
          integrationAccountId,
          userId,
        ),
    ).toThrow();
    const selected = await selectOrganisationCommerceSystem({
      db,
      organisationId,
      selectedByUserId: userId,
      selection: {
        kind: "select_builtin_commerce",
        expectedRevision: 0,
        commerceBindingId: binding.value.bindingId,
      },
      now: 20,
    });
    if (!selected.ok) throw new Error(selected.error.code);
    const shopifyAccountId = requireIntegrationAccountId(
      "integration_shopify_switch",
    );
    await db.batch([
      db
        .prepare(
          `INSERT INTO provider_connection (
           provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
           credential_generation, credential_ref, lifecycle, granted_scopes,
           created_by_user_id, created_at, updated_at,
           environment, provider_subject_id
         ) VALUES (
           'provider_connection_shopify_switch', ?, 'shopify', 'shared_pantry_app', 'connection_credential',
           1, 'vault:shopify:switch', 'active', '[]', ?, 20, 20,
           'development', 'switch.myshopify.com'
         )`,
        )
        .bind(organisationId, userId),
      db
        .prepare(
          `INSERT INTO integration_account (
           integration_account_id, organisation_id, provider_connection_id, provider,
           provider_account_id, account_kind, display_name, lifecycle,
           lifecycle_reason_code, capability_set, audience_policy,
           retention_policy, created_at, updated_at, environment, is_default_for_provider
         ) VALUES (
           ?, ?, 'provider_connection_shopify_switch', 'shopify',
           'switch.myshopify.com', 'shop', 'Switch shop', 'active',
           NULL, '[]', '{}', '{}', 20, 20, 'development', 1
         )`,
        )
        .bind(shopifyAccountId, organisationId),
      db
        .prepare(
          `UPDATE organisation_onboarding
       SET lifecycle = 'active', readiness_version = NULL,
           activation_attempt_id = NULL,
           activation_receipt_id = 'activation_receipt_test', activated_at = 30
       WHERE organisation_id = ?`,
        )
        .bind(organisationId),
    ]);
    await expect(
      selectOrganisationCommerceSystem({
        db,
        organisationId,
        selectedByUserId: userId,
        selection: {
          kind: "select_shopify",
          expectedRevision: 1,
          integrationAccountId: shopifyAccountId,
        },
        now: 31,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "commerce_system_switch_requires_migration" },
    });
  });

  it("stops resolving Shopify after the selected account becomes inactive", async () => {
    const db = createDatabase();
    const organisationId = requireOrganisationId("organisation_commerce_shopify_health");
    const userId = requireUserId(
      "user_42034f77-84d0-5f67-931b-a2d586c17460",
    );
    const integrationAccountId = requireIntegrationAccountId(
      "integration_shopify_health",
    );
    await seedConfiguringOrganisation(db, organisationId, userId);
    await db.batch([
      db
        .prepare(
          `INSERT INTO provider_connection (
           provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
           credential_generation, credential_ref, lifecycle, granted_scopes,
           created_by_user_id, created_at, updated_at,
           environment, provider_subject_id
         ) VALUES (
           'provider_connection_shopify_health', ?, 'shopify', 'shared_pantry_app', 'connection_credential',
           1, 'vault:shopify:health', 'active', '[]', ?, 10, 10,
           'development', 'health.myshopify.com'
         )`,
        )
        .bind(organisationId, userId),
      db
        .prepare(
          `INSERT INTO integration_account (
           integration_account_id, organisation_id, provider_connection_id, provider,
           provider_account_id, account_kind, display_name, lifecycle,
           lifecycle_reason_code, capability_set, audience_policy,
           retention_policy, created_at, updated_at, environment, is_default_for_provider
         ) VALUES (
           ?, ?, 'provider_connection_shopify_health', 'shopify',
           'health.myshopify.com', 'shop', 'Health shop', 'active',
           NULL, '[]', '{}', '{}', 10, 10, 'development', 1
         )`,
        )
        .bind(integrationAccountId, organisationId),
    ]);
    const selected = await selectOrganisationCommerceSystem({
      db,
      organisationId,
      selectedByUserId: userId,
      selection: {
        kind: "select_shopify",
        expectedRevision: 0,
        integrationAccountId,
      },
      now: 20,
    });
    expect(selected).toMatchObject({
      ok: true,
      value: { commerceSystem: { kind: "shopify" } },
    });

    await db
      .prepare(
        `UPDATE integration_account
       SET lifecycle = 'disabled', disabled_by_user_id = ?, disabled_at = 30
       WHERE integration_account_id = ?`,
      )
      .bind(userId, integrationAccountId)
      .run();

    await expect(
      resolveOrganisationCommerceSystem({ db, organisationId }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "commerce_system_invalid", field: "row" },
    });
  });
});

async function seedConfiguringOrganisation(
  db: SingleDatabase,
  organisationId: ReturnType<typeof requireOrganisationId>,
  userId: ReturnType<typeof requireUserId>,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
       VALUES (?, 'Commerce system', 'beta', 1, 'active')`,
      )
      .bind(organisationId),
    db
      .prepare(
        `INSERT INTO app_user (
         user_id, issuer, subject, email, display_name,
         email_verified, created_at, last_authenticated_at
       ) VALUES (?, 'https://accounts.google.com', ?, ?, 'Owner', 1, 1, 1)`,
      )
      .bind(
        userId,
        userId,
        `${userId}@test.invalid`,
      ),
    db
      .prepare(
        `INSERT INTO organisation_onboarding (
         organisation_id, environment, lifecycle, capability_profile,
         configuration_version, projection_revision, updated_at
       ) VALUES (?, 'development', 'configuring', 'read_and_propose', 1, 1, 1)`,
      )
      .bind(organisationId),
  ]);
}

function createDatabase(
  sqlite: DatabaseSync = new DatabaseSync(":memory:"),
): SingleDatabase {
  sqlite.exec(singleDatabaseSchema());
  return d1Database(sqlite);
}
