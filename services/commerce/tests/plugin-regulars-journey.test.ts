// Plan 77 step 5, the exit journey's regular: a merchant plugin marks a
// signed-in buyer as a regular at her fifth order and gives her a one-use
// 10% code, in one run. The plugin names the customer by the order and never
// holds a customer id; its `is_regular` action reads the mark back from any
// of her orders as `customerFields`. Its checkout rule sells the large tin
// to regulars only: it reads the mark on the buyer as the checkout's
// `customerFields`, so Mio cannot buy the tin before her fifth order, can
// after it, and a guest never can. A plugin cannot keep free text about a
// person: a text field on customers is refused. When staff erase her, the
// mark goes too. Set PLUGIN_REGULARS_ARTIFACT_DIR to keep the run's
// evidence; the file repeats byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommercePluginActionV1,
  CommercePluginFieldV1,
  CommercePluginHandlerV1,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";
import type { PluginDefinition } from "@purin-labs/commerce-contracts";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  STOREFRONT,
  catalogLine,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type EmailOutbox,
  type Evidence,
} from "./journey-support.ts";
import { LARGE_SENCHA, OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const FIFTH_ORDER = `
function run(input) {
  const order = input.order;
  if (order === null || order.buyer.kind !== "identified" ||
      order.buyer.placedOrders !== 5) return {};
  return { commands: [
    { kind: "set_plugin_field_values", entityType: "customer",
      orderId: order.id, values: { regular: true } },
    { kind: "create_discount", key: "regular_" + order.id,
      title: "Thank you for coming back", code: "REGULAR-FIVE",
      percentOff: 10, usageLimit: 1 },
  ] };
}`;

const IS_REGULAR = `
function run(input) {
  return { refusals: [{ message:
    input.input.order.customerFields.regular === true
      ? "A regular" : "Not yet a regular" }] };
}`;

const REGULARS_ONLY = `
function run(input) {
  if (input.checkout.customerFields.regular === true) return { refusals: [] };
  return { refusals: input.checkout.lines
    .filter((line) => input.settings.regularsOnly.includes(line.variantId))
    .map((line) => ({ message: line.title + " is for regulars only." })) };
}`;

const HANDLERS: readonly CommercePluginHandlerV1[] = [
  {
    handlerId: "fifth_order",
    eventKinds: ["order.created"],
    source: FIFTH_ORDER,
  },
];

const ACTIONS: readonly CommercePluginActionV1[] = [
  {
    actionId: "is_regular",
    title: "Is the buyer a regular?",
    inputs: [{ key: "order", valueKind: "order", description: "An order" }],
    source: IS_REGULAR,
  },
];

const REGULAR: CommercePluginFieldV1 = {
  entityType: "customer",
  key: "regular",
  valueKind: "boolean",
  description: "A regular buyer",
};

it(
  "marks a buyer as a regular at her fifth order and forgets it when she is erased",
  { timeout: 120_000 },
  pluginRegulars,
);

async function pluginRegulars(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer, emails } = backend;
    const staff = new RegularsDesk(admin);
    await staff.createTea();

    // 1. No free text about a person.
    const note = await staff.install([
      { ...REGULAR, key: "note", valueKind: "text" },
    ]);
    expect(note.outcome).toBe("rejected");
    expect(await staff.install([REGULAR])).toMatchObject({
      outcome: "applied",
    });

    // 2. Four orders: not yet a regular, and no code.
    const access = await signIn(buyer, emails, "mio@example.test");
    let visits = 0;
    const mio = () => Buyer.signedIn(buyer, `mio_${(visits += 1)}`, access);
    const tea = [catalogLine(SMALL_SENCHA)];
    const orders: string[] = [];
    for (let order = 1; order <= 4; order += 1)
      orders.push(await (await mio()).buyLines(tea));
    expect(await staff.isRegular("before", orders[3] ?? "")).toBe(
      "Not yet a regular",
    );
    expect(await staff.codes()).toEqual([]);
    const tin = [catalogLine(LARGE_SENCHA)];
    const early = await (await mio()).tryQuote(tin);
    expect(early).toMatchObject({
      kind: "refused",
      error: {
        code: "checkout_refused",
        pluginId: "regulars",
        message: expect.stringMatching(/is for regulars only\.$/u),
      },
    });

    // 3. The fifth order marks her and gives one code.
    orders.push(await (await mio()).buyLines(tea));
    expect(await staff.codes()).toEqual(["REGULAR-FIVE"]);
    const marked = await staff.customerValues();
    expect(marked).toEqual([
      {
        entityType: "customer",
        entityId: expect.stringMatching(/^customer_/),
        revision: 1,
        values: { regular: true },
      },
    ]);
    // Any of her orders reads the mark; a guest's does not.
    const guest = await (
      await Buyer.start(buyer, "regulars_guest")
    ).buyLines(tea);
    const reads = {
      fifth: await staff.isRegular("fifth", orders[4] ?? ""),
      first: await staff.isRegular("first", orders[0] ?? ""),
      guest: await staff.isRegular("guest", guest),
    };
    expect(reads).toEqual({
      fifth: "A regular",
      first: "A regular",
      guest: "Not yet a regular",
    });
    // Now she may buy the large tin; a guest still may not.
    const tinOrder = await (await mio()).buyLines(tin);
    const guestTin = await (
      await Buyer.start(buyer, "regulars_guest_tin")
    ).tryQuote(tin);
    expect({ tinOrder, guestTin }).toMatchObject({
      tinOrder: expect.stringMatching(/^order_/u),
      guestTin: { kind: "refused", error: { code: "checkout_refused" } },
    });

    // 4. Staff erase her: the mark goes with her.
    const customerId = marked[0]?.entityId ?? "";
    expect(await staff.erase(customerId)).toMatchObject({
      outcome: "applied",
    });
    expect(await staff.customerValues()).toEqual([]);
    expect(await staff.isRegular("erased", orders[4] ?? "")).toBe(
      "Not yet a regular",
    );

    Object.assign(evidence, {
      note: note.outcome === "rejected" ? note.error : null,
      regularsOnly: {
        beforeFifth: early.kind === "refused" ? early.error : null,
        guest: guestTin.kind === "refused" ? guestTin.error : null,
      },
      codes: await staff.codes(),
      reads,
      receipts: staff.receipts,
    });
  } finally {
    writeEvidence("PLUGIN_REGULARS_ARTIFACT_DIR", "plugin-regulars", evidence);
    backend.close();
  }
}

