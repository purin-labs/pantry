// Plan 77 step 4: an agent writes a merchant plugin for the requirement "a
// whole cake needs 48 hours' notice, and a buyer can buy at most two boxes of
// a limited edition". It runs the draft function on an input, previews it
// over the merchant's recent checkouts, and installs it. Checkout then refuses
// with the plugin's message and records each run on the quote; a whole cake
// for a pickup that the buyer chose 48 hours ahead passes, and a refresh
// keeps that time. A version with
// an endless loop is stopped by its budget, the checkout goes on, each
// failure is an event, and the plugin pauses after three failures. A fixed
// version keeps the plugin paused until staff resume it. Another merchant
// has no plugin.
// Set MERCHANT_PLUGIN_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommercePluginSettingsV1,
} from "@purin-labs/commerce-client";
import type { PluginDefinition } from "@purin-labs/commerce-contracts";
import { expect, it } from "vitest";

import { readCheckout } from "../src/checkout-persistence.ts";
import {
  Buyer,
  NOW,
  catalogLine,
  merchantId,
  organisationId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { LARGE_SENCHA, OrderDesk, SMALL_SENCHA } from "./order-desk.ts";
import { TransitionMatrix } from "./transition-matrix.ts";

const LIMITED = "variant_tea_small_hojicha";
const SECOND_MERCHANT = "merchant_plugin_other";

const RULES = `
function run(input) {
  const settings = input.settings;
  const checkout = input.checkout;
  const notice = Date.parse(checkout.readyBy) - Date.parse(checkout.quotedAt);
  const refusals = [];
  for (const line of checkout.lines) {
    if (settings.limitedVariantIds.includes(line.variantId) &&
        line.quantity > settings.maxLimitedBoxes)
      refusals.push({ message: "A buyer can buy at most " +
        settings.maxLimitedBoxes + " boxes of " + line.title + "." });
    if (settings.wholeCakeVariantIds.includes(line.variantId) &&
        notice < settings.noticeHours * 3600000)
      refusals.push({ message: line.title + " needs " +
        settings.noticeHours + " hours' notice." });
  }
  return { refusals };
}
`;

const SETTINGS: CommercePluginSettingsV1 = {
  limitedVariantIds: [LIMITED],
  maxLimitedBoxes: 2,
  wholeCakeVariantIds: [LARGE_SENCHA],
  noticeHours: 48,
};

function cakeRules(version: number, source: string): PluginDefinition {
  return {
    pluginId: "cake_rules",
    version,
    kind: "merchant",
    title: "Cake rules",
    purpose:
      "Whole cakes need 48 hours' notice, and a buyer buys at most two boxes of a limited edition.",
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
        {
          key: "limitedVariantIds",
          valueKind: "text_list",
          description: "Variants sold as a limited edition",
        },
        {
          key: "maxLimitedBoxes",
          valueKind: "integer",
          description: "Boxes of a limited edition for one buyer",
        },
        {
          key: "wholeCakeVariantIds",
          valueKind: "text_list",
          description: "Variants that are whole cakes",
        },
        {
          key: "noticeHours",
          valueKind: "integer",
          description: "Hours of notice for a whole cake",
        },
      ],
      functions: [
        {
          functionId: "check_cart",
          hookPoint: "checkout.validate",
          required: false,
          source,
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

it(
  "installs an agent's checkout rule, refuses with its message, and pauses it after three failures",
  { timeout: 90_000 },
  merchantPlugin,
);

async function merchantPlugin(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  const matrix = new TransitionMatrix(["plugin"], {
    "plugin * resume": "plugin-journey.test.ts resumes a built-in plugin",
    "plugin active pause": "plugin-journey.test.ts pauses an active plugin",
    "plugin paused pause": "plugin-journey.test.ts pauses a paused plugin",
    "plugin * auto_pause":
      "only a failure report asks for auto_pause, and only for an active plugin",
  });
  try {
    const { admin, buyer, database } = backend;
    const staff = new MerchantPluginDesk(admin);
    await staff.createTea();

    // Earlier orders: one with three boxes of the limited edition.
    const greedy = await Buyer.start(buyer, "rules_greedy");
    await greedy.buyLines([{ ...catalogLine(LIMITED), quantity: 3 }]);
    const modest = await Buyer.start(buyer, "rules_modest");
    await modest.buyLines([catalogLine(SMALL_SENCHA)]);

    // The agent runs its draft on an input of its own.
    const draft = cakeRules(1, RULES);
    const dryRun = await required(
      admin.runPluginFunction(merchantId, {
        schemaVersion: "underclerk.run-plugin-function.v1",
        definition: draft,
        functionId: "check_cart",
        settings: SETTINGS,
        input: {
          hookPoint: "checkout.validate",
          checkout: {
            quotedAt: NOW,
            readyBy: NOW,
            lines: [{ variantId: LIMITED, title: "Hojicha", quantity: 3 }],
          },
        },
      }),
    );
    expect(dryRun.outcome).toEqual({
      kind: "returned",
      output: {
        refusals: [{ message: "A buyer can buy at most 2 boxes of Hojicha." }],
      },
    });

    // The preview over recent checkouts names the order it would refuse.
    const preview = await required(
      admin.previewMerchantPlugin(merchantId, {
        schemaVersion: "underclerk.preview-merchant-plugin.v1",
        definition: draft,
        settings: SETTINGS,
      }),
    );
    expect(preview.checkouts).toBe(2);
    expect(preview.failed).toEqual([]);
    expect(preview.refused).toEqual([
      {
        checkoutId: expect.any(String),
        functionId: "check_cart",
        messages: [expect.stringMatching(/^A buyer can buy at most 2 boxes/u)],
      },
    ]);

    // The install: checkout now refuses three boxes and a whole cake with
    // the plugin's own words, and records the run on a quote it passes.
    expect(await staff.install(draft, null)).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "install_merchant_plugin",
        resource: { kind: "plugin", id: "cake_rules", revision: 2 },
      },
    });
    const kai = await Buyer.start(buyer, "rules_kai");
    const tooMany = await kai.tryQuote([
      { ...catalogLine(LIMITED), quantity: 3 },
    ]);
    expect(tooMany).toMatchObject({
      kind: "refused",
      error: {
        code: "checkout_refused",
        pluginId: "cake_rules",
        message: expect.stringMatching(/^A buyer can buy at most 2 boxes/u),
      },
    });
    const cake = await Buyer.start(buyer, "rules_cake");
    expect(await cake.tryQuote([catalogLine(LARGE_SENCHA)])).toMatchObject({
      kind: "refused",
      error: {
        code: "checkout_refused",
        message: expect.stringMatching(/needs 48 hours' notice\.$/u),
      },
    });
    // The buyer chooses the pickup time: 24 hours ahead is refused by the
    // plugin, a time before the shop's lead time by the core, and 48 hours
    // ahead passes. A refresh keeps the chosen time.
    const hours = (count: number) =>
      new Date(Date.parse(NOW) + count * 3_600_000).toISOString();
    const pickups: Record<string, unknown> = {};
    for (const [label, at] of [
      ["tomorrow", hours(24)],
      ["now", NOW],
      ["in two days", hours(48)],
    ] as const) {
      const chooser = await Buyer.start(buyer, `rules_pickup_${label.length}`);
      chooser.pickupAt = at;
      const quoted = await chooser.tryQuote([catalogLine(LARGE_SENCHA)]);
      pickups[label] =
        quoted.kind === "quoted" ? quoted.checkout.quote.pickup : quoted.error;
      if (label === "in two days" && quoted.kind === "quoted") {
        const refreshed = await chooser.refresh(quoted.checkout, [
          catalogLine(LARGE_SENCHA),
        ]);
        pickups.refreshed = refreshed.quote.pickup;
      }
    }
    expect(pickups).toMatchObject({
      tomorrow: { code: "checkout_refused", pluginId: "cake_rules" },
      now: {
        code: "resource_relationship_invalid",
        field: "checkout.pickupAt",
      },
      "in two days": { readyAt: hours(48) },
      refreshed: { readyAt: hours(48) },
    });
    const two = await Buyer.start(buyer, "rules_two");
    const twoBoxes = await two.quote([
      { ...catalogLine(LIMITED), quantity: 2 },
    ]);
    const quotedRuns = staff.runsOf(database, twoBoxes.checkoutId);
    expect(quotedRuns).toMatchObject([
      {
        pluginId: "cake_rules",
        version: 1,
        functionId: "check_cart",
        outcome: "passed",
      },
    ]);
    // The placed order keeps the same run, so a replay gets the same output.
    await two.pay(twoBoxes);
    expect(staff.runsOf(database, twoBoxes.checkoutId)).toEqual(quotedRuns);

    // A version cannot change once created, and cannot go back.
    expect(
      await staff.install(cakeRules(1, `${RULES}\n// changed`), 2),
    ).toMatchObject(rejectedWith({ field: "plugin.version" }));

    // Version 2 loops forever. Its budget stops it, the checkout goes on,
    // and after three failures in a row the plugin pauses.
    const loop = cakeRules(2, "function run(input) { while (true) {} }");
    const budget = await required(
      admin.runPluginFunction(merchantId, {
        schemaVersion: "underclerk.run-plugin-function.v1",
        definition: loop,
        functionId: "check_cart",
        settings: SETTINGS,
        input: { hookPoint: "checkout.validate", checkout: { lines: [] } },
      }),
    );
    expect(budget).toMatchObject({
      outcome: { kind: "failed", reason: "budget" },
      polls: 100,
    });
    expect(await staff.install(loop, 2)).toMatchObject({ outcome: "applied" });
    const skipped: string[] = [];
    for (const name of ["rules_ana", "rules_ben", "rules_cai"]) {
      const looping = await Buyer.start(buyer, name);
      const quote = await looping.quote([catalogLine(SMALL_SENCHA)]);
      skipped.push(
        ...staff.runsOf(database, quote.checkoutId).map((run) => run.outcome),
      );
    }
    expect(skipped).toEqual(["skipped", "skipped", "skipped"]);
    // Each failure is a plugin.function_failed event; the third pauses the
    // plugin, and its list entry names the last failure.
    expect(await staff.plugin("cake_rules")).toMatchObject({
      state: "paused",
      revision: 4,
      version: 2,
      lastFailure: {
        version: 2,
        functionId: "check_cart",
        reason: "budget",
        failuresInARow: 3,
      },
    });
    matrix.observed(
      "plugin",
      "active",
      "auto_pause",
      "paused by three failures in a row",
    );
    // A fixed version does not resume the plugin: it stays paused, and no
    // checkout runs it, until staff resume it.
    expect(await staff.install(cakeRules(3, RULES), 4)).toMatchObject({
      outcome: "applied",
    });
    expect(await staff.plugin("cake_rules")).toMatchObject({
      state: "paused",
      revision: 5,
      version: 3,
    });
    const after = await Buyer.start(buyer, "rules_dee");
    const unchecked = await after.quote([
      { ...catalogLine(LIMITED), quantity: 3 },
    ]);
    expect(staff.runsOf(database, unchecked.checkoutId)).toEqual([]);

    // A built-in plugin cannot be removed; the merchant plugin can, and a
    // removed plugin takes no further change.
    matrix.check(
      "plugin",
      "active",
      "remove",
      await staff.remove("discounts", 1),
    );
    matrix.check(
      "plugin",
      "paused",
      "remove",
      await staff.remove("cake_rules", 5),
    );
    for (const event of ["pause", "remove"] as const)
      matrix.check(
        "plugin",
        "removed",
        event,
        await (event === "pause"
          ? staff.pause("cake_rules", 6)
          : staff.remove("cake_rules", 6)),
      );
    matrix.check(
      "plugin",
      "removed",
      "resume",
      await staff.resume("cake_rules", 6),
    );

    // Another merchant has only the built-in plugins.
    await required(
      admin.provisionMerchant({
        schemaVersion: "underclerk.provision-merchant.v2",
        externalReference: organisationId,
        merchantId: SECOND_MERCHANT,
        createdAt: NOW,
      }),
    );
    expect(
      (await required(admin.listPlugins(SECOND_MERCHANT))).plugins.some(
        (plugin) => plugin.kind === "merchant",
      ),
    ).toBe(false);
    expect(await staff.pluginEvents()).toEqual([
      "plugin.installed",
      "plugin.installed",
      "plugin.function_failed",
      "plugin.function_failed",
      "plugin.function_failed",
      "plugin.paused",
      "plugin.installed",
      "plugin.removed",
    ]);

    const report = matrix.report();
    expect(report.unexplained).toEqual([]);
    expect(report.stalePatterns).toEqual([]);
    Object.assign(evidence, {
      receipts: staff.receipts,
      dryRun,
      preview: { ...preview, refused: preview.refused.length },
      quotedRuns,
      pickups,
      budget,
      skipped,
      matrix: report,
    });
  } finally {
    writeEvidence("MERCHANT_PLUGIN_ARTIFACT_DIR", "merchant-plugin", evidence);
    backend.close();
  }
}

class MerchantPluginDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "merchant_plugins");
  }

  install(definition: PluginDefinition, expectedRevision: number | null) {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase(`install_${definition.pluginId}_${this.step}`),
        definition,
        settings: SETTINGS,
        expectedRevision,
      }),
    );
  }

  #change(pluginId: string, expectedRevision: number, name: string) {
    return {
      ...this.editBase(`${name}_${pluginId}_${this.step}`),
      pluginId,
      expectedRevision,
    };
  }

  pause(pluginId: string, expectedRevision: number) {
    return this.edit(
      this.admin.pausePlugin({
        ...this.#change(pluginId, expectedRevision, "pause"),
      }),
    );
  }

  resume(pluginId: string, expectedRevision: number) {
    return this.edit(
      this.admin.resumePlugin({
        ...this.#change(pluginId, expectedRevision, "resume"),
      }),
    );
  }

  remove(pluginId: string, expectedRevision: number) {
    return this.edit(
      this.admin.removePlugin({
        ...this.#change(pluginId, expectedRevision, "remove"),
      }),
    );
  }

  async plugin(pluginId: string) {
    return (await required(this.admin.listPlugins(merchantId))).plugins.find(
      (plugin) => plugin.pluginId === pluginId,
    );
  }

  /** The plugin runs that a checkout's quote records. */
  runsOf(database: Parameters<typeof readCheckout>[0], checkoutId: string) {
    return (
      readCheckout(database, merchantId, checkoutId)?.lifecycle.quote
        .pluginRuns ?? []
    );
  }

  async pluginEvents() {
    return (
      await required(this.admin.readEvents(merchantId, { limit: 200 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("plugin."));
  }
}
