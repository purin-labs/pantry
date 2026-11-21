// Plan 77 step 2: the counter runs the same checkout stages as an online
// pickup. A barista rings up two tins with the one-use code COUNTER10: the
// quote takes 10% off and the tax is on what is paid, and the code is held,
// so a second counter sale with it is refused. A merchant plugin's checkout
// rule applies at the counter too: a basket of four tins is refused with the
// plugin's message, and a basket of two passes with the plugin's run on the
// quote. A basket with no code and no plugin quotes as before. Set
// COUNTER_STAGES_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte for the same commit.
import { clientInput } from "./command-input.ts";
import type {
  CreateCommerceInPersonCheckoutV1,
  CommerceAdminClient,
} from "@purin-labs/commerce-client";
import type { Checkout, PluginDefinition } from "@purin-labs/commerce-contracts";
import { expect, it } from "vitest";

import {
  CHANNEL,
  LOCATION,
  NOW,
  StaffDesk,
  merchantId,
  organisationId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const SMALL_SENCHA = "variant_tea_small_sencha";

const TIN_LIMIT = `
function run(input) {
  let tins = 0;
  for (const line of input.checkout.lines) tins += line.quantity;
  return { refusals: tins > input.settings.maxTins
    ? [{ message: "At most " + input.settings.maxTins + " tins at the counter." }]
    : [] };
}`;

it(
  "runs discounts and merchant plugin rules at the counter",
  { timeout: 60_000 },
  counterStages,
);

async function counterStages(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin } = backend;
    const counter = new CounterDesk(admin);
    await counter.createTea();
    await counter.publishPolicy();

    // A basket with no code and no plugin quotes as before.
    const plain = await counter.quote("plain", 2);
    expect(plain.totals).toEqual({
      subtotal: { amountMinor: 2_400, currency: "JPY" },
      tax: { amountMinor: 240, currency: "JPY" },
      duty: { amountMinor: 0, currency: "JPY" },
      shipping: { amountMinor: 0, currency: "JPY" },
      total: { amountMinor: 2_640, currency: "JPY" },
    });
    expect(plain).not.toHaveProperty("pluginRuns");

    // The one-use code takes 10% off; tax is on what is paid.
    expect(await counter.createCode()).toMatchObject({ outcome: "applied" });
    const coded = await counter.quote("coded", 2, ["COUNTER10"]);
    expect(coded.totals).toMatchObject({
      subtotal: { amountMinor: 2_160 },
      discount: { amountMinor: 240 },
      tax: { amountMinor: 216 },
      total: { amountMinor: 2_376 },
    });
    // The quoted sale holds the code's one use.
    const second = await counter.ring("coded_again", 1, ["COUNTER10"]);
    expect(second).toMatchObject(
      rejectedWith({ code: "resource_relationship_invalid" }),
    );

    // A merchant plugin's rule applies at the counter.
    expect(await counter.installTinLimit()).toMatchObject({
      outcome: "applied",
    });
    const tooMany = await counter.ring("too_many", 4);
    expect(tooMany).toMatchObject(
      rejectedWith({
        code: "checkout_refused",
        pluginId: "counter_tins",
        message: "At most 3 tins at the counter.",
      }),
    );
    const allowed = await counter.quote("allowed", 2);
    expect(allowed.pluginRuns).toEqual([
      expect.objectContaining({
        pluginId: "counter_tins",
        functionId: "limit",
        outcome: "passed",
      }),
    ]);

    Object.assign(evidence, {
      receipts: counter.receipts,
      plain,
      coded,
      second,
      tooMany,
      allowed,
    });
  } finally {
    writeEvidence("COUNTER_STAGES_ARTIFACT_DIR", "counter-stages", evidence);
    backend.close();
  }
}

class CounterDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "counter");
  }

  async publishPolicy() {
    return required(
      this.admin.publishPointOfSaleConfiguration({
        schemaVersion: "commerce.publish-point-of-sale-configuration.v1",
        merchantId,
        expectedRevision: null,
        publishedAt: NOW,
        publishedBy: "operator_manager",
        configuration: {
          configurationId: "pos_configuration_counter",
          organisationId,
          pantryLocationId: LOCATION,
          salesChannelId: CHANNEL,
          currency: "JPY",
          supportedItems: [{ variantId: SMALL_SENCHA, maxQuantityPerLine: 10 }],
          quoteTtlSeconds: 900,
          tax: { kind: "percentage", basisPoints: 1_000 },
          pickupReadyLeadTimeSeconds: 0,
          afterSalePolicy: {
            cancellationPolicyId: "cancellation_counter",
            refundPolicyId: "refund_counter",
            refundGovernance: { kind: "approval_required" },
          },
          presentationPolicy: {
            locale: "ja-JP",
            merchantDisplayName: "Pantry Cafe",
            termsPolicyId: "terms_counter",
            privacyPolicyId: "privacy_counter",
            supportContact: "support@example.test",
          },
        },
      }),
    );
  }

  createCode() {
    return this.edit(
      this.admin.createDiscount({
        ...this.editBase("create_counter10"),
        discountId: "discount_counter10",
        title: "Counter ten percent",
        method: { kind: "code", codes: ["COUNTER10"] },
        rule: {
          kind: "amount_off_order",
          value: { kind: "percentage", basisPoints: 1_000 },
        },
        conditions: {
          minimumSubtotal: null,
          startsAt: NOW,
          endsAt: null,
          usageLimit: 1,
          oncePerCustomer: false,
        },
      }),
    );
  }

  installTinLimit() {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase("install_counter_tins"),
        definition: tinLimit(),
        settings: { maxTins: 3 },
        expectedRevision: null,
      }),
    );
  }

  async ring(name: string, tins: number, discountCodes?: readonly string[]) {
    const snapshot = await required(this.admin.readSnapshot(merchantId));
    const command: CreateCommerceInPersonCheckoutV1 = {
      schemaVersion: "commerce.create-in-person-checkout.v1",
      merchantId,
      expectedMerchantRevision: snapshot.merchantRevision,
      idempotencyKey: `counter_${name}`,
      requestedAt: NOW,
      pantryLocationId: LOCATION,
      posConfigurationRevision: 1,
      operatorIdentity: "operator_barista",
      terminalAssignmentRevision: 1,
      buyer: { kind: "anonymous" },
      checkoutId: `checkout_counter_${name}`,
      lines: [
        {
          cartLineId: `cart_line_${name}`,
          checkoutLineId: `checkout_line_${name}`,
          source: { kind: "catalog", variantId: SMALL_SENCHA },
          quantity: { amount: tins, scale: 0, unit: "each" },
        },
      ],
      ...(discountCodes === undefined ? {} : { discountCodes }),
    };
    return this.edit(this.admin.createInPersonCheckout(clientInput(command)));
  }

  async quote(
    name: string,
    tins: number,
    discountCodes?: readonly string[],
  ): Promise<Checkout["lifecycle"]["quote"]> {
    const rung = await this.ring(name, tins, discountCodes);
    if (rung.outcome !== "applied")
      throw new Error(`${name} was not rung up: ${JSON.stringify(rung)}`);
    const sale = await required(
      this.admin.readCounterSale(merchantId, `checkout_counter_${name}`),
    );
    return sale.checkout.lifecycle.quote;
  }
}

function tinLimit(): PluginDefinition {
  return {
    pluginId: "counter_tins",
    version: 1,
    kind: "merchant",
    title: "Counter tins",
    purpose: "At most three tins in one counter sale.",
    requirements: {
      hookPoints: ["checkout.validate"],
      reads: [],
      commands: [],
      dependsOn: [],
    },
    contributions: {
      routes: [],
      pipelineSteps: [],
      entityTypes: [],
      settings: [
        { key: "maxTins", valueKind: "integer", description: "Tins at most" },
      ],
      functions: [
        {
          functionId: "limit",
          hookPoint: "checkout.validate",
          required: false,
          source: TIN_LIMIT,
        },
      ],
    },
    limits: {
      instructionBudget: 100,
      memoryBytes: 8 * 1024 * 1024,
      outputBytes: 16 * 1024,
    },
  };
}
