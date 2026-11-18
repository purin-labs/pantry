import {
  CommerceStorefrontClient,
  type CommerceBuyerCatalogListingV1,
  type CommerceBuyerMenuEntryV1,
  type CommerceBuyerMenuV1,
  type CommerceBuyerModifierGroupV1,
  type CommerceBuyerPaymentResultV1,
  type CommerceBuyerOrderV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceFetch,
} from "@seams/commerce-client";

import {
  collectAndReconcilePayment,
  recoverPunterPayment,
  replayAndReconcilePayment,
  type PunterPaymentSessionIdentity,
} from "./payment.ts";
import type { VariantBy } from "@seams/type-utils";
import { assertNever } from "@seams/std";

type PunterMoney = Readonly<{ amountMinor: number; currency: string }>;
type PlacedPayment = VariantBy<
  CommerceBuyerPaymentResultV1,
  "state",
  "placed"
>;
type PunterPlacedPaymentEvidence = Omit<PlacedPayment, "orderRecovery">;

type PunterCafePatisserieTotals = Readonly<{
  subtotal: PunterMoney;
  tax: PunterMoney;
  duty: PunterMoney;
  shipping: PunterMoney;
  total: PunterMoney;
}>;

export type PunterCafePatisserieScenario = Readonly<{
  kind: "cafe_patisserie";
  sesameCookieVariantId: string;
  menuId: string;
  sesameLatteMenuEntryId: string;
  oatMilkModifierOptionId: string;
  expectedTotals: PunterCafePatisserieTotals;
  expectedQuote: Readonly<{
    initialQuoteDigest: string;
    initialExpiresAt: string;
    quoteDigest: string;
    expiresAt: string;
    pickupLocationId: string;
    readyAt: string;
  }>;
}>;

type PunterPickupScenario = PunterCafePatisserieScenario;

type PunterPickupScenarioInput = Readonly<{
  baseUrl: string;
  merchantId: string;
  storefrontId: string;
  scenario: PunterPickupScenario;
  runId: string;
  fetch: CommerceFetch;
  orderPolling: Readonly<{
    maxAttempts: number;
    intervalMs: number;
    wait: (milliseconds: number) => Promise<void>;
  }>;
}>;

type PunterPickupEvidenceV1 = Readonly<{
  schemaVersion: "punter.pickup-evidence.v1";
  runId: string;
  merchantId: string;
  storefrontId: string;
  storefrontRevision: number;
  scenario: PunterPickupScenario;
  listing: CommerceBuyerCatalogListingV1;
  menu: CommerceBuyerMenuV1;
  menuEntry: CommerceBuyerMenuEntryV1;
  modifierOption: CommerceBuyerModifierGroupV1["options"][number];
  checkout: CommerceBuyerQuotedCheckoutV1;
  paymentSession: PunterPaymentSessionIdentity;
  payment: PunterPlacedPaymentEvidence;
  order: Extract<
    CommerceBuyerOrderV1,
    { fulfillment: "pickup"; state: "completed" }
  >;
}>;

type PunterCatalogMissing =
  | "sesame_cookie_listing"
  | "cafe_menu"
  | "sesame_latte_menu_entry"
  | "oat_milk_modifier";

type PunterPickupScenarioFailure =
  | Readonly<{
      stage: "session" | "catalog" | "checkout" | "payment" | "order";
      kind: "client_error";
      message: string;
    }>
  | Readonly<{
      stage: "catalog";
      kind: "scenario_unavailable";
      missing: PunterCatalogMissing;
    }>
  | Readonly<{ stage: "payment"; kind: "declined"; reasonCode: string }>
  | Readonly<{
      stage: "payment";
      kind: "indeterminate";
      reconcileAfter: string;
    }>
  | Readonly<{ stage: "payment"; kind: "identity_mismatch" }>
  | Readonly<{ stage: "order"; kind: "identity_mismatch" }>
  | Readonly<{
      stage: "order";
      kind: "completion_timeout";
      lastState: VariantBy<
        CommerceBuyerOrderV1,
        "fulfillment",
        "pickup"
      >["state"];
    }>
  | Readonly<{ stage: "order"; kind: "commercial_snapshot_mismatch" }>;

