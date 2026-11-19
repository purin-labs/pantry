import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  CommerceAdminClient,
  type CommerceClientResult,
} from "@seams/commerce-client";
import {
  REGISTER_VIEW_COMMANDS,
  parseOrderQueueEntries,
  type CounterRegisterSnapshot,
  type PlatformGatewayMessage,
} from "@seams/control-api";
import { parseEnvelope as parseCounterSaleEnvelope } from "@seams/control-api/portal/counter-sale";
import { parseTerminalAssignment } from "@seams/contracts";
import { isRecord } from "@seams/std";

import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import { activateTerminalAssignment } from "../../src/data/terminal-assignment-store";
import { parseOrganisationId } from "../../src/ids";
import { TOOLS } from "../../src/agent-tools/registry";
import { authorizedBakerySurfaceCommands } from "../../src/actors/session/transient-turns";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import {
  connectGateway,
  controlBase,
  credentialOf,
  enrollGateway,
  found,
  helloAndWait,
  send,
} from "./device-fleet-support";
import { organisationDatabase } from "./organisation-database";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";

const MENU_ID = "menu_cafe_main";
const COOKIE_ENTRY = "menu_entry_taro_cookie";
const DRINK_ENTRY = "menu_entry_taro_milk_tea";
const OAT_MILK_MOD = "modifier_option_oat_milk";

it(
  "runs Café › Register as an operator for cash + modifiers + order queue handover, refuses viewer, and keeps Sous Chef free of money movement",
  { timeout: 180_000 },
  operatorCashAndRbacJourney,
);

it(
  "collects FeliCa over GMO stera LAN gateway via DeviceFleetActor, enforces terminal exclusivity and result_unknown lock across socket drop/reconnect, and settles manual cash refund",
  { timeout: 180_000 },
  gmoSteraLanGatewayEndToEndJourney,
);

