import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import {
  parseRecipeCollection,
  type RecipeCollection,
  type RecipeWrite,
} from "@purin-labs/control-api";
import {
  CommerceAdminClient,
  type CommerceStockSnapshot,
} from "@purin-labs/commerce-client";
import {
  commerceClient,
  commerceWorkspace,
  commerceHeaders,
  connectCommerceFixture,
} from "./commerce-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";

it(
  "creates and revises recipes, rejects stale edits and protects the library",
  { timeout: 180000 },
  recipeJourney,
);

async function recipeJourney(context: TestContext): Promise<void> {
  const owner = await commerceClient(`recipes-owner-${crypto.randomUUID()}`);
  const foreign = await commerceClient(
    `recipes-foreign-${crypto.randomUUID()}`,
  );
  const viewer = await commerceClient(`recipes-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(
    owner,
    "Recipe library acceptance",
  );
  const merchantId = `merchant_recipes_${crypto.randomUUID()}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'recipe_viewer', 'Viewer')",
      )
      .bind(organisationId),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, 'recipe_viewer', 'viewer', 'active', ?, NULL)",
      )
      .bind(organisationId, viewer.identity.userId, Date.now()),
  ]);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { privateMember: viewer },
  });
  const native = new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  const seeded = await native.provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(seeded.ok).toBe(true);
  const journey = new RecipeJourney(organisationId, owner.session);
  const initial = await journey.read();
  const source = initial.recipes.find(stockedRecipe);
  if (source === undefined || source.output.kind !== "stocked")
    throw new Error("Stocked recipe fixture missing");
  const created: RecipeWrite = {
    kind: "create",
    merchantRevision: initial.merchantRevision,
    requestedAt: new Date().toISOString(),
    recipe: {
      recipeId: "recipe_acceptance",
      name: "Acceptance financiers",
      inputs: source.inputs,
      output: source.output,
    },
  };
  const key = crypto.randomUUID();
  const accepted = await journey.send(created, key);
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  expect(await (await journey.send(created, key)).json()).toEqual(
    await accepted.json(),
  );
  await fixtureDatabase()
    .prepare(
      "DELETE FROM control_mutation_receipt WHERE organisation_scope = ? AND idempotency_key = ?",
    )
    .bind(organisationId, key)
    .run();
  const recovered = await journey.send(created, key);
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  const afterCreate = await journey.read();
  expect(afterCreate.recipes.find(acceptanceRecipe)).toMatchObject({
    name: "Acceptance financiers",
    revision: 1,
  });
  const edited: RecipeWrite = {
    kind: "edit",
    merchantRevision: afterCreate.merchantRevision,
    expectedRecipeRevision: 1,
    requestedAt: new Date().toISOString(),
    recipe: {
      recipeId: "recipe_acceptance",
      name: "Acceptance financiers — revised",
      inputs: source.inputs,
      output: { kind: "immediate" },
    },
  };
  expect((await journey.send(edited)).status).toBe(200);
  expect((await journey.send(edited)).status).toBe(409);
  const final = await journey.read();
  expect(final.recipes.filter(acceptanceRecipe)).toHaveLength(1);
  expect(final.recipes.find(acceptanceRecipe)).toMatchObject({
    revision: 2,
    name: "Acceptance financiers — revised",
    output: { kind: "immediate" },
  });
  const invalid = {
    kind: "create",
    merchantRevision: final.merchantRevision,
    requestedAt: new Date().toISOString(),
    recipe: {
      recipeId: "recipe_invalid",
      name: "Invalid duplicate",
      inputs: [source.inputs[0], source.inputs[0]],
      output: { kind: "immediate" },
    },
  };
  expect((await journey.send(invalid)).status).toBe(422);
  const viewerJourney = new RecipeJourney(organisationId, viewer.session);
  expect(
    (await viewerJourney.read()).recipes.find(acceptanceRecipe)?.revision,
  ).toBe(2);
  expect([403, 404]).toContain((await viewerJourney.send(edited)).status);
  const denied = await new RecipeJourney(
    organisationId,
    foreign.session,
  ).send();
  expect([403, 404]).toContain(denied.status);
  expect((await journey.read()).merchantRevision).toBe(final.merchantRevision);
  // Receive fresh ingredients through the same authority as a delivery.
  for (const input of source.inputs) {
    const currentStock = await native.readStockSnapshot(merchantId);
    if (!currentStock.ok) throw new Error("Ingredient stock unavailable");
    const inputPosition =
      currentStock.value.commerce.resources.inventoryPositions.find(
        positionForItem.bind(null, input.inventoryItemId),
      );
    const item = currentStock.value.commerce.resources.inventoryItems.find(
      itemIdentity.bind(null, input.inventoryItemId),
    );
    if (inputPosition === undefined || item === undefined)
      throw new Error("Ingredient fixture missing");
    const receipt = await native.receiveInventory({
      merchantId,
      expectedMerchantRevision: currentStock.value.commerce.merchantRevision,
      idempotencyKey: `fresh:${item.id}`,
      purchase: { kind: "unlinked" },
      receiptId: `fresh:${item.id}`,
      receiptLineId: `fresh-line:${item.id}`,
      inventoryItemId: item.id,
      inventoryItemRevision: item.revision,
      inventoryPositionId: inputPosition.id,
      inventoryPositionRevision: inputPosition.revision,
      locationId: inputPosition.locationId,
      receivedQuantity: input.quantity,
      lot: {
        kind: "tracked",
        lotId: `fresh-lot:${item.id}`,
        lotCode: `FRESH-${item.id}`,
        expiry: {
          kind: "expires",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      },
      receivedAt: new Date().toISOString(),
    });
    expect(receipt, JSON.stringify(receipt)).toMatchObject({
      ok: true,
      value: { outcome: "applied" },
    });
  }
  const stock = await native.readStockSnapshot(merchantId);
  if (!stock.ok) throw new Error("Stock snapshot unavailable");
  const position = stock.value.commerce.resources.inventoryPositions.find(
    positionForItem.bind(null, source.output.inventoryItemId),
  );
  if (position === undefined) throw new Error("Output stock position missing");
  const batch = await native.completeProductionBatch({
    merchantId,
    expectedMerchantRevision: stock.value.commerce.merchantRevision,
    idempotencyKey: "recipe-pinned-batch",
    productionBatchId: "recipe_pinned_batch",
    demand: { kind: "stock" },
    outputLotId: "recipe_pinned_lot",
    outputInventoryPositionId: position.id,
    recipeId: "recipe_acceptance",
    recipeRevision: 1,
    stationId: "station_bakery",
    locationId: position.locationId,
    plannedYield: source.output.yieldQuantity,
    actualYield: source.output.yieldQuantity,
    outputLotCode: "RECIPE-ACCEPTANCE",
    outputExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    expectedInputPositionRevisions: source.inputs.map(
      inputPositionRevision.bind(null, stock.value),
    ),
    expectedOutputPositionRevision: position.revision,
  });
  expect(batch, JSON.stringify(batch)).toMatchObject({
    ok: true,
    value: { outcome: "applied" },
  });
  const produced = await native.readStockSnapshot(merchantId);
  if (!produced.ok) throw new Error("Produced stock unavailable");
  expect(produced.value.foodService.resources.productionBatches).toContainEqual(
    expect.objectContaining({
      recipeId: "recipe_acceptance",
      recipeRevision: 1,
    }),
  );
  Object.assign(context.task.meta, {
    recipeLibraryEvidence: {
      collection: final,
      checks: [
        "create",
        "edit",
        "same-key replay",
        "lost Portal receipt recovered",
        "production uses pinned recipe after edit",
        "stale edit rejected",
        "duplicate ingredient rejected",
        "viewer read",
        "viewer write denied",
        "foreign read denied",
      ],
    },
  });
}
function stockedRecipe(recipe: RecipeCollection["recipes"][number]): boolean {
  return recipe.output.kind === "stocked";
}
function acceptanceRecipe(
  recipe: RecipeCollection["recipes"][number],
): boolean {
  return recipe.recipeId === "recipe_acceptance";
}
class RecipeJourney {
  constructor(
    readonly organisationId: string,
    readonly session: Awaited<ReturnType<typeof commerceClient>>["session"],
  ) {}
  async send(body?: unknown, key = crypto.randomUUID()): Promise<Response> {
    const headers = commerceHeaders(this.session);
    headers.set("idempotency-key", key);
    return exports.default.fetch(
      `https://localhost/v1/control/organisations/${this.organisationId}/commerce/recipes`,
      {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  }
  async read(): Promise<RecipeCollection> {
    const response = await this.send();
    expect(response.status, await response.clone().text()).toBe(200);
    return parseRecipeCollection(await response.json());
  }
}

function positionForItem(
  itemId: string,
  position: CommerceStockSnapshot["commerce"]["resources"]["inventoryPositions"][number],
): boolean {
  return position.inventoryItemId === itemId;
}
function inputPositionRevision(
  snapshot: CommerceStockSnapshot,
  input: RecipeCollection["recipes"][number]["inputs"][number],
): { inventoryPositionId: string; revision: number } {
  const position = snapshot.commerce.resources.inventoryPositions.find(
    positionForItem.bind(null, input.inventoryItemId),
  );
  if (position === undefined) throw new Error("Input stock position missing");
  return { inventoryPositionId: position.id, revision: position.revision };
}

function itemIdentity(
  id: string,
  item: CommerceStockSnapshot["commerce"]["resources"]["inventoryItems"][number],
): boolean {
  return item.id === id;
}
