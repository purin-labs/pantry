// Plan 77 step 4: a merchant plugin guards staff moves. "Whole cakes are made
// to order": staff cannot cancel, refund or edit an order with a whole cake,
// a whole cake is made ready at most 4 hours before its pickup, and
// return authorizations are paused for the holidays, while a return can still
// be rejected. Tea orders cancel as before. A guard version that throws is
// skipped, so the move goes on and the failure is an event; a required one
// refuses every guarded move until it is fixed. Set
// MACHINE_GUARD_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommercePluginSettingsV1,
} from "@seams/commerce-client";
import type { PluginDefinition } from "@seams/commerce-contracts";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  catalogLine,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { LARGE_SENCHA, OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const RULES = `
function run(input) {
  const settings = input.settings;
  const move = input.move;
  const cake = move.machine === "order" && input.subject.lines.some((line) =>
    settings.madeToOrderVariantIds.includes(line.variantId));
  if (cake && (move.event === "cancel" || move.event === "refund" || move.event === "edit"))
    return { refusals: [{ message: "Whole cakes are made to order; the shop decides a " + move.event + "." }] };
  if (cake && move.event === "ready_pickup" &&
      Date.parse(input.subject.fulfillment.expectedBy) - Date.parse(move.at) > 4 * 3600000)
    return { refusals: [{ message: "A whole cake is made ready at most 4 hours before its pickup." }] };
  if (move.machine === "return" && move.event === "authorize" && settings.returnsPaused)
    return { refusals: [{ message: "Returns are paused for the holidays." }] };
  return { refusals: [] };
}`;

const SETTINGS: CommercePluginSettingsV1 = {
  madeToOrderVariantIds: [LARGE_SENCHA],
  returnsPaused: true,
};

function madeToOrder(
  version: number,
  source: string,
  required = false,
): PluginDefinition {
  return {
    pluginId: "made_to_order",
    version,
    kind: "merchant",
    title: "Made to order",
    purpose:
      "Whole cakes are made to order, so staff do not cancel or refund them; returns pause for the holidays.",
    requirements: {
      hookPoints: ["machine.guard"],
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
          key: "madeToOrderVariantIds",
          valueKind: "text_list",
          description: "Variants that are made to order",
        },
        {
          key: "returnsPaused",
          valueKind: "boolean",
          description: "Whether return authorizations are paused",
        },
      ],
      functions: [
        { functionId: "guard", hookPoint: "machine.guard", required, source },
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
  "lets a plugin refuse an order cancellation, a refund and a return authorization",
  { timeout: 90_000 },
  machineGuards,
);

async function machineGuards(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new GuardDesk(admin);
    await staff.createTea();
    const buy = async (name: string, variantId: string) =>
      (await Buyer.start(buyer, `guard_${name}`)).buyLines([
        catalogLine(variantId),
      ]);
    const cakeOrder = await buy("cake", LARGE_SENCHA);
    const teaOrder = await buy("tea", SMALL_SENCHA);
    const returnOrder = await buy("return", SMALL_SENCHA);
    expect(await staff.install(madeToOrder(1, RULES), null)).toMatchObject({
      outcome: "applied",
    });

    // The cake order cannot be cancelled or refunded; nothing moves.
    const cakeBefore = await staff.order(cakeOrder);
    const cakeCancel = await staff.cancel(cakeOrder);
    expect(cakeCancel).toEqual({
      outcome: "rejected",
      error: {
        code: "transition_refused",
        pluginId: "made_to_order",
        machine: "order",
        event: "cancel",
        message: "Whole cakes are made to order; the shop decides a cancel.",
      },
    });
    const cakeLine = await staff.lineId(cakeOrder);
    expect(
      await staff.refund(cakeOrder, cakeLine, "refund_guard_cake", 500),
    ).toMatchObject({
      outcome: "rejected",
      error: { code: "transition_refused", event: "refund" },
    });
    expect(await staff.order(cakeOrder)).toEqual(cakeBefore);

    // The tea order cancels as before.
    expect(await staff.cancel(teaOrder)).toMatchObject({ outcome: "applied" });
    expect((await staff.order(teaOrder)).lifecycle.state).toBe("cancelled");

    // A cake for the day after tomorrow is not made ready or edited yet.
    const later = await Buyer.start(buyer, "guard_cake_later");
    later.pickupAt = new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString();
    const laterCake = await later.buyLines([catalogLine(LARGE_SENCHA)]);
    const laterBefore = await staff.order(laterCake);
    const earlyReady = await staff.markReady(laterCake);
    expect(earlyReady).toEqual({
      outcome: "rejected",
      error: {
        code: "transition_refused",
        pluginId: "made_to_order",
        machine: "order",
        event: "ready_pickup",
        message:
          "A whole cake is made ready at most 4 hours before its pickup.",
      },
    });
    expect(await staff.editOrder(laterCake, SMALL_SENCHA)).toMatchObject({
      outcome: "rejected",
      error: { code: "transition_refused", event: "edit" },
    });
    expect(await staff.order(laterCake)).toEqual(laterBefore);

    // Return authorizations are paused; a rejection still goes through.
    await staff.markReady(returnOrder);
    await staff.completePickup(returnOrder);
    const returnLine = await staff.lineId(returnOrder);
    await staff.requestReturn(returnOrder, returnLine, "return_guard");
    expect(
      await staff.decide("return_guard", 1, [
        { orderLineId: returnLine, decision: "authorized" },
      ]),
    ).toMatchObject({
      outcome: "rejected",
      error: {
        code: "transition_refused",
        machine: "return",
        message: "Returns are paused for the holidays.",
      },
    });
    expect(
      await staff.decide("return_guard", 1, [
        { orderLineId: returnLine, decision: "rejected" },
      ]),
    ).toMatchObject({ outcome: "applied" });

    // Version 2 throws. It is not required, so the cake order cancels, and
    // the failure is reported with the order as its subject.
    expect(
      await staff.install(
        madeToOrder(2, "function run(input) { throw new Error('broken'); }"),
        2,
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(await staff.cancel(cakeOrder)).toMatchObject({ outcome: "applied" });
    const afterThrow = await staff.plugin();
    expect(afterThrow?.lastFailure).toMatchObject({
      hookPoint: "machine.guard",
      functionId: "guard",
      reason: "threw",
      subjectId: cakeOrder,
    });

    // Version 3 throws and is required: a guarded move is refused until the
    // agent fixes it.
    const lateOrder = await buy("late", SMALL_SENCHA);
    expect(
      await staff.install(
        madeToOrder(
          3,
          "function run(input) { throw new Error('broken'); }",
          true,
        ),
        3,
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(await staff.cancel(lateOrder)).toMatchObject({
      outcome: "rejected",
      error: {
        code: "transition_refused",
        message: "This change cannot be checked now. Try again later.",
      },
    });

    const pluginEvents = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("plugin."));
    expect(pluginEvents).toEqual([
      "plugin.installed",
      "plugin.installed",
      "plugin.function_failed",
      "plugin.installed",
    ]);

    Object.assign(evidence, {
      receipts: staff.receipts,
      refusals: { cakeCancel, earlyReady },
      lastFailure: afterThrow?.lastFailure,
      pluginEvents,
    });
  } finally {
    writeEvidence("MACHINE_GUARD_ARTIFACT_DIR", "machine-guard", evidence);
    backend.close();
  }
}

class GuardDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "machine_guards");
  }

  install(definition: PluginDefinition, expectedRevision: number | null) {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase(`install_${definition.version}`),
        definition,
        settings: SETTINGS,
        expectedRevision,
      }),
    );
  }

  decide(
    returnId: string,
    expectedReturnRevision: number,
    decisions: readonly Readonly<{
      orderLineId: string;
      decision: "authorized" | "rejected";
    }>[],
  ) {
    return this.edit(
      this.admin.authorizeReturn({
        ...this.editBase(`decide_${returnId}_${this.step}`),
        returnId,
        expectedReturnRevision,
        decisions,
      }),
    );
  }

  async plugin() {
    return (await required(this.admin.listPlugins(merchantId))).plugins.find(
      (plugin) => plugin.pluginId === "made_to_order",
    );
  }
}
