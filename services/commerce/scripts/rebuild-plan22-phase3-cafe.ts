import {
  CommerceAdminClient,
  type CommerceFoodServiceSnapshotV1,
  type CommerceMerchantSnapshotV1,
} from "@purin-labs/commerce-client";
import {
  clientFailure,
  isMainModule,
  parseMerchantScriptArguments,
  type MerchantScriptArguments,
} from "./merchant-script.ts";

const OCCURRED_AT = "2026-08-14T09:30:00.000Z";
const CAFE_EXPANSION_OFFER_IDS = [
  "offer_ginger_milk_tea_cafe",
  "offer_ginger_cookie_cafe",
  "offer_ginger_financier_cafe",
  "offer_taro_milk_tea_cafe",
  "offer_taro_cookie_cafe",
  "offer_taro_financier_cafe",
  "offer_matcha_tea_cafe",
  "offer_matcha_cookie_cafe",
  "offer_matcha_financier_cafe",
] as const;

type RebuildIdentity = Pick<
  MerchantScriptArguments,
  "organisationId" | "merchantId"
>;

export type Plan22Phase3CafeRebuildResult = Readonly<{
  ok: true;
  organisationId: string;
  merchantId: string;
  merchantRevision: number;
  inventoryItems: number;
  inventoryPositions: number;
  inventoryLots: number;
  recipes: number;
  preparationStations: number;
  modifierGroups: number;
  stockPolicies: number;
  menus: number;
  storefrontReady: true;
  menuReadyToPublish: true;
  productionReadyToComplete: true;
}>;

if (isMainModule(import.meta.url)) await main();

export async function rebuildPhase3Cafe(
  adminClient: CommerceAdminClient,
  identities: RebuildIdentity,
): Promise<Plan22Phase3CafeRebuildResult> {
  const provisioned = await adminClient.provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: identities.organisationId,
    merchantId: identities.merchantId,
    profile: "cafe_patisserie",
    createdAt: OCCURRED_AT,
  });
  if (!provisioned.ok)
    throw clientFailure("cafe scenario provisioning", provisioned);
  const foodService = await adminClient.readFoodServiceSnapshot(
    identities.merchantId,
  );
  if (!foodService.ok)
    throw clientFailure("food-service seed readback", foodService);
  const inventory = await adminClient.readMigrationInventory(
    identities.merchantId,
  );
  if (!inventory.ok) throw clientFailure("inventory seed readback", inventory);
  verifyCafeScenario(
    provisioned.value,
    foodService.value,
    inventory.value.inventoryLedger.lots,
  );
  return {
    ok: true,
    organisationId: identities.organisationId,
    merchantId: identities.merchantId,
    merchantRevision: provisioned.value.merchantRevision,
    inventoryItems: provisioned.value.resources.inventoryItems.length,
    inventoryPositions: provisioned.value.resources.inventoryPositions.length,
    inventoryLots: inventory.value.inventoryLedger.lots,
    recipes: foodService.value.resources.recipeRevisions.length,
    preparationStations: foodService.value.resources.preparationStations.length,
    modifierGroups: foodService.value.resources.modifierGroupRevisions.length,
    stockPolicies: foodService.value.resources.stockPolicies.length,
    menus: foodService.value.resources.menus.length,
    storefrontReady: true,
    menuReadyToPublish: true,
    productionReadyToComplete: true,
  };
}

function verifyCafeScenario(
  commerce: CommerceMerchantSnapshotV1,
  foodService: CommerceFoodServiceSnapshotV1,
  inventoryLots: number,
): void {
  const hasCatalog =
    commerce.resources.offers.some(hasSesameCookieOffer) &&
    commerce.resources.offers.some(hasSesameLatteOffer) &&
    commerce.resources.offers.some(hasSesameFinancierOffer) &&
    CAFE_EXPANSION_OFFER_IDS.every(
      hasListedOffer.bind(undefined, commerce.resources.offers),
    );
  const freshSeed =
    commerce.merchantRevision === 93 &&
    commerce.resources.inventoryItems.length === 18 &&
    commerce.resources.inventoryPositions.length === 18;
  const phase1Upgrade =
    commerce.merchantRevision === 95 &&
    commerce.resources.inventoryItems.length === 19 &&
    commerce.resources.inventoryPositions.length === 19;
  if (
    (!freshSeed && !phase1Upgrade) ||
    inventoryLots !== 17 ||
    foodService.resources.recipeRevisions.length !== 12 ||
    foodService.resources.preparationStations.length !== 2 ||
    foodService.resources.modifierGroupRevisions.length !== 1 ||
    foodService.resources.stockPolicies.length !== 1 ||
    foodService.resources.menus.length !== 0 ||
    !hasCatalog
  ) {
    throw new Error(
      "Plan 22 Phase 3 cafe setup does not match the canonical pre-operation state",
    );
  }
}

function hasSesameCookieOffer(
  offer: Readonly<{ id: string; lifecycle: Readonly<{ state: string }> }>,
): boolean {
  return (
    offer.id === "offer_sesame_cookie_cafe" &&
    offer.lifecycle.state === "listed"
  );
}

function hasSesameLatteOffer(
  offer: Readonly<{ id: string; lifecycle: Readonly<{ state: string }> }>,
): boolean {
  return (
    offer.id === "offer_sesame_latte_cafe" && offer.lifecycle.state === "listed"
  );
}

function hasSesameFinancierOffer(
  offer: Readonly<{ id: string; lifecycle: Readonly<{ state: string }> }>,
): boolean {
  return (
    offer.id === "offer_sesame_financier_cafe" &&
    offer.lifecycle.state === "listed"
  );
}

function hasListedOffer(
  offers: readonly Readonly<{
    id: string;
    lifecycle: Readonly<{ state: string }>;
  }>[],
  offerId: string,
): boolean {
  return offers.some(
    (offer) => offer.id === offerId && offer.lifecycle.state === "listed",
  );
}

async function main(): Promise<void> {
  const arguments_ = parseMerchantScriptArguments(
    "rebuild:plan22-phase3-cafe",
    process.argv.slice(2),
    process.env,
  );
  const adminClient = new CommerceAdminClient({
    baseUrl: arguments_.baseUrl,
    serviceToken: arguments_.serviceToken,
  });
  const result = await rebuildPhase3Cafe(adminClient, arguments_);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
