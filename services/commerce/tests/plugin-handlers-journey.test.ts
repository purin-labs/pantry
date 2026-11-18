// Plan 77 step 5: a merchant plugin's event handler and action. "Regulars"
// gives a signed-in buyer a one-use 10% code at their fifth order, and its
// `apology_discount` action gives an order's buyer a code of at most ¥1,000.
// Guest orders and later orders get no code; a pass after a lost handler
// cursor creates nothing new; the code takes 10% off the next order once. An
// action above the cap, or with a wrong input, changes nothing. A version
// whose requirements do not name the command has it refused, and the failure
// is an event. A key without the discounts scope cannot install the plugin
// or run its action. Set PLUGIN_HANDLERS_ARTIFACT_DIR to keep the run's
// evidence; the file repeats byte for byte for the same commit.
import { clientInput } from "./command-input.ts";
import {
  CommerceAdminClient,
  type CommercePluginActionV1,
  type CommercePluginHandlerV1,
  type CommercePluginSettingsV1,
  type CommerceStorefrontClient,
} from "@seams/commerce-client";
import type { PluginDefinition } from "@seams/commerce-contracts";
import { expect, it } from "vitest";

import {
  BASE_URL,
  Buyer,
  NOW,
  SERVICE_TOKEN,
  STOREFRONT,
  catalogLine,
  jpy,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type EmailOutbox,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const REGULARS = `
function run(input) {
  const order = input.order;
  if (order === null || order.buyer.kind !== "identified" ||
      order.buyer.placedOrders !== input.settings.regularAfter)
    return {};
  return { commands: [{
    kind: "create_discount",
    key: "regular_" + order.buyer.customerReference,
    title: "Thank you for five orders",
    code: "REGULAR-" + order.id.slice(-8).toUpperCase(),
    percentOff: 10,
    usageLimit: 1,
    oncePerCustomer: true,
  }] };
}`;

const APOLOGY = `
function run(input) {
  const amount = input.input.amount_minor;
  const cap = input.settings.apologyCapMinor;
  if (amount < 1 || amount > cap)
    return { refusals: [{ message: "An apology code is 1 to " + cap + " yen." }] };
  const order = input.input.order;
  return { commands: [{
    kind: "create_discount",
    key: "apology_" + order.id,
    title: "Sorry about your order",
    code: "SORRY-" + order.id.slice(-8).toUpperCase(),
    amountOff: { amountMinor: amount, currency: order.currency },
    usageLimit: 1,
    oncePerCustomer: true,
  }] };
}`;

const HANDLERS: readonly CommercePluginHandlerV1[] = [
  {
    handlerId: "thank_regulars",
    eventKinds: ["order.created"],
    source: REGULARS,
  },
];

const ACTIONS: readonly CommercePluginActionV1[] = [
  {
    actionId: "apology_discount",
    title: "Apology discount",
    inputs: [
      {
        key: "order",
        valueKind: "order",
        description: "The order to apologise for",
      },
      {
        key: "amount_minor",
        valueKind: "integer",
        description: "The amount off the next order, in yen",
      },
    ],
    source: APOLOGY,
  },
];

function regulars(
  version: number,
  commands: readonly string[],
): PluginDefinition {
  return {
    pluginId: "regulars",
    version,
    kind: "merchant",
    title: "Regulars",
    purpose:
      "A thank-you code at the fifth order, and apology codes for staff.",
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
          key: "regularAfter",
          valueKind: "integer",
          description: "The order that earns the code",
        },
        {
          key: "apologyCapMinor",
          valueKind: "integer",
          description: "The largest apology code",
        },
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

it(
  "lets a plugin give codes from an event handler and from a capped action",
  { timeout: 120_000 },
  pluginHandlers,
);

async function pluginHandlers(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer, emails, database } = backend;
    const staff = new PluginDesk(admin);
    await staff.createTea();

    // A key with settings:write alone cannot install a plugin that creates
    // discounts.
    const narrowKey = await issueKey(backend.fetch, [
      "settings:write",
      "settings:read",
    ]);
    const narrowInstall = await new PluginDesk(
      adminWith(backend.fetch, narrowKey),
    ).tryInstall(regulars(1, ["create_discount"]), {
      regularAfter: 5,
      apologyCapMinor: 1_000,
    });
    expect(narrowInstall).toBe(403);
    expect(
      await staff.install(
        regulars(1, ["create_discount"]),
        { regularAfter: 5, apologyCapMinor: 1_000 },
        null,
      ),
    ).toMatchObject({ outcome: "applied" });

    // Ana places four orders and a guest one: no code yet.
    // Each visit is a new session of the signed-in buyer, with its own cart.
    const anaAccess = await signIn(buyer, emails, "ana@example.test");
    let visits = 0;
    const ana = () => Buyer.signedIn(buyer, `ana_${(visits += 1)}`, anaAccess);
    const tea = [catalogLine(SMALL_SENCHA)];
    for (let order = 1; order <= 4; order += 1)
      await (await ana()).buyLines(tea);
    const guestOrderId = await (
      await Buyer.start(buyer, "guest")
    ).buyLines(tea);
    expect(await codes(admin)).toEqual([]);

    // The fifth order earns a one-use 10% code; the sixth does not.
    const fifth = await (await ana()).buyLines(tea);
    const regularCode = `REGULAR-${fifth.slice(-8).toUpperCase()}`;
    expect(await codes(admin)).toEqual([
      [regularCode, { kind: "percentage", basisPoints: 1_000 }, 1],
    ]);
    // Neither the sixth order nor a later move of the fifth gives another.
    await (await ana()).buyLines(tea);
    await staff.markReady(fifth);
    expect(await codes(admin)).toHaveLength(1);

    // A pass that reads the fifth order's event again, as after a lost
    // cursor, finds the code's receipt and creates nothing new.
    const events = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events;
    const fifthEvent = events.findIndex(
      (event) =>
        event.kind === "order.created" &&
        event.resources.some((resource) => resource.id === fifth),
    );
    const before = events[fifthEvent - 1]?.cursor;
    if (before === undefined)
      throw new Error("The fifth order has no earlier event");
    database
      .prepare(
        "UPDATE merchant_plugin_handler SET cursor = ? WHERE handler_id = 'thank_regulars'",
      )
      .run(before);
    await backend.runDueWork();
    expect(await codes(admin)).toHaveLength(1);
    expect((await staff.plugin())?.lastFailure).toBeNull();

    // The code takes 10% off Ana's next order, once.
    const withCode = await ana();
    withCode.discountCodes = [regularCode.toLowerCase()];
    const quoted = await withCode.quote(tea);
    expect(quoted.quote.totals).toMatchObject({
      discount: jpy(120),
      subtotal: jpy(1_080),
    });
    await withCode.pay(quoted);
    const again = await ana();
    again.discountCodes = [regularCode];
    expect(await again.tryQuote(tea)).toMatchObject({
      kind: "refused",
      error: { field: "discount.code.exhausted" },
    });

    // Staff give a ¥500 apology code for the guest's order; the call's own
    // receipt names the plugin's action, and a retry answers with it.
    const apology = await staff.act("apology_500", {
      order: guestOrderId,
      amount_minor: 500,
    });
    expect(apology).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "run_plugin_action",
        principal: {
          kind: "plugin",
          pluginId: "regulars",
          version: 1,
          source: "action",
          sourceId: "apology_discount",
        },
      },
    });
    expect(
      await staff.act("apology_500", {
        order: guestOrderId,
        amount_minor: 500,
      }),
    ).toEqual({
      ...apology,
      outcome: "replayed",
    });

    // Above the cap, or with a wrong input, the action changes nothing.
    const refusals = {
      aboveCap: await staff.act("apology_5000", {
        order: guestOrderId,
        amount_minor: 5_000,
      }),
      unknownOrder: await staff.act("apology_missing", {
        order: "order_missing",
        amount_minor: 500,
      }),
      wrongKind: await staff.act("apology_text", {
        order: guestOrderId,
        amount_minor: "five hundred",
      }),
      unknownInput: await staff.act("apology_extra", {
        order: guestOrderId,
        amount_minor: 500,
        note: "late",
      }),
    };
    expect(refusals).toMatchObject({
      aboveCap: {
        outcome: "rejected",
        error: {
          code: "action_refused",
          pluginId: "regulars",
          actionId: "apology_discount",
          message: "An apology code is 1 to 1000 yen.",
        },
      },
      unknownOrder: rejectedWith({ code: "resource_not_found", kind: "order" }),
      wrongKind: rejectedWith({ field: "input.amount_minor.valueKind" }),
      unknownInput: rejectedWith({ field: "input.note" }),
    });
    const afterActions = await codes(admin);
    expect(afterActions).toHaveLength(2);

    // A narrow key cannot run the action either.
    expect(
      await new PluginDesk(adminWith(backend.fetch, narrowKey)).tryAct({
        order: guestOrderId,
        amount_minor: 100,
      }),
    ).toBe(403);

    // Version 2 no longer names create_discount but still returns it: the
    // handler's command is refused and reported, and so is the action's.
    expect(
      await staff.install(
        regulars(2, []),
        { regularAfter: 1, apologyCapMinor: 1_000 },
        2,
      ),
    ).toMatchObject({ outcome: "applied" });
    const bo = await Buyer.signedIn(
      buyer,
      "bo",
      await signIn(buyer, emails, "bo@example.test"),
    );
    await bo.buyLines(tea);
    const refusedHandler = (await staff.plugin())?.lastFailure;
    expect(refusedHandler).toMatchObject({
      version: 2,
      hookPoint: "event.handler",
      functionId: "thank_regulars",
      reason: "refused",
      message: "The plugin's requirements do not name create_discount",
    });
    expect(
      await staff.act("apology_v2", { order: guestOrderId, amount_minor: 100 }),
    ).toMatchObject({
      outcome: "rejected",
      error: {
        code: "action_refused",
        message: "The plugin's requirements do not name create_discount",
      },
    });
    expect(await codes(admin)).toEqual(afterActions);

    const pluginEvents = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events
      .map((event) => event.kind)
      .filter(
        (kind) => kind.startsWith("plugin.") || kind.startsWith("discount."),
      );
    expect(pluginEvents).toEqual([
      "plugin.installed",
      "discount.created",
      "discount.created",
      "plugin.action_run",
      "plugin.installed",
      "plugin.function_failed",
      "plugin.function_failed",
    ]);

    Object.assign(evidence, {
      receipts: staff.receipts,
      narrowInstall,
      codes: afterActions,
      apology,
      refusals,
      refusedHandler,
      pluginEvents,
    });
  } finally {
    writeEvidence("PLUGIN_HANDLERS_ARTIFACT_DIR", "plugin-handlers", evidence);
    backend.close();
  }
}

