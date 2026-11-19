// Plan 77 step 5, several commands in one run, in workerd: a merchant
// plugin's `make_amends` action gives an order's customer ¥300 of store
// credit and a one-use 10% code in one call. Both commands apply, each with
// its own receipt that names the action, the call gets one receipt of its
// own, and a retry of the call answers with it and changes nothing. When
// the second command is refused (its code is already taken), the first one
// is undone too: the second customer gets no credit. The run
// commits in Durable Object storage, whose nested transactions are what
// make it all or nothing. Set PLUGIN_RUN_COMMANDS_ARTIFACT_DIR to keep the
// run's evidence; the file repeats byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommercePluginActionV1,
} from "@purin-labs/commerce-client";
import type { PluginDefinition } from "@purin-labs/commerce-contracts";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  StaffDesk,
  catalogLine,
  merchantId,
  required,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { startWorkerdBackend } from "./workerd-backend.ts";

const SMALL_SENCHA = "variant_tea_small_sencha";

const AMENDS = `
function run(input) {
  const order = input.input.order;
  return { commands: [
    {
      kind: "credit_store_credit",
      orderId: order.id,
      amountMinor: input.settings.creditMinor,
      note: "Sorry for the wait",
    },
    {
      kind: "create_discount",
      key: "amends_" + order.id,
      title: "Sorry for the wait",
      code: input.input.code,
      percentOff: 10,
      usageLimit: 1,
    },
  ] };
}`;

const ACTIONS: readonly CommercePluginActionV1[] = [
  {
    actionId: "make_amends",
    title: "Make amends",
    inputs: [
      { key: "order", valueKind: "order", description: "The late order" },
      { key: "code", valueKind: "text", description: "The code to give" },
    ],
    source: AMENDS,
  },
];

it(
  "applies the commands of one plugin run all or none",
  { timeout: 300_000 },
  pluginRunCommands,
);

async function pluginRunCommands(): Promise<void> {
  const backend = await startWorkerdBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const staff = new AmendsDesk(backend.admin);
    await staff.createTea();
    expect(await staff.install()).toMatchObject({ outcome: "applied" });
    const late = await (
      await Buyer.start(backend.buyer, "amends_aiko")
    ).buyLines([catalogLine(SMALL_SENCHA)]);
    const later = await (
      await Buyer.start(backend.buyer, "amends_ren")
    ).buyLines([catalogLine(SMALL_SENCHA)]);

    // 1. One call gives the credit and the code.
    const amends = await staff.amends("amends_aiko", late, "SORRY-AIKO");
    expect(amends).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "run_plugin_action",
        principal: { source: "action", sourceId: "make_amends" },
      },
    });
    expect(await staff.credits()).toEqual([300]);
    expect(await staff.codes()).toEqual(["SORRY-AIKO"]);

    // 2. A retry of the call answers with the same receipt and gives
    //    nothing more.
    const retried = await staff.amends("amends_aiko", late, "SORRY-AIKO");
    expect(retried).toMatchObject({ outcome: "replayed" });
    if (amends.outcome === "rejected" || retried.outcome === "rejected")
      throw new Error("The call was refused");
    expect(retried.receipt.receiptId).toBe(amends.receipt.receiptId);
    expect(await staff.credits()).toEqual([300]);

    // 3. The second command's code is taken: the call is refused, and the
    //    credit that its first command gave is undone.
    const refused = await staff.amends("amends_ren", later, "SORRY-AIKO");
    expect(refused).toMatchObject({
      outcome: "rejected",
      error: {
        code: "action_refused",
        pluginId: "amends",
        actionId: "make_amends",
        message:
          "Command 2 (create_discount): The core refused the command: resource_relationship_invalid",
      },
    });
    expect(await staff.credits()).toEqual([300]);
    expect(await staff.codes()).toEqual(["SORRY-AIKO"]);

    // 4. With a free code, the same order gets both.
    expect(
      await staff.amends("amends_ren_2", later, "SORRY-REN"),
    ).toMatchObject({ outcome: "applied" });
    expect(await staff.credits()).toEqual([300, 300]);
    expect(await staff.codes()).toEqual(["SORRY-AIKO", "SORRY-REN"]);

    Object.assign(evidence, {
      amends: { outcome: amends.outcome, receipt: amends.receipt.commandKind },
      retried: retried.outcome,
      refused,
      credits: await staff.credits(),
      codes: await staff.codes(),
    });
  } finally {
    writeEvidence(
      "PLUGIN_RUN_COMMANDS_ARTIFACT_DIR",
      "plugin-run-commands",
      evidence,
    );
    await backend.close();
  }
}

class AmendsDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "amends");
  }

  install() {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase("install_amends"),
        definition: amends(),
        settings: { creditMinor: 300 },
        actions: ACTIONS,
        expectedRevision: null,
      }),
    );
  }

  amends(key: string, orderId: string, code: string) {
    return required(
      this.admin.runPluginAction({
        merchantId,
        idempotencyKey: key,
        pluginId: "amends",
        actionId: "make_amends",
        input: { order: orderId, code },
      }),
    );
  }

  /** Everything credited to each store credit account, in id order. */
  async credits(): Promise<number[]> {
    return (await required(this.admin.listStoredValueAccounts(merchantId)))
      .filter((account) => account.kind === "store_credit")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((account) => account.credited.amountMinor);
  }

  async codes(): Promise<string[]> {
    return (await required(this.admin.listDiscounts(merchantId)))
      .flatMap((discount) =>
        discount.method.kind === "code" ? [...discount.method.codes] : [],
      )
      .sort();
  }
}

function amends(): PluginDefinition {
  return {
    pluginId: "amends",
    version: 1,
    kind: "merchant",
    title: "Amends",
    purpose: "Store credit and a code for a late order.",
    requirements: {
      hookPoints: [],
      reads: [],
      commands: ["credit_store_credit", "create_discount"],
      dependsOn: [],
    },
    contributions: {
      routes: [],
      pipelineSteps: [],
      entityTypes: [],
      settings: [
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