type PunterPickupScenarioResult =
  | Readonly<{ ok: true; evidence: PunterPickupEvidenceV1 }>
  | Readonly<{ ok: false; error: PunterPickupScenarioFailure }>;

type ResolvedCafePatisserie = Readonly<{
  scenario: PunterCafePatisserieScenario;
  listing: CommerceBuyerCatalogListingV1;
  menu: CommerceBuyerMenuV1;
  menuEntry: CommerceBuyerMenuEntryV1;
  modifierOption: CommerceBuyerModifierGroupV1["options"][number];
}>;

type ScenarioResolution =
  | Readonly<{ ok: true; value: ResolvedCafePatisserie }>
  | Readonly<{ ok: false; missing: PunterCatalogMissing }>;

export async function runPunterPickupScenario(
  input: PunterPickupScenarioInput,
): Promise<PunterPickupScenarioResult> {
  const client = new CommerceStorefrontClient({
    baseUrl: input.baseUrl,
    fetch: input.fetch,
  });
  const session = await client.createSession(
    input.merchantId,
    input.storefrontId,
    {
      schemaVersion: "underclerk.create-buyer-session.v1",
      buyer: { kind: "guest" },
    },
  );
  if (!session.ok) return clientFailure("session", session.error.message);
  const catalog = await client.readCatalog(
    input.merchantId,
    input.storefrontId,
    session.value.token,
  );
  if (!catalog.ok) return clientFailure("catalog", catalog.error.message);
  const scenario = resolveScenario(catalog.value, input.scenario);
  if (!scenario.ok) {
    return {
      ok: false,
      error: {
        stage: "catalog",
        kind: "scenario_unavailable",
        missing: scenario.missing,
      },
    };
  }
  const cart = await client.createCart(
    input.merchantId,
    input.storefrontId,
    session.value.token,
    {
      schemaVersion: "underclerk.create-buyer-cart.v1",
      idempotencyKey: `${input.runId}_cart`,
      lines: [
        {
          kind: "catalog",
          variantId: scenario.value.listing.variantId,
          quantity: 1,
        },
        {
          kind: "menu",
          menuId: scenario.value.menu.menuId,
          menuEntryId: scenario.value.menuEntry.menuEntryId,
          modifierOptionIds: [],
          quantity: 1,
        },
      ],
    },
  );
  if (!cart.ok) return clientFailure("checkout", cart.error.message);
  const checkout = await client.createPickupCheckout(
    input.merchantId,
    input.storefrontId,
    session.value.token,
    {
      schemaVersion: "underclerk.create-buyer-pickup-checkout.v1",
      idempotencyKey: `${input.runId}_checkout`,
      cartId: cart.value.cartId,
      cartRevision: cart.value.revision,
      buyer: {
        kind: "guest",
        contact: { kind: "email", email: "punter@example.test" },
      },
    },
  );
  if (!checkout.ok) return clientFailure("checkout", checkout.error.message);
  if (
    checkout.value.quote.quoteDigest !==
      scenario.value.scenario.expectedQuote.initialQuoteDigest ||
    checkout.value.quote.expiresAt !==
      scenario.value.scenario.expectedQuote.initialExpiresAt
  ) {
    return clientFailure(
      "checkout",
      "initial pickup quote did not match the scenario",
    );
  }
  const refreshed = await client.refreshPickupCheckout(
    input.merchantId,
    input.storefrontId,
    checkout.value.checkoutId,
    session.value.token,
    {
      schemaVersion: "underclerk.refresh-buyer-pickup-checkout.v1",
      idempotencyKey: `${input.runId}_refresh`,
      checkoutRevision: checkout.value.revision,
      quoteDigest: checkout.value.quote.quoteDigest,
      lines: [
        {
          kind: "catalog",
          variantId: scenario.value.listing.variantId,
          quantity: 1,
        },
        {
          kind: "menu",
          menuId: scenario.value.menu.menuId,
          menuEntryId: scenario.value.menuEntry.menuEntryId,
          modifierOptionIds: [scenario.value.modifierOption.modifierOptionId],
          quantity: 1,
        },
      ],
    },
  );
  if (!refreshed.ok) return clientFailure("checkout", refreshed.error.message);
  if (
    refreshed.value.checkoutId !== checkout.value.checkoutId ||
    refreshed.value.revision <= checkout.value.revision
  ) {
    return {
      ok: false,
      error: { stage: "order", kind: "commercial_snapshot_mismatch" },
    };
  }
  const paymentCommand = {
    schemaVersion: "underclerk.create-buyer-payment-session.v1" as const,
    idempotencyKey: `${input.runId}_payment`,
    checkoutRevision: refreshed.value.revision,
    quoteDigest: refreshed.value.quote.quoteDigest,
  };
  const payment = await collectAndReconcilePayment({
    client,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    checkoutId: refreshed.value.checkoutId,
    sessionToken: session.value.token,
    returnUrl: `${input.baseUrl}/store/cafe`,
    command: paymentCommand,
  });
  if (!payment.ok) return clientFailure("payment", payment.message);
  const recoveryClient = new CommerceStorefrontClient({
    baseUrl: input.baseUrl,
    fetch: input.fetch,
  });
  const recoveredPayment = await recoverPunterPayment({
    client: recoveryClient,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    checkoutId: refreshed.value.checkoutId,
    sessionToken: session.value.token,
    command: paymentCommand,
    session: payment.value.session,
    payment: payment.value.payment,
    intervalMs: input.orderPolling.intervalMs,
    wait: input.orderPolling.wait,
  });
  if (!recoveredPayment.ok)
    return clientFailure("payment", recoveredPayment.message);
  const recoveredPaymentValue = recoveredPayment.value;
  const placedPayment = recoveredPaymentValue.payment;
  switch (placedPayment.state) {
    case "placed":
      break;
    case "declined":
      return {
        ok: false,
        error: {
          stage: "payment",
          kind: "declined",
          reasonCode: placedPayment.reasonCode,
        },
      };
    case "processing":
    case "indeterminate":
      return {
        ok: false,
        error: {
          stage: "payment",
          kind: "indeterminate",
          reconcileAfter: placedPayment.reconcileAfter,
        },
      };
    default:
      return assertNever(
        placedPayment,
        "Unsupported Punter pickup payment branch",
      );
  }
  const order = await pollCompletedOrder(
    recoveryClient,
    input,
    placedPayment.orderRecovery.token,
    refreshed.value,
    placedPayment,
  );
  if (!order.ok) return order;
  if (
    !commercialSnapshotsMatch(
      session.value.storefrontRevision,
      catalog.value.storefront.revision,
      scenario.value,
      refreshed.value,
      placedPayment,
      order.order,
    )
  ) {
    return {
      ok: false,
      error: { stage: "order", kind: "commercial_snapshot_mismatch" },
    };
  }
  const replayPayment = await replayAndReconcilePayment({
    client: recoveryClient,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    checkoutId: refreshed.value.checkoutId,
    sessionToken: session.value.token,
    returnUrl: `${input.baseUrl}/store/cafe`,
    command: paymentCommand,
    expectedSession: payment.value.session,
  });
  if (!replayPayment.ok) return clientFailure("payment", replayPayment.message);
  const recoveredReplayPayment = await recoverPunterPayment({
    client: recoveryClient,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    checkoutId: refreshed.value.checkoutId,
    sessionToken: session.value.token,
    command: paymentCommand,
    session: replayPayment.value.session,
    payment: replayPayment.value.payment,
    intervalMs: input.orderPolling.intervalMs,
    wait: input.orderPolling.wait,
  });
  if (!recoveredReplayPayment.ok)
    return clientFailure("payment", recoveredReplayPayment.message);
  const replayPaymentValue = recoveredReplayPayment.value;
  switch (replayPaymentValue.payment.state) {
    case "placed":
      break;
    case "declined":
      return {
        ok: false,
        error: {
          stage: "payment",
          kind: "declined",
          reasonCode: replayPaymentValue.payment.reasonCode,
        },
      };
    case "processing":
    case "indeterminate":
      return {
        ok: false,
        error: {
          stage: "payment",
          kind: "indeterminate",
          reconcileAfter: replayPaymentValue.payment.reconcileAfter,
        },
      };
    default:
      return assertNever(
        replayPaymentValue.payment,
        "Unsupported Punter pickup payment branch",
      );
  }
  if (
    JSON.stringify(replayPaymentValue.session) !==
      JSON.stringify(payment.value.session) ||
    JSON.stringify(replayPaymentValue.payment) !== JSON.stringify(placedPayment)
  ) {
    return {
      ok: false,
      error: { stage: "payment", kind: "identity_mismatch" },
    };
  }
  const replayOrder = await recoveryClient.readOrder(
    input.merchantId,
    input.storefrontId,
    refreshed.value.checkoutId,
    placedPayment.orderRecovery.token,
  );
  if (!replayOrder.ok) return clientFailure("order", replayOrder.error.message);
  if (JSON.stringify(replayOrder.value) !== JSON.stringify(order.order)) {
    return {
      ok: false,
      error: { stage: "order", kind: "identity_mismatch" },
    };
  }
  return {
    ok: true,
    evidence: {
      schemaVersion: "punter.pickup-evidence.v1",
      runId: input.runId,
      merchantId: input.merchantId,
      storefrontId: input.storefrontId,
      storefrontRevision: session.value.storefrontRevision,
      scenario: scenario.value.scenario,
      listing: scenario.value.listing,
      menu: scenario.value.menu,
      menuEntry: scenario.value.menuEntry,
      modifierOption: scenario.value.modifierOption,
      checkout: refreshed.value,
      paymentSession: recoveredPaymentValue.session,
      payment: paymentEvidence(placedPayment),
      order: order.order,
    },
  };
}