async function operatorCashAndRbacJourney(): Promise<void> {
  const { organisationId, merchantId, locationId, base, owner, staff, viewer } =
    await setupRegisterShop("reg-cash");

  // 1. Viewer is refused on Register read and mutations.
  const viewerRead = await send(
    `${base}/commerce/counter-register`,
    viewer.session,
    "GET",
  );
  expect(viewerRead.status).toBe(404);
  expect(viewerRead.body).toMatchObject({
    error: "organisation_role_insufficient",
  });

  const viewerOpen = await send(
    `${base}/commerce/counter-sales`,
    viewer.session,
    "POST",
    {
      satyrLocationId: locationId,
      checkoutId: "chk_viewer_blocked",
      tenderMode: "cash",
      lines: [menuLine("l1", COOKIE_ENTRY, [], 1)],
    },
  );
  expect(viewerOpen.status).toBe(404);
  expect(viewerOpen.body).toMatchObject({
    error: "organisation_role_insufficient",
  });

  // 2. Operator loads Café › Register snapshot with published menu, modifiers, and cash enabled.
  const registerResponse = await send(
    `${base}/commerce/counter-register`,
    staff.session,
    "GET",
  );
  expect(registerResponse.status, JSON.stringify(registerResponse.body)).toBe(200);
  const register = extractRegister(registerResponse.body);
  expect(register.satyrLocationId).toBe(locationId);
  expect(register.policy?.cashEnabled).toBe(true);
  expect(register.policy?.catalogScope).toMatchObject({
    kind: "published_menu",
    menuId: MENU_ID,
  });
  expect(register.terminal.assigned).toBe(false);
  const allEntries = register.menu?.sections.flatMap((s) => s.entries) ?? [];
  const drink = allEntries.find((e) => e.menuEntryId === DRINK_ENTRY);
  const cookie = allEntries.find((e) => e.menuEntryId === COOKIE_ENTRY);
  expect(drink).toBeDefined();
  expect(cookie).toBeDefined();
  expect(
    drink?.modifierGroups
      .flatMap((g) => g.options)
      .some((o) => o.modifierOptionId === OAT_MILK_MOD),
  ).toBe(true);

  // 3. Operator opens a cash counter sale with cookie + drink + Oat Milk modifier (no terminal bound).
  const checkoutId = `chk_cash_${crypto.randomUUID().slice(0, 8)}`;
  const opened = await send(
    `${base}/commerce/counter-sales`,
    staff.session,
    "POST",
    {
      satyrLocationId: locationId,
      checkoutId,
      tenderMode: "cash",
      lines: [
        menuLine("l_cookie", COOKIE_ENTRY, [], 1),
        menuLine("l_drink", DRINK_ENTRY, [OAT_MILK_MOD], 1),
      ],
    },
  );
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);

  const saleBeforeCash = parseCounterSaleEnvelope(
    (
      await send(
        `${base}/commerce/counter-sales/${checkoutId}`,
        staff.session,
        "GET",
      )
    ).body,
  );
  expect(saleBeforeCash.state).toBe("awaiting_collection");
  expect(saleBeforeCash.quote).not.toBeNull();
  const quote = saleBeforeCash.quote!;
  const totalMinor = quote.amount.amountMinor;
  expect(totalMinor).toBeGreaterThan(0);

  // Viewer is refused on cash settlement.
  const viewerCash = await send(
    `${base}/commerce/counter-sales/${checkoutId}/cash`,
    viewer.session,
    "POST",
    {
      checkoutRevision: quote.checkoutRevision,
      quoteDigest: quote.quoteDigest,
      cashReceived: { amountMinor: 2_000, currency: "JPY" },
    },
  );
  expect(viewerCash.status).toBe(404);
  expect(viewerCash.body).toMatchObject({
    error: "organisation_role_insufficient",
  });

  // 4. Operator settles in cash with ¥2,000; replay with same key returns same receipt.
  const cashIdemp = `cash_${checkoutId}`;
  const cashRes = await send(
    `${base}/commerce/counter-sales/${checkoutId}/cash`,
    staff.session,
    "POST",
    {
      checkoutRevision: quote.checkoutRevision,
      quoteDigest: quote.quoteDigest,
      cashReceived: { amountMinor: 2_000, currency: "JPY" },
    },
    cashIdemp,
  );
  expect(cashRes.status, JSON.stringify(cashRes.body)).toBe(200);
  const paidSale = parseCounterSaleEnvelope(cashRes.body);
  expect(paidSale.state).toBe("complete");
  expect(paidSale.orderId).not.toBeNull();
  expect(paidSale.pickupCode).toMatch(/^[A-Z]-\d{3}$/u);
  expect(paidSale.manualTender).toEqual({
    cashReceivedMinor: 2_000,
    changeDueMinor: 2_000 - totalMinor,
    currency: "JPY",
  });

  const replayCash = await send(
    `${base}/commerce/counter-sales/${checkoutId}/cash`,
    staff.session,
    "POST",
    {
      checkoutRevision: quote.checkoutRevision,
      quoteDigest: quote.quoteDigest,
      cashReceived: { amountMinor: 2_000, currency: "JPY" },
    },
    cashIdemp,
  );
  expect(replayCash.status).toBe(200);
  expect(parseCounterSaleEnvelope(replayCash.body).orderId).toBe(
    paidSale.orderId,
  );

  // 5. Order appears on Café › Order queue with the same pickup code and operator hands it over.
  const queueRes = await send(
    `${base}/commerce/order-queue`,
    staff.session,
    "GET",
  );
  expect(queueRes.status).toBe(200);
  const queueEntries = parseOrderQueueEntries(
    isRecord(queueRes.body) ? queueRes.body.entries : null,
  );
  const matching = queueEntries?.find((e) => e.orderId === paidSale.orderId);
  expect(matching).toBeDefined();
  expect(matching?.code).toBe(paidSale.pickupCode);

  const readyRes = await send(
    `${base}/commerce/order-queue/${matching!.fulfillmentId}/advance`,
    staff.session,
    "POST",
    { action: "ready" },
  );
  expect(readyRes.status, JSON.stringify(readyRes.body)).toBe(200);

  const handoverRes = await send(
    `${base}/commerce/order-queue/${matching!.fulfillmentId}/advance`,
    staff.session,
    "POST",
    { action: "hand_over" },
  );
  expect(handoverRes.status, JSON.stringify(handoverRes.body)).toBe(200);

  const queueAfter = parseOrderQueueEntries(
    isRecord(
      (await send(`${base}/commerce/order-queue`, staff.session, "GET")).body,
    )
      ? (
          (await send(`${base}/commerce/order-queue`, staff.session, "GET"))
            .body as Record<string, unknown>
        ).entries
      : null,
  );
  expect(queueAfter?.some((e) => e.orderId === paidSale.orderId)).toBe(false);

  // 6. Sous Chef safety invariant: read + basket staging only, ZERO money movement tools.
  const toolNames = TOOLS.map((t) => t.name);
  expect(toolNames).toContain("counter_sale_read");
  for (const cmd of REGISTER_VIEW_COMMANDS) {
    expect(toolNames).toContain(cmd);
  }
  const forbiddenMoneyTool = TOOLS.find((t) =>
    /counter_sale_(collect|cash|charge|drawer|refund)|terminal_collect|cash_drawer/u.test(
      t.name,
    ),
  );
  expect(forbiddenMoneyTool).toBeUndefined();

  // Operator receives ONLY Register staging commands (no Kitchen/Costs commands); viewer receives none.
  const operatorCommands = authorizedBakerySurfaceCommands({
    kind: "control",
    organisationId,
    userId: staff.identity.userId,
    requesterPersonId: "person_reg-cash_operator",
    membershipRevision: 1,
    role: "operator",
  });
  expect(operatorCommands).toEqual([...REGISTER_VIEW_COMMANDS]);
  const viewerCommands = authorizedBakerySurfaceCommands({
    kind: "control",
    organisationId,
    userId: viewer.identity.userId,
    requesterPersonId: "person_reg-cash_viewer",
    membershipRevision: 1,
    role: "viewer",
  });
  expect(viewerCommands).toEqual([]);

  // Keep owner / merchantId referenced so fixtures stay explicit.
  expect(owner.identity.userId.length).toBeGreaterThan(0);
  expect(merchantId.length).toBeGreaterThan(0);
}