type Fetch = Awaited<ReturnType<typeof startBackend>>["fetch"];

/** Each code with its value and use limit, in creation order. */
async function codes(admin: CommerceAdminClient) {
  return (await required(admin.listDiscounts(merchantId))).map((discount) => [
    discount.method.kind === "code" ? discount.method.codes[0] : null,
    discount.rule.value,
    discount.conditions.usageLimit,
  ]);
}

async function issueKey(
  fetch: Fetch,
  scopes: readonly string[],
): Promise<string> {
  const response = await fetch(
    `${BASE_URL}/v1/admin/merchants/${merchantId}/api-keys`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "Settings only", scopes }),
    },
  );
  return String(((await response.json()) as { key: unknown }).key);
}

function adminWith(fetch: Fetch, token: string): CommerceAdminClient {
  return new CommerceAdminClient({
    baseUrl: BASE_URL,
    serviceToken: token,
    fetch,
  });
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

class PluginDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "plugin_handlers");
  }

  install(
    definition: PluginDefinition,
    settings: CommercePluginSettingsV1,
    expectedRevision: number | null,
  ) {
    return this.edit(
      this.admin.installMerchantPlugin(
        clientInput(this.#install(definition, settings, expectedRevision)),
      ),
    );
  }

  /** The HTTP status of an installation that may be refused before it runs. */
  async tryInstall(
    definition: PluginDefinition,
    settings: CommercePluginSettingsV1,
  ): Promise<number | "ok"> {
    const result = await this.admin.installMerchantPlugin(
      clientInput(this.#install(definition, settings, null)),
    );
    return result.ok
      ? "ok"
      : "status" in result.error
        ? result.error.status
        : 0;
  }

  act(key: string, input: CommercePluginSettingsV1) {
    return this.edit(
      this.admin.runPluginAction(clientInput(this.#action(key, input))),
    );
  }

  async tryAct(input: CommercePluginSettingsV1): Promise<number | "ok"> {
    const result = await this.admin.runPluginAction(
      clientInput(this.#action("narrow", input)),
    );
    return result.ok
      ? "ok"
      : "status" in result.error
        ? result.error.status
        : 0;
  }

  async plugin() {
    return (await required(this.admin.listPlugins(merchantId))).plugins.find(
      (plugin) => plugin.pluginId === "regulars",
    );
  }

  #install(
    definition: PluginDefinition,
    settings: CommercePluginSettingsV1,
    expectedRevision: number | null,
  ) {
    return {
      schemaVersion: "underclerk.install-merchant-plugin.v1" as const,
      ...this.editBase(`install_${definition.version}`),
      definition,
      settings,
      handlers: HANDLERS,
      actions: ACTIONS,
      expectedRevision,
    };
  }

  #action(key: string, input: CommercePluginSettingsV1) {
    return {
      schemaVersion: "underclerk.run-plugin-action.v1" as const,
      merchantId,
      idempotencyKey: `plugin_handlers_${key}`,
      requestedAt: NOW,
      pluginId: "regulars",
      actionId: "apology_discount",
      input,
    };
  }
}
