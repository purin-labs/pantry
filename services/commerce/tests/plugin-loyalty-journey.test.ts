// Plan 77 step 5: a loyalty plugin gives store credit, and an agent tries
// its draft first. A dry run of the draft handler shows the credit it would
// submit and changes nothing; a draft whose requirements do not name the
// command, or whose command has wrong fields, shows why the core would
// refuse it. Installed, the handler credits ¥300 at every third order of a
// signed-in buyer, in the order's currency; a guest's orders earn nothing,
// and a pass after a lost cursor credits nothing new. Mio pays part of her
// next order with the credit. The `goodwill` action credits an order's
// customer: a guest who gave an email has one too, and gets the credit when
// signing in with it; a wrong amount changes nothing. Set
// PLUGIN_LOYALTY_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommercePluginActionV1,
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
  jpy,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type EmailOutbox,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const THIRD_ORDER = `
function run(input) {
  const order = input.order;
  if (order === null || order.buyer.kind !== "identified" ||
      order.buyer.placedOrders % input.settings.every !== 0)
    return {};
  return { commands: [{
    kind: "credit_store_credit",
    orderId: order.id,
    amountMinor: input.settings.creditMinor,
    note: "Thank you for every third order",
  }] };
}`;

const GOODWILL = `
function run(input) {
  return { commands: [{
    kind: "credit_store_credit",
    orderId: input.input.order.id,
    amountMinor: input.input.amount_minor,
  }] };
}`;

const HANDLERS: readonly CommercePluginHandlerV1[] = [
  {
    handlerId: "third_order",
    eventKinds: ["order.created"],
    source: THIRD_ORDER,
  },
];

const ACTIONS: readonly CommercePluginActionV1[] = [
  {
    actionId: "goodwill",
    title: "Goodwill credit",
    inputs: [
      { key: "order", valueKind: "order", description: "The order" },
      { key: "amount_minor", valueKind: "integer", description: "The credit" },
    ],
    source: GOODWILL,
  },
];

function loyalty(commands: readonly string[]): PluginDefinition {
  return {
    pluginId: "loyalty",
    version: 1,
    kind: "merchant",
    title: "Loyalty",
    purpose: "Store credit at every third order, and goodwill credit.",
    requirements: {
      hookPoints: [],
      reads: [],
      commands: [...commands],
      dependsOn: [],
    },
    contributions: {
      routes: [],
      pipelineSteps: [],
      entityTypes: [],
      settings: [
        {
          key: "every",
          valueKind: "integer",
          description: "Orders per credit",
        },
        { key: "creditMinor", valueKind: "integer", description: "The credit" },
      ],
      functions: [],
    },
    limits: {
      instructionBudget: 100,
      memoryBytes: 8 * 1024 * 1024,
      outputBytes: 16 * 1024,
    },
  };
}

const SETTINGS = { every: 3, creditMinor: 300 };

it(
  "dry-runs a loyalty handler, then credits store credit from it and from an action",
  { timeout: 120_000 },
  pluginLoyalty,
);