async function signIn(
  buyer: CommerceStorefrontClient,
  emails: EmailOutbox,
  email: string,
): Promise<string> {
  const challenge = await required(
    buyer.requestCustomerSignIn(merchantId, STOREFRONT, {
      schemaVersion: "underclerk.request-customer-sign-in.v1",
      email,
    }),
  );
  const code = /\b(\d{6})\b/.exec(emails.sent.at(-1)?.text ?? "")?.[1];
  if (code === undefined) throw new Error("The sign-in email has no code");
  return (
    await required(
      buyer.verifyCustomerSignIn(
        merchantId,
        STOREFRONT,
        challenge.challengeId,
        {
          schemaVersion: "underclerk.verify-customer-sign-in.v1",
          code,
        },
      ),
    )
  ).customerAccessToken;
}

class RegularsDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "plugin_regulars");
  }

  install(fields: readonly CommercePluginFieldV1[]) {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase(`install_regulars_${fields[0]?.key ?? ""}`),
        definition: regulars(),
        settings: { regularsOnly: [LARGE_SENCHA] },
        fields,
        handlers: HANDLERS,
        actions: ACTIONS,
        expectedRevision: null,
      }),
    );
  }

  /** The `is_regular` action's answer, which it gives as a refusal. */
  async isRegular(key: string, orderId: string): Promise<string> {
    const result = await this.admin.runPluginAction({
      merchantId,
      idempotencyKey: `is_regular_${key}`,
      pluginId: "regulars",
      actionId: "is_regular",
      input: { order: orderId },
    });
    if (
      !result.ok ||
      result.value.outcome !== "rejected" ||
      result.value.error.code !== "action_refused"
    )
      throw new Error(`is_regular gave ${JSON.stringify(result)}`);
    return result.value.error.message;
  }

  async customerValues() {
    return (
      await required(this.admin.listPluginFieldValues(merchantId, "regulars"))
    ).records.filter((record) => record.entityType === "customer");
  }

  async codes(): Promise<string[]> {
    return (await required(this.admin.listDiscounts(merchantId)))
      .flatMap((discount) =>
        discount.method.kind === "code" ? [...discount.method.codes] : [],
      )
      .sort();
  }

  async erase(customerId: string) {
    const customer = await required(
      this.admin.readCustomer(merchantId, customerId),
    );
    return this.edit(
      this.admin.eraseCustomer({
        ...this.editBase(`erase_${customerId}`),
        customerId,
        expectedRevision: customer.revision,
        reason: "Customer asked to be forgotten",
      }),
    );
  }
}

function regulars(): PluginDefinition {
  return {
    pluginId: "regulars",
    version: 1,
    kind: "merchant",
    title: "Regulars",
    purpose:
      "A buyer's fifth order makes her a regular, with a thank-you code.",
    requirements: {
      hookPoints: ["checkout.validate"],
      reads: [],
      commands: ["set_plugin_field_values", "create_discount"],
      dependsOn: [],
    },
    contributions: {
      routes: [],
      pipelineSteps: [],
      entityTypes: [],
      settings: [
        {
          key: "regularsOnly",
          valueKind: "text_list",
          description: "Variants that only regulars may buy",
        },
      ],
      functions: [
        {
          functionId: "regulars_only",
          hookPoint: "checkout.validate",
          required: false,
          source: REGULARS_ONLY,
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