async function pollCompletedOrder(
  client: CommerceStorefrontClient,
  input: PunterPickupScenarioInput,
  sessionToken: string,
  checkout: CommerceBuyerQuotedCheckoutV1,
  payment: VariantBy<CommerceBuyerPaymentResultV1, "state", "placed">,
): Promise<
  | Readonly<{
      ok: true;
      order: Extract<
        CommerceBuyerOrderV1,
        { fulfillment: "pickup"; state: "completed" }
      >;
    }>
  | Readonly<{ ok: false; error: PunterPickupScenarioFailure }>
> {
  if (
    !Number.isSafeInteger(input.orderPolling.maxAttempts) ||
    input.orderPolling.maxAttempts < 1 ||
    !Number.isSafeInteger(input.orderPolling.intervalMs) ||
    input.orderPolling.intervalMs < 0
  ) {
    throw new Error(
      "orderPolling requires a positive attempt count and non-negative interval",
    );
  }
  let lastState: VariantBy<
    CommerceBuyerOrderV1,
    "fulfillment",
    "pickup"
  >["state"] = "placed";
  for (
    let attempt = 1;
    attempt <= input.orderPolling.maxAttempts;
    attempt += 1
  ) {
    const order = await client.readOrder(
      input.merchantId,
      input.storefrontId,
      checkout.checkoutId,
      sessionToken,
    );
    if (!order.ok) {
      return {
        ok: false,
        error: {
          stage: "order",
          kind: "client_error",
          message: order.error.message,
        },
      };
    }
    if (
      order.value.orderId !== payment.orderId ||
      order.value.paymentId !== payment.paymentId ||
      order.value.fulfillmentId !== payment.fulfillmentId ||
      order.value.fulfillment !== "pickup"
    ) {
      return {
        ok: false,
        error: { stage: "order", kind: "identity_mismatch" },
      };
    }
    if (order.value.state === "completed")
      return { ok: true, order: order.value };
    lastState = order.value.state;
    if (attempt < input.orderPolling.maxAttempts) {
      await input.orderPolling.wait(input.orderPolling.intervalMs);
    }
  }
  return {
    ok: false,
    error: { stage: "order", kind: "completion_timeout", lastState },
  };
}