async function pluginLoyalty(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer, emails, database } = backend;
    const staff = new LoyaltyDesk(admin);
    await staff.createTea();

    // The dry run of the draft handler shows the credit it would submit.
    const thirdOrder = {
      hookPoint: "handler",
      event: { kind: "order.created" },
      order: {
        id: "order_draft",
        buyer: { kind: "identified", customerReference: "c", placedOrders: 3 },
      },
    };
    const dryRuns = {
      accepted: await staff.dryRun(
        loyalty(["credit_store_credit"]),
        thirdOrder,
      ),
      unnamed: await staff.dryRun(loyalty([]), thirdOrder),
      badFields: await staff.dryRun(
        loyalty(["credit_store_credit"]),
        thirdOrder,
        -5,
      ),
    };
    expect(dryRuns).toMatchObject({
      accepted: {
        outcome: { kind: "returned" },
        commands: [
          { kind: "credit_store_credit", accepted: true, reason: null },
        ],
      },
      unnamed: {
        commands: [
          {
            accepted: false,
            reason: "The plugin's requirements do not name credit_store_credit",
          },
        ],
      },
      badFields: { commands: [{ accepted: false }] },
    });
    expect(await staff.storeCredit()).toEqual([]);

    expect(await staff.install()).toMatchObject({ outcome: "applied" });

    // Mio's third order earns ¥300; a guest's three orders earn nothing.
    const mioAccess = await signIn(buyer, emails, "mio@example.test");
    let visits = 0;
    const mio = () => Buyer.signedIn(buyer, `mio_${(visits += 1)}`, mioAccess);
    const tea = [catalogLine(SMALL_SENCHA)];
    await (await mio()).buyLines(tea);
    await (await mio()).buyLines(tea);
    expect(await staff.storeCredit()).toEqual([]);
    const third = await (await mio()).buyLines(tea);
    const guestOrders: string[] = [];
    for (let order = 1; order <= 3; order += 1)
      guestOrders.push(
        await (await Buyer.start(buyer, `guest_${order}`)).buyLines(tea),
      );
    expect(await staff.storeCredit()).toEqual([jpy(300)]);

    // A pass that reads the third order's event again credits nothing new.
    const events = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events;
    const thirdEvent = events.findIndex(
      (event) =>
        event.kind === "order.created" &&
        event.resources.some((resource) => resource.id === third),
    );
    const before = events[thirdEvent - 1]?.cursor;
    if (before === undefined)
      throw new Error("The third order has no earlier event");
    database
      .prepare(
        "UPDATE merchant_plugin_handler SET cursor = ? WHERE handler_id = 'third_order'",
      )
      .run(before);
    await backend.runDueWork();
    expect(await staff.storeCredit()).toEqual([jpy(300)]);

    // Mio pays part of her next order with the credit.
    const withCredit = await mio();
    withCredit.storeCredit = true;
    const quoted = await withCredit.quote(tea);
    expect(quoted.quote.storedValue?.tenders).toEqual([
      expect.objectContaining({ kind: "store_credit", amount: jpy(300) }),
    ]);

    // The goodwill action credits an order's customer: Mio's account grows,
    // and the guest's email customer gets an account of its own.
    const goodwill = await staff.goodwill("goodwill_mio", third, 200);
    expect(goodwill).toMatchObject({ outcome: "applied" });
    const guestGoodwill = await staff.goodwill(
      "goodwill_guest",
      guestOrders[0] ?? "",
      200,
    );
    expect(guestGoodwill).toMatchObject({ outcome: "applied" });
    expect(await staff.creditedTotals()).toEqual([500, 200]);
    // A wrong amount changes nothing.
    const wrongAmount = await staff.goodwill("goodwill_wrong", third, -1);
    expect(wrongAmount).toMatchObject({ outcome: "rejected" });
    expect(await staff.creditedTotals()).toEqual([500, 200]);

    Object.assign(evidence, {
      receipts: staff.receipts,
      dryRuns,
      storeCredit: await staff.storeCredit(),
      quotedTenders: quoted.quote.storedValue?.tenders,
      guestGoodwill,
      wrongAmount,
    });
  } finally {
    writeEvidence("PLUGIN_LOYALTY_ARTIFACT_DIR", "plugin-loyalty", evidence);
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
      schemaVersion: "commerce.request-customer-sign-in.v1",
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
          schemaVersion: "commerce.verify-customer-sign-in.v1",
          code,
        },
      ),
    )
  ).customerAccessToken;
}

class LoyaltyDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "plugin_loyalty");
  }

  dryRun(definition: PluginDefinition, input: unknown, creditMinor = 300) {
    return required(
      this.admin.runPluginFunction(merchantId, {
        schemaVersion: "commerce.run-plugin-function.v1",
        definition,
        functionId: "third_order",
        settings: { ...SETTINGS, creditMinor },
        input,
        handlers: HANDLERS,
      }),
    );
  }

  install() {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase("install_loyalty"),
        definition: loyalty(["credit_store_credit"]),
        settings: SETTINGS,
        handlers: HANDLERS,
        actions: ACTIONS,
        expectedRevision: null,
      }),
    );
  }

  goodwill(key: string, orderId: string, amountMinor: number) {
    return this.edit(
      this.admin.runPluginAction({
        merchantId,
        idempotencyKey: key,
        pluginId: "loyalty",
        actionId: "goodwill",
        input: { order: orderId, amount_minor: amountMinor },
      }),
    );
  }

  /** Everything credited to each store credit account, largest first. */
  async creditedTotals() {
    return (await required(this.admin.listStoredValueAccounts(merchantId)))
      .filter((account) => account.kind === "store_credit")
      .map((account) => account.credited.amountMinor)
      .sort((left, right) => right - left);
  }

  /** The balances of the merchant's store credit accounts. */
  async storeCredit() {
    return (await required(this.admin.listStoredValueAccounts(merchantId)))
      .filter((account) => account.kind === "store_credit")
      .map((account) => account.balance);
  }
}