async function gmoSteraLanGatewayEndToEndJourney(): Promise<void> {
  const { organisationId, merchantId, locationId, base, owner, staff } =
    await setupRegisterShop("reg-stera");

  // 1. Enroll a shop gateway for this exact café location and announce a payment_terminal.
  const startedRes = await send(
    `${base}/devices/gateways`,
    owner.session,
    "POST",
    { name: "Counter Gateway", locationId },
  );
  expect(startedRes.status, JSON.stringify(startedRes.body)).toBe(201);
  const startedBody = startedRes.body as { gatewayId: string; code: string };
  const enrolled = await enrollGateway(
    organisationId,
    startedBody.gatewayId,
    startedBody.code,
  );
  const credential = await credentialOf(enrolled);

  const steraDevice = found("stera_lan_1", "Counter stera", {
    kind: "payment_terminal",
    model: "stera terminal",
    capabilities: [{ id: "collect_payment", label: "Collect payment", revision: 1 }],
  });
  const gateway1 = await connectGateway(credential);
  await helloAndWait(gateway1, [steraDevice]);

  // 2. Bind this café location to the LAN gateway stera terminal in D1.
  const parsedOrgId = parseOrganisationId(organisationId);
  if (!parsedOrgId.ok) throw new Error("Invalid org id");
  const parsedAssignment = parseTerminalAssignment({
    assignmentId: `assign_stera_${crypto.randomUUID().slice(0, 8)}`,
    organisationId,
    merchantId,
    satyrLocationId: locationId,
    providerLocationId: "GMO_STERA_LOC_TOKYO",
    account: {
      integrationAccountId: "gmo_stera_account_1",
      providerAccountId: "gmo_merchant_1",
      environment: "development",
      capabilityRevision: 1,
      country: "JP",
      currency: "JPY",
    },
    target: {
      kind: "lan_gateway_device",
      gatewayId: startedBody.gatewayId,
      deviceSourceKey: "stera_lan_1",
    },
    transport: "lan_gateway",
    adapterVersion: "gmo_stera_lan_v1",
    revision: 1,
    state: { kind: "active" },
  });
  if (!parsedAssignment.ok) {
    throw new Error(`Invalid assignment: ${JSON.stringify(parsedAssignment.error)}`);
  }
  const saved = await activateTerminalAssignment({
    db: organisationDatabase(organisationId),
    organisationId: parsedOrgId.value,
    assignment: parsedAssignment.value,
    now: Date.now(),
  });
  expect(saved.ok).toBe(true);

  // Verify Register snapshot exposes the gmo_stera LAN terminal.
  const register = extractRegister(
    (await send(`${base}/commerce/counter-register`, staff.session, "GET")).body,
  );
  expect(register.terminal).toMatchObject({
    assigned: true,
    provider: "gmo_stera",
    targetKind: "lan_gateway_device",
    gatewayId: startedBody.gatewayId,
    deviceSourceKey: "stera_lan_1",
    ready: true,
    supportedMethods: ["card", "felica", "qr_code"],
  });

  // 3. Operator opens Sale #1 and dispatches a FeliCa payment to the LAN gateway.
  const checkout1 = `chk_stera_1_${crypto.randomUUID().slice(0, 8)}`;
  const open1 = await send(`${base}/commerce/counter-sales`, staff.session, "POST", {
    satyrLocationId: locationId,
    checkoutId: checkout1,
    tenderMode: "terminal",
    lines: [menuLine("l1", COOKIE_ENTRY, [], 1)],
  });
  expect(open1.status, JSON.stringify(open1.body)).toBe(200);
  const sale1 = parseCounterSaleEnvelope(
    (await send(`${base}/commerce/counter-sales/${checkout1}`, staff.session, "GET"))
      .body,
  );
  const quote1 = sale1.quote!;

  const collect1 = await send(
    `${base}/commerce/counter-sales/${checkout1}/collection`,
    staff.session,
    "POST",
    {
      satyrLocationId: locationId,
      checkoutRevision: quote1.checkoutRevision,
      quoteDigest: quote1.quoteDigest,
      amount: quote1.amount,
      paymentMethod: "felica",
    },
  );
  expect(collect1.status, JSON.stringify(collect1.body)).toBe(200);

  // Gateway socket receives the real terminal_collect frame!
  await expect
    .poll(() => gateway1.received.some((m) => m.type === "terminal_collect"))
    .toBe(true);
  const collectFrame = gateway1.received.find(
    (m): m is Extract<PlatformGatewayMessage, { type: "terminal_collect" }> =>
      m.type === "terminal_collect",
  )!;
  expect(collectFrame).toMatchObject({
    sourceKey: "stera_lan_1",
    paymentMethod: "felica",
    amountMinor: quote1.amount.amountMinor,
    currency: "JPY",
  });

  // 4. Exclusivity: second concurrent sale on the same terminal is refused with 409 terminal_busy!
  const checkout2 = `chk_stera_2_${crypto.randomUUID().slice(0, 8)}`;
  await send(`${base}/commerce/counter-sales`, staff.session, "POST", {
    satyrLocationId: locationId,
    checkoutId: checkout2,
    tenderMode: "terminal",
    lines: [menuLine("l2", COOKIE_ENTRY, [], 1)],
  });
  const sale2 = parseCounterSaleEnvelope(
    (await send(`${base}/commerce/counter-sales/${checkout2}`, staff.session, "GET"))
      .body,
  );
  const busyRes = await send(
    `${base}/commerce/counter-sales/${checkout2}/collection`,
    staff.session,
    "POST",
    {
      satyrLocationId: locationId,
      checkoutRevision: sale2.quote!.checkoutRevision,
      quoteDigest: sale2.quote!.quoteDigest,
      amount: sale2.quote!.amount,
      paymentMethod: "card",
    },
  );
  expect(busyRes.status).toBe(409);
  expect(busyRes.body).toMatchObject({ error: "terminal_busy" });

  // 5. Socket drops before result -> DeviceFleetActor marks result_unknown and blocks new collections!
  await gateway1.close();
  const gateway2 = await connectGateway(credential);
  await helloAndWait(gateway2, [steraDevice]);

  // On reconnect hello, DeviceFleetActor automatically sends terminal_inquire!
  await expect
    .poll(() =>
      gateway2.received.some(
        (m) =>
          m.type === "terminal_inquire" &&
          m.paymentAttemptId === collectFrame.paymentAttemptId,
      ),
    )
    .toBe(true);

  // While still in result_unknown (before terminal_result arrives), a new sale is STILL blocked!
  const checkout3 = `chk_stera_3_${crypto.randomUUID().slice(0, 8)}`;
  await send(`${base}/commerce/counter-sales`, staff.session, "POST", {
    satyrLocationId: locationId,
    checkoutId: checkout3,
    tenderMode: "terminal",
    lines: [menuLine("l3", COOKIE_ENTRY, [], 1)],
  });
  const sale3 = parseCounterSaleEnvelope(
    (await send(`${base}/commerce/counter-sales/${checkout3}`, staff.session, "GET"))
      .body,
  );
  const lockedRes = await send(
    `${base}/commerce/counter-sales/${checkout3}/collection`,
    staff.session,
    "POST",
    {
      satyrLocationId: locationId,
      checkoutRevision: sale3.quote!.checkoutRevision,
      quoteDigest: sale3.quote!.quoteDigest,
      amount: sale3.quote!.amount,
      paymentMethod: "card",
    },
  );
  expect(lockedRes.status).toBe(409);
  expect(lockedRes.body).toMatchObject({ error: "result_unknown" });

  // 6. Gateway answers terminal_inquire with terminal_result (captured FeliCa SUICA, non-refundable via provider).
  gateway2.send({
    type: "terminal_result",
    requestId: collectFrame.requestId,
    sourceKey: "stera_lan_1",
    paymentAttemptId: collectFrame.paymentAttemptId,
    outcome: "captured",
    providerPaymentReference: "stera_tx_felica_99",
    paymentMethod: "felica",
    tenderBrand: "SUICA",
    providerRefundable: false,
    reasonCode: null,
  });

  // Give DeviceFleetActor a moment to persist terminal_result, then operator reconciles sale #1.
  let reconciledSale = parseCounterSaleEnvelope(
    (await send(`${base}/commerce/counter-sales/${checkout1}`, staff.session, "GET"))
      .body,
  );
  await expect
    .poll(async () => {
      const rec = await send(
        `${base}/commerce/counter-sales/${checkout1}/reconciliation`,
        staff.session,
        "POST",
        {},
      );
      if (rec.status !== 200) return "retry";
      reconciledSale = parseCounterSaleEnvelope(rec.body);
      return reconciledSale.state;
    })
    .toBe("complete");

  expect(reconciledSale.paymentMethod).toBe("felica");
  expect(reconciledSale.tenderBrand).toBe("SUICA");
  expect(reconciledSale.providerRefundable).toBe(false);
  expect(reconciledSale.pickupCode).toMatch(/^[A-Z]-\d{3}$/u);

  // 7. FeliCa refund guard: normal provider refund is refused; operator cannot run manual cash refund; owner succeeds!
  const refusedProviderRefund = await send(
    `${base}/commerce/counter-sales/${checkout1}/refund`,
    owner.session,
    "POST",
    {},
  );
  expect(refusedProviderRefund.status).toBe(409);

  const operatorManualRefund = await send(
    `${base}/commerce/counter-sales/${checkout1}/manual-cash-refund`,
    staff.session,
    "POST",
    { reason: "Operator should not be allowed" },
  );
  expect(operatorManualRefund.status).toBe(404);
  expect(operatorManualRefund.body).toMatchObject({
    error: "organisation_role_insufficient",
  });

  const ownerManualRefund = await send(
    `${base}/commerce/counter-sales/${checkout1}/manual-cash-refund`,
    owner.session,
    "POST",
    { reason: "Refunded Suica payment in cash at counter" },
  );
  expect(ownerManualRefund.status, JSON.stringify(ownerManualRefund.body)).toBe(
    200,
  );
  const refundedSale = parseCounterSaleEnvelope(ownerManualRefund.body);
  expect(refundedSale.afterSale?.refundState).toBe("completed");

  await gateway2.close();
}

async function setupRegisterShop(tag: string) {
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
  await connectCommerceFixture(organisationId, owner.identity.userId, merchantId);

  const db = organisationDatabase(organisationId);
  const now = Date.now();
  await db.batch([
    db.prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
    ).bind(organisationId, `person_${tag}_operator`, "Barista"),
    db.prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'operator', 'active', ?, NULL)",
    ).bind(organisationId, staff.identity.userId, `person_${tag}_operator`, now),
    db.prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
    ).bind(organisationId, `person_${tag}_viewer`, "Viewer"),
    db.prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'viewer', 'active', ?, NULL)",
    ).bind(organisationId, viewer.identity.userId, `person_${tag}_viewer`, now),
  ]);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { operator: staff, privateMember: viewer },
  });

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
    const product = stock.commerce.resources.products.find((p) => p.title === title);
    const variant = stock.commerce.resources.variants.find((v) => v.productId === product?.id);
    const offer = stock.commerce.resources.offers.find(
      (o) => o.variantId === variant?.id && o.salesChannelId === channelId,
    );
    const plan = stock.consumptionPlans.find((c) => c.variantId === variant?.id);
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

function menuLine(
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

function extractRegister(body: unknown): CounterRegisterSnapshot {
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