function resolveScenario(
  catalog: Readonly<{
    listings: readonly CommerceBuyerCatalogListingV1[];
    menus: readonly CommerceBuyerMenuV1[];
  }>,
  scenario: PunterPickupScenario,
): ScenarioResolution {
  switch (scenario.kind) {
    case "cafe_patisserie":
      return resolveCafePatisserie(catalog, scenario);
  }
}

function resolveCafePatisserie(
  catalog: Readonly<{
    listings: readonly CommerceBuyerCatalogListingV1[];
    menus: readonly CommerceBuyerMenuV1[];
  }>,
  scenario: PunterCafePatisserieScenario,
): ScenarioResolution {
  const listing = findAvailableSesameCookieListing(
    catalog.listings,
    scenario.sesameCookieVariantId,
  );
  if (listing === undefined)
    return { ok: false, missing: "sesame_cookie_listing" };
  const menu = findCafeMenu(catalog.menus, scenario.menuId);
  if (menu === undefined) return { ok: false, missing: "cafe_menu" };
  const menuEntry = findAvailableSesameLatteMenuEntry(
    menu.entries,
    scenario.sesameLatteMenuEntryId,
  );
  if (menuEntry === undefined)
    return { ok: false, missing: "sesame_latte_menu_entry" };
  const modifierOption = uniqueModifierOption(
    menuEntry,
    scenario.oatMilkModifierOptionId,
  );
  if (modifierOption === undefined)
    return { ok: false, missing: "oat_milk_modifier" };
  return {
    ok: true,
    value: { scenario, listing, menu, menuEntry, modifierOption },
  };
}

