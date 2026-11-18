// Plan 77 step 4: a merchant plugin adds fields to the catalog. "Cake notice"
// adds a `whole_cake` yes/no field to variants and a `notice_hours` number to
// products, and its delivery function reads them from each checkout line. Staff
// mark the large sencha as a whole cake and give the tea product 48 hours'
// notice: its pickup moves to 48 hours after the order, while the small tea
// keeps the lead time. A wrong kind, an unknown field, an unknown record and a
// stale revision are refused; clearing the field brings the lead time back. A
// second plugin does not see the first one's fields. Set
// PLUGIN_FIELDS_ARTIFACT_DIR to keep the run's evidence; the file repeats byte
// for byte for the same commit.
import type {
  CommerceAdminClient,
  CommercePluginFieldV1,
  CommercePluginSettingValueV1,
} from "@seams/commerce-client";
import type { PluginDefinition } from "@seams/commerce-contracts";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  PRODUCT,
  catalogLine,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { LARGE_SENCHA, OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const NOTICE = `
function run(input) {
  if (input.fulfillment.kind !== "pickup") return {};
  let hours = 0;
  for (const line of input.checkout.lines)
    if (line.variantFields.whole_cake === true)
      hours = Math.max(hours, line.productFields.notice_hours || 0);
  if (hours === 0) return {};
  return {
    earliestReadyAt: new Date(Date.parse(input.checkout.quotedAt) +
      hours * 3600000).toISOString(),
    message: "This cake needs " + hours + " hours' notice.",
  };
}`;

// Refuses a checkout if it can see any other plugin's field values.
const PEEK = `
function run(input) {
  const seen = input.checkout.lines.some((line) =>
    line.variantFields !== undefined || line.productFields !== undefined);
  return { refusals: seen ? [{ message: "Fields of another plugin." }] : [] };
}`;

const FIELDS: readonly CommercePluginFieldV1[] = [
  {
    entityType: "sellable_variant",
    key: "whole_cake",
    valueKind: "boolean",
    description: "A whole cake, made to order",
  },
  {
    entityType: "product",
    key: "notice_hours",
    valueKind: "integer",
    description: "Hours of notice for a whole cake of this product",
  },
];

function plugin(
  pluginId: string,
  hookPoint: "checkout.delivery" | "checkout.validate",
  source: string,
): PluginDefinition {
  return {
    pluginId,
    version: 1,
    kind: "merchant",
    title: pluginId,
    purpose: "Cake notice from fields that staff set on the catalog.",
    requirements: {
      hookPoints: [hookPoint],
      reads: [],
      commands: [],
      dependsOn: [],
    },
    contributions: {
      routes: [],
      pipelineSteps: [],
      entityTypes: [],
      settings: [],
      functions: [{ functionId: "run", hookPoint, required: false, source }],
    },
    limits: {
      instructionBudget: 100,
      memoryBytes: 8 * 1024 * 1024,
      outputBytes: 16 * 1024,
    },
  };
}

it(
  "lets a plugin add catalog fields that staff set and its functions read",
  { timeout: 90_000 },
  pluginFields,
);

async function pluginFields(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new FieldDesk(admin);
    await staff.createTea();
    expect(
      await staff.install(
        plugin("cake_notice", "checkout.delivery", NOTICE),
        FIELDS,
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(
      await staff.install(
        plugin("peeker", "checkout.validate", PEEK),
        undefined,
      ),
    ).toMatchObject({ outcome: "applied" });
    const readyAt = async (name: string, variantId: string) => {
      const shopper = await Buyer.start(buyer, `fields_${name}`);
      return (await shopper.quote([catalogLine(variantId)])).quote.pickup
        .readyAt;
    };
    const lead = await readyAt("before", LARGE_SENCHA);

    // Staff mark the large sencha as a whole cake and give the product 48
    // hours' notice; only the cake moves.
    expect(
      await staff.set("product", PRODUCT, { notice_hours: 48 }, null),
    ).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "set_plugin_field_values",
        resource: {
          kind: "plugin_field_values",
          id: `cake_notice:product:${PRODUCT}`,
          revision: 1,
        },
      },
    });
    expect(
      await staff.set(
        "sellable_variant",
        LARGE_SENCHA,
        { whole_cake: true },
        null,
      ),
    ).toMatchObject({ outcome: "applied" });
    const atNotice = new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString();
    expect(await readyAt("cake", LARGE_SENCHA)).toBe(atNotice);
    expect(await readyAt("tea", SMALL_SENCHA)).toBe(lead);

    // Values have the field's kind, name a field of that record's type, and
    // a record that exists, at its revision.
    const refusals = {
      kind: await staff.set(
        "sellable_variant",
        LARGE_SENCHA,
        { whole_cake: "yes" },
        1,
      ),
      unknownField: await staff.set(
        "sellable_variant",
        LARGE_SENCHA,
        { colour: "green" },
        1,
      ),
      wrongType: await staff.set("product", PRODUCT, { whole_cake: true }, 1),
      unknownRecord: await staff.set(
        "sellable_variant",
        "variant_missing",
        { whole_cake: true },
        null,
      ),
      stale: await staff.set(
        "sellable_variant",
        LARGE_SENCHA,
        { whole_cake: false },
        null,
      ),
    };
    expect(refusals).toMatchObject({
      kind: rejectedWith({ field: "pluginFields.whole_cake.valueKind" }),
      unknownField: rejectedWith({ field: "pluginFields.colour" }),
      wrongType: rejectedWith({ field: "pluginFields.whole_cake" }),
      unknownRecord: rejectedWith({ code: "resource_not_found" }),
      stale: rejectedWith({ code: "stale_resource_revision" }),
    });

    // The plugin's list names its fields; the values read back.
    const listed = (await required(admin.listPlugins(merchantId))).plugins;
    expect(
      listed.find((item) => item.pluginId === "cake_notice")?.fields,
    ).toEqual(FIELDS);
    expect(listed.find((item) => item.pluginId === "peeker")?.fields).toEqual(
      [],
    );
    const values = await required(
      admin.listPluginFieldValues(merchantId, "cake_notice"),
    );
    expect(values.records).toEqual([
      {
        entityType: "product",
        entityId: PRODUCT,
        revision: 1,
        values: { notice_hours: 48 },
      },
      {
        entityType: "sellable_variant",
        entityId: LARGE_SENCHA,
        revision: 1,
        values: { whole_cake: true },
      },
    ]);

    // Clearing the field brings the lead time back.
    expect(
      await staff.set(
        "sellable_variant",
        LARGE_SENCHA,
        { whole_cake: null },
        1,
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(await readyAt("cleared", LARGE_SENCHA)).toBe(lead);

    const pluginEvents = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("plugin."));
    expect(pluginEvents).toEqual([
      "plugin.installed",
      "plugin.installed",
      "plugin.fields_updated",
      "plugin.fields_updated",
      "plugin.fields_updated",
    ]);

    Object.assign(evidence, {
      receipts: staff.receipts,
      lead,
      atNotice,
      refusals,
      values,
      pluginEvents,
    });
  } finally {
    writeEvidence("PLUGIN_FIELDS_ARTIFACT_DIR", "plugin-fields", evidence);
    backend.close();
  }
}

class FieldDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "plugin_fields");
  }

  install(
    definition: PluginDefinition,
    fields: readonly CommercePluginFieldV1[] | undefined,
  ) {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase(`install_${definition.pluginId}`),
        definition,
        settings: {},
        ...(fields === undefined ? {} : { fields }),
        expectedRevision: null,
      }),
    );
  }

  set(
    entityType: CommercePluginFieldV1["entityType"],
    entityId: string,
    values: Readonly<Record<string, CommercePluginSettingValueV1 | null>>,
    expectedRevision: number | null,
  ) {
    return this.edit(
      this.admin.setPluginFieldValues({
        ...this.editBase(`set_${entityId}_${this.step}`),
        pluginId: "cake_notice",
        entityType,
        entityId,
        values,
        expectedRevision,
      }),
    );
  }
}
