// Plan 77 step 5: a merchant plugin keeps its own field values up to date
// from an event handler. "Limited edition" adds a `remaining` count to
// variants: its checkout function refuses more than the count, and its
// handler counts each order down with `set_plugin_field_values`. Staff set
// three boxes; two and then one sell, and the edition is sold out. A pass
// after a lost cursor does not count an order twice. Staff restock, and a
// buyer gets the next one. A key without catalog:write cannot install the
// plugin. Set PLUGIN_LIMITED_EDITION_ARTIFACT_DIR to keep the run's
// evidence; the file repeats byte for byte for the same commit.
import { clientInput } from "./command-input.ts";
import {
  CommerceAdminClient,
  type CommercePluginFieldV1,
  type CommercePluginHandlerV1,
} from "@purin-labs/commerce-client";
import type { PluginDefinition } from "@purin-labs/commerce-contracts";
import { expect, it } from "vitest";

import {
  BASE_URL,
  Buyer,
  NOW,
  SERVICE_TOKEN,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const LIMIT = `
function run(input) {
  const refusals = [];
  for (const line of input.checkout.lines) {
    const left = line.variantFields.remaining;
    if (left === undefined) continue;
    if (left === 0) refusals.push({ message: "This edition is sold out." });
    else if (line.quantity > left)
      refusals.push({ message: "Only " + left + " left of this edition." });
  }
  return { refusals };
}`;

const COUNT_DOWN = `
function run(input) {
  const order = input.order;
  if (order === null) return {};
  const line = order.lines.find((item) => item.variantFields.remaining !== undefined);
  if (line === undefined) return {};
  return { commands: [{
    kind: "set_plugin_field_values",
    entityType: "sellable_variant",
    entityId: line.variantId,
    values: { remaining: Math.max(0, line.variantFields.remaining - line.quantity) },
  }] };
}`;

const FIELDS: readonly CommercePluginFieldV1[] = [
  {
    entityType: "sellable_variant",
    key: "remaining",
    valueKind: "integer",
    description: "Boxes left of a limited edition",
  },
];

const HANDLERS: readonly CommercePluginHandlerV1[] = [
  {
    handlerId: "count_down",
    eventKinds: ["order.created"],
    source: COUNT_DOWN,
  },
];

const EDITION: PluginDefinition = {
  pluginId: "limited_edition",
  version: 1,
  kind: "merchant",
  title: "Limited edition",
  purpose:
    "Sells at most the boxes that staff set, and counts each order down.",
  requirements: {
    hookPoints: ["checkout.validate"],
    reads: [],
    commands: ["set_plugin_field_values"],
    dependsOn: [],
  },
  contributions: {
    routes: [],
    pipelineSteps: [],
    entityTypes: [],
    settings: [],
    functions: [
      {
        functionId: "limit",
        hookPoint: "checkout.validate",
        required: false,
        source: LIMIT,
      },
    ],
  },
  limits: {
    instructionBudget: 100,
    memoryBytes: 8 * 1024 * 1024,
    outputBytes: 16 * 1024,
  },
};

it(
  "lets a plugin count a limited edition down from its event handler",
  { timeout: 120_000 },
  limitedEdition,
);

async function limitedEdition(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer, database } = backend;
    const staff = new EditionDesk(admin);
    await staff.createTea();

    // A key that cannot write the catalog cannot install a plugin that
    // writes field values.
    const key = await issueKey(backend.fetch, [
      "settings:write",
      "settings:read",
    ]);
    const narrow = await new CommerceAdminClient({
      baseUrl: BASE_URL,
      serviceToken: key,
      fetch: backend.fetch,
    }).installMerchantPlugin(clientInput(staff.installCommand("narrow")));
    expect(
      narrow.ok ? "ok" : "status" in narrow.error ? narrow.error.status : 0,
    ).toBe(403);
    expect(await staff.install()).toMatchObject({ outcome: "applied" });
    expect(await staff.setRemaining(3, null)).toMatchObject({
      outcome: "applied",
    });

    let visits = 0;
    const shopper = () => Buyer.start(buyer, `edition_${(visits += 1)}`);
    const boxes = (quantity: number) => [
      { kind: "catalog" as const, variantId: SMALL_SENCHA, quantity },
    ];

    // Two boxes sell, then a buyer cannot have two of the one left.
    await (await shopper()).buyLines(boxes(2));
    expect(await staff.remaining()).toEqual({
      revision: 2,
      values: { remaining: 1 },
    });
    const tooMany = await (await shopper()).tryQuote(boxes(2));
    expect(tooMany).toMatchObject({
      kind: "refused",
      error: {
        code: "checkout_refused",
        message: "Only 1 left of this edition.",
      },
    });
    const last = await (await shopper()).buyLines(boxes(1));
    expect(await staff.remaining()).toEqual({
      revision: 3,
      values: { remaining: 0 },
    });
    const soldOut = await (await shopper()).tryQuote(boxes(1));
    expect(soldOut).toMatchObject({
      kind: "refused",
      error: { message: "This edition is sold out." },
    });

    // A pass that reads the last order's event again, as after a lost
    // cursor, answers with the first count and changes nothing.
    const events = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events;
    const lastEvent = events.findIndex(
      (event) =>
        event.kind === "order.created" &&
        event.resources.some((resource) => resource.id === last),
    );
    const before = events[lastEvent - 1]?.cursor;
    if (before === undefined)
      throw new Error("The last order has no earlier event");
    database
      .prepare(
        "UPDATE merchant_plugin_handler SET cursor = ? WHERE handler_id = 'count_down'",
      )
      .run(before);
    await backend.runDueWork();
    expect(await staff.remaining()).toEqual({
      revision: 3,
      values: { remaining: 0 },
    });
    expect((await staff.plugin())?.lastFailure).toBeNull();

    // Staff restock two boxes, and the next buyer gets one.
    expect(await staff.setRemaining(2, 3)).toMatchObject({
      outcome: "applied",
    });
    await (await shopper()).buyLines(boxes(1));
    expect(await staff.remaining()).toEqual({
      revision: 5,
      values: { remaining: 1 },
    });

    const pluginEvents = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("plugin."));
    expect(pluginEvents).toEqual([
      "plugin.installed",
      "plugin.fields_updated",
      "plugin.fields_updated",
      "plugin.fields_updated",
      "plugin.fields_updated",
      "plugin.fields_updated",
    ]);

    Object.assign(evidence, {
      receipts: staff.receipts,
      tooMany,
      soldOut,
      values: await required(
        admin.listPluginFieldValues(merchantId, "limited_edition"),
      ),
      pluginEvents,
    });
  } finally {
    writeEvidence(
      "PLUGIN_LIMITED_EDITION_ARTIFACT_DIR",
      "plugin-limited-edition",
      evidence,
    );
    backend.close();
  }
}

