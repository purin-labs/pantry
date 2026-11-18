import { expect, it } from "vitest";

import {
  bindCommerceMerchant,
  resolveCurrentOrganisationCommerceMerchantBinding,
  resolveCommerceMerchantBinding,
} from "../src/data/commerce-merchant-binding";
import { parseIntegrationAccountId, parseOrganisationId } from "../src/ids";
import { requireIntegrationAccountId } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";

it("binds one Satyr organisation and integration identity to one active Underclerk merchant", async () => {
  const db = createMigratedDatabase();
  const organisationId = parseOrganisationId("organisation_underclerk_binding");
  const integrationAccountId = parseIntegrationAccountId(
    "integration_underclerk_binding",
  );
  if (!organisationId.ok || !integrationAccountId.ok)
    throw new Error("Invalid binding fixture");
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'Underclerk', 'beta', 1, 'active')",
    )
    .bind(organisationId.value)
    .run();
  await db
    .prepare(
      `INSERT INTO organisation_onboarding (
       organisation_id, environment, lifecycle, capability_profile,
       configuration_version, projection_revision, updated_at
     ) VALUES (?, 'development', 'configuring', 'read_and_propose', 1, 1, 1)`,
    )
    .bind(organisationId.value)
    .run();
  const bound = await bindCommerceMerchant({
    db,
    bindingId: "underclerk_binding_demo",
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    merchantId: "merchant_demo",
    environment: "development",
    deliverySigningKeyId: "key_underclerk_demo",
    deliverySigningPublicKey: new Uint8Array(32).fill(7),
    now: 100,
  });
  expect(bound).toMatchObject({
    ok: true,
    value: {
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      merchantId: "merchant_demo",
      revision: 1,
    },
  });
  expect(
    await resolveCommerceMerchantBinding({
      db,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
    }),
  ).toEqual(bound);
  expect(
    await resolveCurrentOrganisationCommerceMerchantBinding({
      db,
      organisationId: organisationId.value,
    }),
  ).toEqual(bound);
  expect(
    await bindCommerceMerchant({
      db,
      bindingId: "underclerk_binding_demo",
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      merchantId: "merchant_demo",
      environment: "development",
      deliverySigningKeyId: "key_underclerk_demo",
      deliverySigningPublicKey: new Uint8Array(32).fill(7),
      now: 101,
    }),
  ).toEqual(bound);
  expect(
    await bindCommerceMerchant({
      db,
      bindingId: "underclerk_binding_second",
      organisationId: organisationId.value,
      integrationAccountId: requireIntegrationAccountId(
        "integration_underclerk_second",
      ),
      merchantId: "merchant_second",
      environment: "development",
      deliverySigningKeyId: "key_underclerk_second",
      deliverySigningPublicKey: new Uint8Array(32).fill(9),
      now: 101,
    }),
  ).toEqual({ ok: false, error: { code: "underclerk_binding_conflict" } });
});
