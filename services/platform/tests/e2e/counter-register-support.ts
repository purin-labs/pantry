import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  CommerceAdminClient,
  type CommerceClientResult,
} from "@purin-labs/commerce-client";
import type { CounterRegisterSnapshot } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { controlBase } from "./device-fleet-support";
import { organisationDatabase } from "./organisation-database";

/**
 * A café with a published menu and a cash counter, for the Register journeys
 * (Plan 90): an owner, an operator and a viewer, and the commerce fixture's
 * pâtisserie with a cookie and a milk tea with a milk choice.
 */

export const MENU_ID = "menu_cafe_main";
export const COOKIE_ENTRY = "menu_entry_taro_cookie";
export const DRINK_ENTRY = "menu_entry_taro_milk_tea";
export const OAT_MILK_MOD = "modifier_option_oat_milk";

export async function setupRegisterShop(tag: string) {
  const owner = await commerceClient(`${tag}-owner-${crypto.randomUUID()}`);
  const staff = await commerceClient(`${tag}-staff-${crypto.randomUUID()}`);
  const viewer = await commerceClient(`${tag}-viewer-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, `Register ${tag}`);
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_${tag}_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );

  const db = organisationDatabase(organisationId);
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, `person_${tag}_operator`, "Barista"),
    db
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'operator', 'active', ?, NULL)",
      )
      .bind(
        organisationId,
        staff.identity.userId,
        `person_${tag}_operator`,
        now,
      ),
    db
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, `person_${tag}_viewer`, "Viewer"),
    db
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'viewer', 'active', ?, NULL)",
      )
      .bind(
        organisationId,
        viewer.identity.userId,
        `person_${tag}_viewer`,
        now,
      ),
  ]);

  const admin = new CommerceAdminClient({
    baseUrl: "http://underclerk.test",
    serviceToken: "underclerk-e2e-token",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  await required(
    admin.provisionDemo({
      schemaVersion: "underclerk.provision-demo.v2",
      externalReference: organisationId,
      merchantId,
      profile: "cafe_patisserie",
      createdAt: new Date(now).toISOString(),
    }),
  );
  const stock = await required(admin.readStockSnapshot(merchantId));
  const locationId = stock.commerce.resources.locations[0]?.id;
  const channelId = stock.commerce.resources.salesChannels[0]?.id;
  if (!locationId || !channelId) {
    throw new Error("Expected demo location and sales channel");
  }
  const offerForTitle = (title: string) => {
    const product = stock.commerce.resources.products.find(
      (p) => p.title === title,
    );
    const variant = stock.commerce.resources.variants.find(
      (v) => v.productId === product?.id,
    );
    const offer = stock.commerce.resources.offers.find(
      (o) => o.variantId === variant?.id && o.salesChannelId === channelId,
    );
    const plan = stock.consumptionPlans.find(
      (c) => c.variantId === variant?.id,
    );
    if (!offer || !plan) {
      throw new Error(`Missing offer or consumption plan for ${title}`);
    }
    return { offer, plan };
  };
  const cookieItem = offerForTitle("Taro Cookie");
  const drinkItem = offerForTitle("Taro Milk Tea");
  const milkGroup = stock.foodService.resources.modifierGroupRevisions.find(
    (g) => g.modifierGroupId === "modifier_group_milk",
  );
  if (!milkGroup) throw new Error("Missing seeded modifier_group_milk");

  const menuPublished = await required(
    admin.publishMenu({
      merchantId,
      expectedMerchantRevision: stock.commerce.merchantRevision,
      idempotencyKey: `publish_menu_${tag}`,
      menu: {
        menuId: MENU_ID,
        name: "Café menu",
        salesChannelId: channelId,
        scope: { kind: "location", locationId },
        validity: { kind: "always" },
        sections: [
          { sectionId: "section_pastries", name: "Pastries", position: 0 },
          { sectionId: "section_drinks", name: "Drinks", position: 1 },
        ],
        entries: [
          {
            menuEntryId: COOKIE_ENTRY,
            sectionId: "section_pastries",
            offerId: cookieItem.offer.id,
            offerRevision: cookieItem.offer.revision,
            consumptionPlanId: cookieItem.plan.consumptionPlanId,
            consumptionPlanRevision: cookieItem.plan.revision,
            modifierGroupRevisions: [],
          },
          {
            menuEntryId: DRINK_ENTRY,
            sectionId: "section_drinks",
            offerId: drinkItem.offer.id,
            offerRevision: drinkItem.offer.revision,
            consumptionPlanId: drinkItem.plan.consumptionPlanId,
            consumptionPlanRevision: drinkItem.plan.revision,
            modifierGroupRevisions: [
              {
                modifierGroupId: milkGroup.modifierGroupId,
                revision: milkGroup.revision,
              },
            ],
          },
        ],
      },
    }),
  );
  expect(menuPublished.outcome).toBe("applied");

  await required(
    admin.publishPointOfSaleConfiguration({
      schemaVersion: "underclerk.publish-point-of-sale-configuration.v1",
      merchantId,
      expectedRevision: null,
      publishedAt: new Date(now).toISOString(),
      publishedBy: owner.identity.userId,
      configuration: {
        configurationId: `pos_cfg_${tag}`,
        organisationId,
        satyrLocationId: locationId,
        salesChannelId: channelId,
        currency: "JPY",
        supportedItems: [],
        catalogScope: {
          kind: "published_menu",
          menuId: MENU_ID,
          maxQuantityPerLine: 20,
        },
        cashEnabled: true,
        quoteTtlSeconds: 900,
        tax: { kind: "percentage", basisPoints: 1_000, inclusion: "included" },
        pickupReadyLeadTimeSeconds: 0,
        afterSalePolicy: {
          cancellationPolicyId: "cancellation_counter",
          refundPolicyId: "refund_counter",
          refundGovernance: { kind: "approval_required" },
        },
        presentationPolicy: {
          locale: "ja-JP",
          merchantDisplayName: "Seams Patisserie",
          termsPolicyId: "terms_counter",
          privacyPolicyId: "privacy_counter",
          supportContact: "support@example.test",
        },
      },
    }),
  );

  return {
    organisationId,
    merchantId,
    locationId,
    base: controlBase(organisationId),
    owner,
    staff,
    viewer,
  };
}

export function menuLine(
  id: string,
  menuEntryId: string,
  modifierOptionIds: readonly string[],
  quantity: number,
) {
  return {
    cartLineId: `cl_${id}`,
    checkoutLineId: `line_${id}`,
    source: {
      kind: "menu" as const,
      menuId: MENU_ID,
      menuEntryId,
      modifierOptionIds: [...modifierOptionIds],
    },
    quantity: { amount: quantity, scale: 0, unit: "each" as const },
  };
}

export function extractRegister(body: unknown): CounterRegisterSnapshot {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.register)) {
    throw new Error(`Invalid register payload: ${JSON.stringify(body)}`);
  }
  return body.register as unknown as CounterRegisterSnapshot;
}

async function required<T>(
  promise: Promise<CommerceClientResult<T>>,
): Promise<T> {
  const result = await promise;
  if (!result.ok) {
    throw new Error(`Commerce call failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}
