import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  type PublishMenuCommand,
  type CommerceCommandInput,
  type CommerceMerchantSnapshotV1,
} from "@seams/commerce-client";
import { pathToFileURL } from "node:url";

import { configurePhase4Shipping } from "./configure-plan22-phase4-shipping.ts";
import {
  configurePlan23FlavoredCatalog,
  PLAN23_FLAVORS,
} from "./configure-plan23-flavored-catalog.ts";
import { rebuildPhase3Cafe } from "./rebuild-plan22-phase3-cafe.ts";

const BASE_URL = process.env.UNDERCLERK_BASE_URL ?? "http://127.0.0.1:3102";
const ORGANISATION_ID = "organisation_local_nuki_demo";
const MERCHANT_ID = "merchant_nuki_cafe_demo";
const CAFE_MENU_ENTRY_IDS = [
  "menu_entry_sesame_latte",
  "menu_entry_sesame_cookie",
  "menu_entry_sesame_financier",
  "menu_entry_ginger_milk_tea",
  "menu_entry_ginger_cookie",
  "menu_entry_ginger_financier",
  "menu_entry_taro_milk_tea",
  "menu_entry_taro_cookie",
  "menu_entry_taro_financier",
  "menu_entry_matcha_tea",
  "menu_entry_matcha_cookie",
  "menu_entry_matcha_financier",
] as const;

export const LOCAL_COMMERCE_MERCHANT = Object.freeze({
  organisationId: ORGANISATION_ID,
  merchantId: MERCHANT_ID,
});

if (isMainModule()) await main();

async function main(): Promise<void> {
  await waitForCommerce();
  const serviceToken = requiredEnvironment("UNDERCLERK_SERVICE_TOKEN");
  const admin = new CommerceAdminClient({ baseUrl: BASE_URL, serviceToken });
  // `--other-cafe <organisation_id> <merchant_id>` seeds one more café shop
  // with the same menu, for journeys that need a second tenant.
  const other = process.argv.indexOf("--other-cafe");
  if (other !== -1) {
    const organisationId = process.argv[other + 1];
    const merchantId = process.argv[other + 2];
    if (
      organisationId?.startsWith("organisation_") !== true ||
      merchantId?.startsWith("merchant_") !== true
    )
      throw new Error("Usage: --other-cafe <organisation_id> <merchant_id>");
    await seedOtherCafe(admin, organisationId, merchantId);
    console.log(`The café of ${merchantId} is ready.`);
    return;
  }
  await seedLocalCommerce(
    admin,
    new CommerceStorefrontClient({ baseUrl: BASE_URL }),
  );
  console.log("Local café and shipping storefronts are ready.");
}

/** A second café shop with the local café's products and menu. */
async function seedOtherCafe(
  admin: CommerceAdminClient,
  organisationId: string,
  merchantId: string,
): Promise<void> {
  await rebuildPhase3Cafe(admin, { organisationId, merchantId });
  const snapshot = await admin.readSnapshot(merchantId);
  if (!snapshot.ok) throw clientFailure("merchant readback", snapshot);
  const published = await admin.publishMenu(
    cafeMenu(snapshot.value.merchantRevision, merchantId),
  );
  if (!published.ok) throw clientFailure("café menu publication", published);
  if (published.value.outcome === "rejected")
    throw new Error(
      `café menu publication rejected: ${published.value.error.code}`,
    );
}

/** Seeds the local café and shipping storefronts, completing a partial seed. */
export async function seedLocalCommerce(
  admin: CommerceAdminClient,
  buyer: CommerceStorefrontClient,
): Promise<void> {
  let snapshot = await readOrSeedCafe(admin);

  if (!hasShippingFixture(snapshot)) {
    await configurePhase4Shipping(admin, {
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
    });
    snapshot = await readSnapshot(admin);
  }

  if (!hasFlavoredExportFixture(snapshot)) {
    await configurePlan23FlavoredCatalog(admin, {
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
    });
    snapshot = await readSnapshot(admin);
    if (!hasFlavoredExportFixture(snapshot)) {
      throw new Error("Flavored export catalog seeding did not converge");
    }
  }

  const foodService = await admin.readFoodServiceSnapshot(MERCHANT_ID);
  if (!foodService.ok)
    throw clientFailure("food-service readback", foodService);
  if (!foodService.value.resources.menus.some(isCafeMenu)) {
    const published = await admin.publishMenu(
      cafeMenu(snapshot.merchantRevision),
    );
    if (!published.ok) throw clientFailure("café menu publication", published);
    if (published.value.outcome === "rejected") {
      throw new Error(
        `café menu publication rejected: ${published.value.error.code}`,
      );
    }
  }

  await verifyBuyerSessions(buyer);
}