async function issueKey(
  fetch: Awaited<ReturnType<typeof startBackend>>["fetch"],
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

class EditionDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "limited_edition");
  }

  installCommand(name: string) {
    return {
      schemaVersion: "underclerk.install-merchant-plugin.v1" as const,
      ...this.editBase(`install_${name}`),
      definition: EDITION,
      settings: {},
      fields: FIELDS,
      handlers: HANDLERS,
      expectedRevision: null,
    };
  }

  install() {
    return this.edit(
      this.admin.installMerchantPlugin(
        clientInput(this.installCommand("edition")),
      ),
    );
  }

  setRemaining(remaining: number, expectedRevision: number | null) {
    return this.edit(
      this.admin.setPluginFieldValues({
        ...this.editBase(`remaining_${this.step}`),
        pluginId: "limited_edition",
        entityType: "sellable_variant",
        entityId: SMALL_SENCHA,
        values: { remaining },
        expectedRevision,
      }),
    );
  }

  async remaining() {
    const record = (
      await required(
        this.admin.listPluginFieldValues(merchantId, "limited_edition"),
      )
    ).records.find((item) => item.entityId === SMALL_SENCHA);
    return record === undefined
      ? undefined
      : { revision: record.revision, values: record.values };
  }

  async plugin() {
    return (await required(this.admin.listPlugins(merchantId))).plugins.find(
      (plugin) => plugin.pluginId === "limited_edition",
    );
  }
}
