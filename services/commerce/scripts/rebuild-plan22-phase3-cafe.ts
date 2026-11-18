import {
  CommerceAdminClient,
  type CommerceFoodServiceSnapshotV1,
  type CommerceMerchantSnapshotV1,
} from "@seams/commerce-client";
import { pathToFileURL } from "node:url";

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

type RebuildArguments = Readonly<{
  organisationId: string;
  merchantId: string;
  baseUrl: string;
  serviceToken: string;
}>;

type RebuildIdentity = Pick<RebuildArguments, "organisationId" | "merchantId">;

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

if (isMainModule()) await main();

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
  const arguments_ = parseArguments(process.argv.slice(2), process.env);
  const adminClient = new CommerceAdminClient({
    baseUrl: arguments_.baseUrl,
    serviceToken: arguments_.serviceToken,
  });
  const result = await rebuildPhase3Cafe(adminClient, arguments_);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  return (
    scriptPath !== undefined &&
    import.meta.url === pathToFileURL(scriptPath).href
  );
}

function clientFailure(
  operation: string,
  result: Readonly<{
    ok: false;
    error: Readonly<{ kind: string; message: string }>;
  }>,
): Error {
  return new Error(
    `${operation} failed: ${result.error.kind}: ${result.error.message}`,
  );
}

function parseArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): RebuildArguments {
  const values = new Map<string, string>();
  const start = argv[0] === "--" ? 1 : 0;
  for (let index = start; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(
        "Usage: rebuild:plan22-phase3-cafe --organisation <organisation_id> --merchant <merchant_id>",
      );
    }
    values.set(flag, value);
  }
  return {
    organisationId: requireIdentity(
      values.get("--organisation"),
      "--organisation",
      "organisation_",
    ),
    merchantId: requireIdentity(
      values.get("--merchant"),
      "--merchant",
      "merchant_",
    ),
    baseUrl: requireUrl(env.UNDERCLERK_BASE_URL),
    serviceToken: requireSecret(env.UNDERCLERK_SERVICE_TOKEN),
  };
}

function requireIdentity(
  value: string | undefined,
  field: string,
  prefix: string,
): string {
  if (
    value === undefined ||
    !value.startsWith(prefix) ||
    value !== value.trim()
  ) {
    throw new Error(`${field} must be a normalized ${prefix} identity`);
  }
  return value;
}

function requireUrl(value: string | undefined): string {
  if (value === undefined) throw new Error("UNDERCLERK_BASE_URL is required");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("UNDERCLERK_BASE_URL must use http or https");
  }
  return parsed.toString();
}

function requireSecret(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error("UNDERCLERK_SERVICE_TOKEN is required");
  }
  return value;
}