async function readOrSeedCafe(
  admin: CommerceAdminClient,
): Promise<CommerceMerchantSnapshotV1> {
  const existing = await admin.readSnapshot(MERCHANT_ID);
  if (!existing.ok) {
    await rebuildPhase3Cafe(admin, {
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
    });
    return readSnapshot(admin);
  }
  if (!hasCafeFixture(existing.value)) {
    await rebuildPhase3Cafe(admin, {
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
    });
    return readSnapshot(admin);
  }
  return existing.value;
}

async function readSnapshot(
  admin: CommerceAdminClient,
): Promise<CommerceMerchantSnapshotV1> {
  const result = await admin.readSnapshot(MERCHANT_ID);
  if (!result.ok) throw clientFailure("merchant readback", result);
  return result.value;
}

function hasCafeFixture(snapshot: CommerceMerchantSnapshotV1): boolean {
  return (
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_sesame_latte_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_sesame_cookie_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_sesame_financier_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_ginger_milk_tea_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_ginger_cookie_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_ginger_financier_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_taro_milk_tea_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_taro_cookie_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_taro_financier_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_matcha_tea_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_matcha_cookie_cafe"),
    ) &&
    snapshot.resources.offers.some(
      hasId.bind(undefined, "offer_matcha_financier_cafe"),
    )
  );
}

function hasShippingFixture(snapshot: CommerceMerchantSnapshotV1): boolean {
  return (
    snapshot.resources.variants.some(
      hasId.bind(undefined, "variant_cookie_box_6"),
    ) &&
    snapshot.resources.offers.some(hasId.bind(undefined, "offer_cookie_box_sg"))
  );
}

function hasFlavoredExportFixture(
  snapshot: CommerceMerchantSnapshotV1,
): boolean {
  return PLAN23_FLAVORS.every(
    (flavor) =>
      snapshot.resources.variants.some(
        hasId.bind(undefined, `variant_${flavor.key}_box_6`),
      ) &&
      snapshot.resources.offers.some(
        hasId.bind(undefined, `offer_${flavor.key}_box_sg`),
      ),
  );
}

function hasId(expected: string, resource: Readonly<{ id: string }>): boolean {
  return resource.id === expected;
}

function isCafeMenu(menu: Readonly<{ menuId: string }>): boolean {
  return menu.menuId === "menu_cafe_main";
}

function cafeMenu(
  expectedMerchantRevision: number,
  merchantId: string = MERCHANT_ID,
): CommerceCommandInput<PublishMenuCommand> {
  return {
    merchantId,
    expectedMerchantRevision,
    idempotencyKey: "local_nuki_cafe_main_menu",
    menu: {
      menuId: "menu_cafe_main",
      name: "Café main menu",
      salesChannelId: "sales_channel_cafe",
      scope: { kind: "location", locationId: "location_cafe" },
      validity: { kind: "always" },
      sections: [
        { sectionId: "section_drinks", name: "Drinks", position: 0 },
        { sectionId: "section_bakes", name: "Bakes", position: 1 },
      ],
      entries: [
        {
          menuEntryId: "menu_entry_sesame_latte",
          sectionId: "section_drinks",
          offerId: "offer_sesame_latte_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_sesame_latte",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [
            { modifierGroupId: "modifier_group_milk", revision: 1 },
          ],
        },
        {
          menuEntryId: "menu_entry_sesame_cookie",
          sectionId: "section_bakes",
          offerId: "offer_sesame_cookie_cafe",
          offerRevision: 1,
          consumptionPlanId: "consumption_plan_sesame_cookie",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [],
        },
        {
          menuEntryId: "menu_entry_sesame_financier",
          sectionId: "section_bakes",
          offerId: "offer_sesame_financier_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_sesame_financier",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [],
        },
        {
          menuEntryId: "menu_entry_ginger_milk_tea",
          sectionId: "section_drinks",
          offerId: "offer_ginger_milk_tea_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_ginger_milk_tea",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [
            { modifierGroupId: "modifier_group_milk", revision: 1 },
          ],
        },
        {
          menuEntryId: "menu_entry_ginger_cookie",
          sectionId: "section_bakes",
          offerId: "offer_ginger_cookie_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_ginger_cookie",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [],
        },
        {
          menuEntryId: "menu_entry_ginger_financier",
          sectionId: "section_bakes",
          offerId: "offer_ginger_financier_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_ginger_financier",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [],
        },
        {
          menuEntryId: "menu_entry_taro_milk_tea",
          sectionId: "section_drinks",
          offerId: "offer_taro_milk_tea_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_taro_milk_tea",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [
            { modifierGroupId: "modifier_group_milk", revision: 1 },
          ],
        },
        {
          menuEntryId: "menu_entry_taro_cookie",
          sectionId: "section_bakes",
          offerId: "offer_taro_cookie_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_taro_cookie",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [],
        },
        {
          menuEntryId: "menu_entry_taro_financier",
          sectionId: "section_bakes",
          offerId: "offer_taro_financier_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_taro_financier",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [],
        },
        {
          menuEntryId: "menu_entry_matcha_tea",
          sectionId: "section_drinks",
          offerId: "offer_matcha_tea_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_matcha_tea",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [],
        },
        {
          menuEntryId: "menu_entry_matcha_cookie",
          sectionId: "section_bakes",
          offerId: "offer_matcha_cookie_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_matcha_cookie",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [],
        },
        {
          menuEntryId: "menu_entry_matcha_financier",
          sectionId: "section_bakes",
          offerId: "offer_matcha_financier_cafe",
          offerRevision: 2,
          consumptionPlanId: "consumption_plan_matcha_financier",
          consumptionPlanRevision: 1,
          modifierGroupRevisions: [],
        },
      ],
    },
  };
}

