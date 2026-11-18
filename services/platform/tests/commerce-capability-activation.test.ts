import type { SingleDatabase } from "../src/database-handles";
import { describe, expect, it } from "vitest";

import {
  activateCommerceCapability,
  admitCommerceCapability,
  configureCommerceCapability,
  inactivateCommerceCapability,
  parseCapabilityActivationId,
  parseCapabilityContractRevision,
  parseCommerceLocationId,
  requireActiveCommerceCapability,
} from "../src/data/commerce-capability-activation";
import { requireUserId, requireOrganisationId } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";

describe("commerce capability activation", () => {
  it("binds one location capability to the selected authority and fences its lifecycle", async () => {
    const db = createMigratedDatabase();
    const organisationId = requireOrganisationId("organisation_capability_activation");
    const userId = requireUserId(
      "user_7ad54483-627d-560c-bdf3-e0ee920c1ecb",
    );
    const activationId = requireActivationId(
      "capability_activation_food_service_cafe",
    );
    const locationId = requireLocationId("location_cafe_counter");
    const contractRevision = requireContractRevision("food_service.v1");
    await seedActivePantryCommerceOrganisation(db, organisationId, userId);

    const configured = await configureCommerceCapability({
      db,
      activationId,
      organisationId,
      capability: "food_service",
      scope: { kind: "location", locationId },
      contractRevision,
      configuredByUserId: userId,
      now: 20,
    });
    expect(configured).toMatchObject({
      ok: true,
      value: {
        kind: "configured",
        activation: {
          activationId,
          organisationId,
          capability: "food_service",
          scope: { kind: "location", locationId },
          authority: {
            kind: "satyr_commerce",
            integrationAccountId: "integration_underclerk_capability",
            commerceSystemRevision: 1,
          },
          contractRevision,
          revision: 1,
          lifecycle: { state: "configured" },
        },
      },
    });

    await expect(
      configureCommerceCapability({
        db,
        activationId: requireActivationId("capability_activation_replayed_id"),
        organisationId,
        capability: "food_service",
        scope: { kind: "location", locationId },
        contractRevision,
        configuredByUserId: userId,
        now: 21,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "already_configured",
        activation: { activationId },
      },
    });

    await expect(
      configureCommerceCapability({
        db,
        activationId: requireActivationId(
          "capability_activation_conflicting_id",
        ),
        organisationId,
        capability: "food_service",
        scope: { kind: "location", locationId },
        contractRevision: requireContractRevision("food_service.v2"),
        configuredByUserId: userId,
        now: 22,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "capability_activation_conflict" },
    });

    const activated = await activateCommerceCapability({
      db,
      organisationId,
      activationId,
      expectedRevision: 1,
      activatedByUserId: userId,
      now: 30,
    });
    expect(activated).toMatchObject({
      ok: true,
      value: {
        kind: "activated",
        activation: {
          revision: 2,
          lifecycle: {
            state: "active",
            activatedAt: 30,
            activatedByUserId: userId,
          },
        },
      },
    });
    await expect(
      requireActiveCommerceCapability({
        db,
        organisationId,
        capability: "food_service",
        scope: { kind: "location", locationId },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { activationId, revision: 2 },
    });

    const inactivated = await inactivateCommerceCapability({
      db,
      organisationId,
      activationId,
      expectedRevision: 2,
      reason: "seasonal_menu_closed",
      inactivatedByUserId: userId,
      now: 40,
    });
    expect(inactivated).toMatchObject({
      ok: true,
      value: {
        kind: "inactivated",
        activation: {
          revision: 3,
          lifecycle: {
            state: "inactive",
            activatedAt: 30,
            inactivatedAt: 40,
            reason: "seasonal_menu_closed",
          },
        },
      },
    });
    await expect(
      requireActiveCommerceCapability({
        db,
        organisationId,
        capability: "food_service",
        scope: { kind: "location", locationId },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "capability_activation_lifecycle_conflict" },
    });

    const reactivated = await activateCommerceCapability({
      db,
      organisationId,
      activationId,
      expectedRevision: 3,
      activatedByUserId: userId,
      now: 50,
    });
    expect(reactivated).toMatchObject({
      ok: true,
      value: {
        kind: "activated",
        activation: {
          revision: 4,
          lifecycle: { state: "active", activatedAt: 50 },
        },
      },
    });

    await db
      .prepare(
        `UPDATE organisation_commerce_system SET revision = 2 WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .run();
    await expect(
      requireActiveCommerceCapability({
        db,
        organisationId,
        capability: "food_service",
        scope: { kind: "location", locationId },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "capability_activation_authority_mismatch" },
    });
  });

  it("admits core and online commerce implicitly until an explicit row governs them", async () => {
    const db = createMigratedDatabase();
    const organisationId = requireOrganisationId("organisation_capability_admission");
    const userId = requireUserId(
      "user_2e664a43-fe7d-57de-bfe2-f20e390d5b75",
    );
    const coreActivationId = requireActivationId(
      "capability_activation_core_organisation",
    );
    const foodActivationId = requireActivationId(
      "capability_activation_food_service_organisation",
    );
    await seedActivePantryCommerceOrganisation(db, organisationId, userId);
    const admit = (capability: "core" | "online_commerce" | "food_service") =>
      admitCommerceCapability({
        db,
        organisationId,
        capability,
        scope: { kind: "organisation" },
      });

    await expect(admit("core")).resolves.toEqual({
      ok: true,
      value: { kind: "implicit" },
    });
    await expect(admit("online_commerce")).resolves.toEqual({
      ok: true,
      value: { kind: "implicit" },
    });
    await expect(admit("food_service")).resolves.toEqual({
      ok: false,
      error: { code: "capability_activation_not_found" },
    });

    await configureCommerceCapability({
      db,
      activationId: coreActivationId,
      organisationId,
      capability: "core",
      scope: { kind: "organisation" },
      contractRevision: requireContractRevision("core.v1"),
      configuredByUserId: userId,
      now: 20,
    });
    await expect(admit("core")).resolves.toEqual({
      ok: false,
      error: { code: "capability_activation_lifecycle_conflict" },
    });
    await activateCommerceCapability({
      db,
      organisationId,
      activationId: coreActivationId,
      expectedRevision: 1,
      activatedByUserId: userId,
      now: 21,
    });
    await inactivateCommerceCapability({
      db,
      organisationId,
      activationId: coreActivationId,
      expectedRevision: 2,
      reason: "core_paused",
      inactivatedByUserId: userId,
      now: 22,
    });
    await expect(admit("core")).resolves.toEqual({
      ok: false,
      error: { code: "capability_activation_lifecycle_conflict" },
    });

    await configureCommerceCapability({
      db,
      activationId: foodActivationId,
      organisationId,
      capability: "food_service",
      scope: { kind: "organisation" },
      contractRevision: requireContractRevision("food_service.v1"),
      configuredByUserId: userId,
      now: 30,
    });
    await activateCommerceCapability({
      db,
      organisationId,
      activationId: foodActivationId,
      expectedRevision: 1,
      activatedByUserId: userId,
      now: 31,
    });
    await expect(admit("food_service")).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "activated",
        activation: { activationId: foodActivationId },
      },
    });

    await db
      .prepare(
        `UPDATE organisation_commerce_system SET revision = 2 WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .run();
    await expect(admit("food_service")).resolves.toEqual({
      ok: false,
      error: { code: "capability_activation_authority_mismatch" },
    });
  });
});

async function seedActivePantryCommerceOrganisation(
  db: SingleDatabase,
  organisationId: ReturnType<typeof requireOrganisationId>,
  userId: ReturnType<typeof requireUserId>,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
       VALUES (?, 'Capability organisation', 'beta', 1, 'active')`,
      )
      .bind(organisationId),
    db
      .prepare(
        `INSERT INTO person (organisation_id, person_id, display_name)
       VALUES (?, 'person_capability_owner', 'Capability Owner')`,
      )
      .bind(organisationId),
    db
      .prepare(
        `INSERT INTO app_user (
         user_id, issuer, subject, email, display_name,
         email_verified, created_at, last_authenticated_at
       ) VALUES (?, 'https://accounts.google.com', ?, ?, 'Capability Owner', 1, 1, 1)`,
      )
      .bind(
        userId,
        userId,
        `${userId}@test.invalid`,
      ),
    db
      .prepare(
        `INSERT INTO service_role_grant (
         organisation_id, user_id, person_id, role, status, created_at
       ) VALUES (?, ?, 'person_capability_owner', 'owner', 'active', 1)`,
      )
      .bind(organisationId, userId),
    db
      .prepare(
        `INSERT INTO organisation_onboarding (
         organisation_id, environment, lifecycle, capability_profile,
         configuration_version, projection_revision,
         activation_receipt_id, activated_at, updated_at
       ) VALUES (
         ?, 'development', 'active', 'read_and_propose',
         1, 1, 'activation_capability_test', 1, 1
       )`,
      )
      .bind(organisationId),
    db
      .prepare(
        `INSERT INTO underclerk_merchant_binding (
         binding_id, organisation_id, integration_account_id, merchant_id, environment,
         delivery_signing_key_id, delivery_signing_public_key_b64,
         revision, created_at, updated_at
       ) VALUES (
         'underclerk_binding_capability', ?, 'integration_underclerk_capability',
         'merchant_capability', 'development', 'key_capability',
         'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, 1, 1
       )`,
      )
      .bind(organisationId),
    db
      .prepare(
        `INSERT INTO organisation_commerce_system (
         organisation_id, system_kind, underclerk_binding_id,
         shopify_integration_account_id, revision, selected_at,
         selected_by_user_id
       ) VALUES (
         ?, 'satyr_commerce', 'underclerk_binding_capability',
         NULL, 1, 1, ?
       )`,
      )
      .bind(organisationId, userId),
  ]);
}

function requireActivationId(value: string) {
  const parsed = parseCapabilityActivationId(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requireContractRevision(value: string) {
  const parsed = parseCapabilityContractRevision(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function requireLocationId(value: string) {
  const parsed = parseCommerceLocationId(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}
