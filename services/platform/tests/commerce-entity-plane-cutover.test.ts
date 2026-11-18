import { expect, it } from "vitest";

import {
  ensureEntityPlaneCommerceMerchantBinding,
  resolveOrganisationCommerceMerchantBinding,
} from "../src/data/commerce-merchant-binding";
import { requireIntegrationAccountId, requireOrganisationId } from "./test-ids";
import { createMigratedDatabase } from "./sqlite-d1";

it("provisions one entity-plane merchant binding and reuses it", async () => {
  const db = createMigratedDatabase();
  const organisationId = requireOrganisationId(
    "organisation_entity_plane_binding",
  );
  const integrationAccountId = requireIntegrationAccountId(
    "integration_entity_plane_binding",
  );
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, name, plan, created_at, status) VALUES (?, 'Entity Plane', 'beta', 1, 'active')",
    )
    .bind(organisationId)
    .run();

  let provisions = 0;
  const input = {
    db,
    organisationId,
    environment: "development" as const,
    bindingId: "underclerk_binding_entity_plane",
    integrationAccountId,
    merchantId: "merchant_entity_plane",
    deliverySigningKeyId: "key_entity_plane",
    deliverySigningPublicKey: new Uint8Array(32).fill(8),
    now: 10,
    provision: async () => {
      provisions += 1;
      return true;
    },
  };
  const first = await ensureEntityPlaneCommerceMerchantBinding(input);
  const second = await ensureEntityPlaneCommerceMerchantBinding(input);

  expect(first).toMatchObject({
    ok: true,
    value: { merchantId: "merchant_entity_plane" },
  });
  expect(second).toEqual(first);
  expect(provisions).toBe(1);
  expect(
    await resolveOrganisationCommerceMerchantBinding({
      db,
      organisationId,
      environment: "development",
    }),
  ).toEqual(first);
});