async function verifyBuyerSessions(
  buyer: CommerceStorefrontClient,
): Promise<void> {
  const cafe = await buyer.createSession(MERCHANT_ID, "storefront_cafe", {
    schemaVersion: "underclerk.create-buyer-session.v1",
    buyer: { kind: "guest" },
  });
  if (!cafe.ok) throw clientFailure("café buyer session", cafe);
  const cafeCatalog = await buyer.readCatalog(
    MERCHANT_ID,
    "storefront_cafe",
    cafe.value.token,
  );
  if (!cafeCatalog.ok) throw clientFailure("café buyer catalog", cafeCatalog);
  const menu = cafeCatalog.value.menus.find(isCafeMenu);
  if (
    menu === undefined ||
    !CAFE_MENU_ENTRY_IDS.every(hasMenuEntry.bind(undefined, menu.entries))
  ) {
    throw new Error("café buyer menu is unavailable");
  }
  const shipping = await buyer.createSession(
    MERCHANT_ID,
    "storefront_cookie_store_sg",
    {
      schemaVersion: "underclerk.create-buyer-session.v1",
      buyer: { kind: "guest" },
    },
  );
  if (!shipping.ok) throw clientFailure("shipping buyer session", shipping);
  const shippingCatalog = await buyer.readCatalog(
    MERCHANT_ID,
    "storefront_cookie_store_sg",
    shipping.value.token,
  );
  if (!shippingCatalog.ok)
    throw clientFailure("shipping buyer catalog", shippingCatalog);
  if (!shippingCatalog.value.listings.some(hasShippingVariant)) {
    throw new Error("shipping buyer listing is unavailable");
  }
}

function hasMenuEntry(
  entries: readonly Readonly<{ menuEntryId: string }>[],
  menuEntryId: (typeof CAFE_MENU_ENTRY_IDS)[number],
): boolean {
  return entries.some(hasMenuEntryId.bind(undefined, menuEntryId));
}

function hasMenuEntryId(
  expected: string,
  entry: Readonly<{ menuEntryId: string }>,
): boolean {
  return entry.menuEntryId === expected;
}

function hasShippingVariant(listing: Readonly<{ variantId: string }>): boolean {
  return listing.variantId === "variant_cookie_box_6";
}

async function waitForCommerce(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // Underclerk may still be binding its local port.
    }
    await delay(250);
  }
  throw new Error("Underclerk did not become healthy within 30 seconds");
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  return (
    scriptPath !== undefined &&
    import.meta.url === pathToFileURL(scriptPath).href
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay.bind(undefined, milliseconds));
}

function resolveDelay(milliseconds: number, resolve: () => void): void {
  setTimeout(resolve, milliseconds);
}

function requiredEnvironment(name: "UNDERCLERK_SERVICE_TOKEN"): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
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