function uniqueModifierOption(
  menuEntry: CommerceBuyerMenuEntryV1,
  modifierOptionId: string,
):
  | CommerceBuyerMenuEntryV1["modifierGroups"][number]["options"][number]
  | undefined {
  let match:
    | CommerceBuyerMenuEntryV1["modifierGroups"][number]["options"][number]
    | undefined;
  for (const group of menuEntry.modifierGroups) {
    for (const option of group.options) {
      if (option.modifierOptionId !== modifierOptionId) continue;
      if (match !== undefined) return undefined;
      match = option;
    }
  }
  return match;
}

function findAvailableSesameCookieListing(
  listings: readonly CommerceBuyerCatalogListingV1[],
  variantId: string,
): CommerceBuyerCatalogListingV1 | undefined {
  let match: CommerceBuyerCatalogListingV1 | undefined;
  for (const listing of listings) {
    if (listing.variantId !== variantId || listing.availability !== "available")
      continue;
    if (match !== undefined) return undefined;
    match = listing;
  }
  return match;
}

function findCafeMenu(
  menus: readonly CommerceBuyerMenuV1[],
  menuId: string,
): CommerceBuyerMenuV1 | undefined {
  let match: CommerceBuyerMenuV1 | undefined;
  for (const menu of menus) {
    if (menu.menuId !== menuId) continue;
    if (match !== undefined) return undefined;
    match = menu;
  }
  return match;
}

function findAvailableSesameLatteMenuEntry(
  entries: readonly CommerceBuyerMenuEntryV1[],
  menuEntryId: string,
): CommerceBuyerMenuEntryV1 | undefined {
  let match: CommerceBuyerMenuEntryV1 | undefined;
  for (const entry of entries) {
    if (entry.menuEntryId !== menuEntryId || entry.availability !== "available")
      continue;
    if (match !== undefined) return undefined;
    match = entry;
  }
  return match;
}

