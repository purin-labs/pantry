import { runInDurableObject } from "cloudflare:test";
import { fixtureDatabase } from "./organisation-database";
import { env } from "cloudflare:workers";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { commerceCanonicalResourceId } from "@purin-labs/area-commerce-contract/server/resource-ids";
import { connectCommerceFixture } from "./commerce-support";

/**
 * Pantry Commerce with one product, as a connected shop has it: the Commerce
 * merchant, the Organisation's commerce system and the product's projection.
 * No grant reads its records.
 */
export async function installProductSource(
  input: Readonly<{
    organisationId: OrganisationId;
    ownerUserId: string;
    merchantId: string;
    productId: string;
    description: string;
  }>,
): Promise<void> {
  await connectCommerceFixture(
    input.organisationId,
    input.ownerUserId,
    input.merchantId,
  );
  const binding = await fixtureDatabase()
    .prepare(
      "SELECT integration_account_id AS accountId FROM commerce_merchant_binding WHERE organisation_id = ?",
    )
    .bind(input.organisationId)
    .first<{ readonly accountId: string }>();
  if (binding === null) throw new Error("Commerce binding missing");
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: input.organisationId,
    now: Date.now(),
  });
  await runInDurableObject(
    organisation,
    seedProductProjection.bind(null, input, binding.accountId),
  );
}

function seedProductProjection(
  input: Parameters<typeof installProductSource>[0],
  integrationAccountId: string,
  _actor: unknown,
  state: DurableObjectState,
): void {
  const canonicalId = commerceCanonicalResourceId(
    input.merchantId,
    input.productId,
  );
  const occurredAt = new Date(Date.now() - 1_000).toISOString();
  const projection = {
    kind: "product",
    projection: {
      provenance: {
        organisationId: input.organisationId,
        integrationAccountId,
        source: "commerce",
        resourceType: "product",
        resourceId: canonicalId,
        revision: 1,
        occurredAt,
        observedAt: occurredAt,
      },
      title: "E2E Croissant",
      description: input.description,
    },
  };
  state.storage.sql.exec(
    `INSERT INTO commerce_projection (
       organisation_id, projection_kind, canonical_id, integration_account_id,
       revision, lifecycle, projection_json, updated_at, validated_at, lab_run_id
     ) VALUES (?, 'product', ?, ?, 1, 'active', ?, ?, ?, NULL)`,
    input.organisationId,
    canonicalId,
    integrationAccountId,
    JSON.stringify(projection),
    Date.now(),
    Date.now(),
  );
  state.storage.sql.exec(
    `INSERT INTO commerce_projection_relation_text (
       organisation_id, projection_kind, canonical_id, integration_account_id,
       display_name_folded, search_text_folded
     ) VALUES (?, 'product', ?, ?, 'e2e croissant', 'e2e croissant')`,
    input.organisationId,
    canonicalId,
    integrationAccountId,
  );
}