function commercialSnapshotsMatch(
  sessionStorefrontRevision: number,
  catalogStorefrontRevision: number,
  scenario: ResolvedCafePatisserie,
  checkout: CommerceBuyerQuotedCheckoutV1,
  payment: VariantBy<CommerceBuyerPaymentResultV1, "state", "placed">,
  order: Extract<
    CommerceBuyerOrderV1,
    { fulfillment: "pickup"; state: "completed" }
  >,
): boolean {
  const lines = checkout.quote.lines;
  const catalogLine = lines[0];
  const menuLine = lines[1];
  const menuUnitPrice = addMoney(
    scenario.menuEntry.price,
    scenario.modifierOption.priceDelta,
  );
  const expectedSubtotal =
    menuUnitPrice === undefined
      ? undefined
      : addMoney(scenario.listing.price, menuUnitPrice);
  const expectedTotal =
    expectedSubtotal === undefined
      ? undefined
      : addMoney(expectedSubtotal, checkout.quote.totals.tax);
  if (
    catalogLine === undefined ||
    menuLine === undefined ||
    menuUnitPrice === undefined ||
    expectedSubtotal === undefined ||
    expectedTotal === undefined ||
    lines.length !== 2 ||
    catalogLine.kind !== "catalog" ||
    menuLine.kind !== "menu"
  )
    return false;
  if (payment.pickup === undefined || order.pickup === undefined) return false;
  return (
    sessionStorefrontRevision === catalogStorefrontRevision &&
    checkout.quote.quoteDigest ===
      scenario.scenario.expectedQuote.quoteDigest &&
    checkout.quote.expiresAt === scenario.scenario.expectedQuote.expiresAt &&
    catalogLine.variantId === scenario.listing.variantId &&
    catalogLine.quantity === 1 &&
    sameMoney(catalogLine.unitPrice, scenario.listing.price) &&
    sameMoney(catalogLine.lineTotal, scenario.listing.price) &&
    menuLine.menuId === scenario.menu.menuId &&
    menuLine.variantId === scenario.menuEntry.variantId &&
    menuLine.menuEntryId === scenario.menuEntry.menuEntryId &&
    menuLine.quantity === 1 &&
    sameStringArray(menuLine.modifierOptionIds, [
      scenario.modifierOption.modifierOptionId,
    ]) &&
    sameMoney(menuLine.unitPrice, menuUnitPrice) &&
    sameMoney(menuLine.lineTotal, menuUnitPrice) &&
    sameMoney(checkout.quote.totals.subtotal, expectedSubtotal) &&
    sameMoney(checkout.quote.totals.total, expectedTotal) &&
    sameMoney(
      checkout.quote.totals.subtotal,
      scenario.scenario.expectedTotals.subtotal,
    ) &&
    sameMoney(
      checkout.quote.totals.tax,
      scenario.scenario.expectedTotals.tax,
    ) &&
    sameMoney(
      checkout.quote.totals.duty,
      scenario.scenario.expectedTotals.duty,
    ) &&
    sameMoney(
      checkout.quote.totals.shipping,
      scenario.scenario.expectedTotals.shipping,
    ) &&
    sameMoney(
      checkout.quote.totals.total,
      scenario.scenario.expectedTotals.total,
    ) &&
    payment.checkoutId === checkout.checkoutId &&
    order.checkoutId === checkout.checkoutId &&
    sameMoney(payment.total, checkout.quote.totals.total) &&
    sameMoney(order.total, payment.total) &&
    checkout.quote.pickup.locationId ===
      scenario.scenario.expectedQuote.pickupLocationId &&
    checkout.quote.pickup.readyAt === scenario.scenario.expectedQuote.readyAt &&
    checkout.quote.pickup.locationId === payment.pickup.locationId &&
    payment.pickup.locationId === order.pickup.locationId &&
    checkout.quote.pickup.readyAt === payment.pickup.expectedBy &&
    payment.pickup.expectedBy === order.pickup.expectedBy
  );
}

function addMoney(
  left: PunterMoney,
  right: PunterMoney,
): PunterMoney | undefined {
  if (left.currency !== right.currency) return undefined;
  const amountMinor = left.amountMinor + right.amountMinor;
  if (!Number.isSafeInteger(amountMinor)) return undefined;
  return { amountMinor, currency: left.currency };
}

function sameMoney(left: PunterMoney, right: PunterMoney): boolean {
  return (
    left.amountMinor === right.amountMinor && left.currency === right.currency
  );
}

function paymentEvidence(payment: PlacedPayment): PunterPlacedPaymentEvidence {
  const { orderRecovery: _orderRecovery, ...evidence } = payment;
  return evidence;
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function clientFailure(
  stage: "session" | "catalog" | "checkout" | "payment" | "order",
  message: string,
): PunterPickupScenarioResult {
  return { ok: false, error: { stage, kind: "client_error", message } };
}
