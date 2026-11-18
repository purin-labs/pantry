// Plan 77 step 5, the eviction case, in workerd: a merchant plugin's handler
// gives a thank-you code for each order. The merchant object is evicted right
// after the third order, before or while its handler runs. After the object
// starts again from its storage, each order has exactly one code: the handler
// neither loses the third order nor creates a code twice. Set
// PLUGIN_EVICTION_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte for the same commit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommerceAdminClient } from "@seams/commerce-client";
import type { PluginDefinition } from "@seams/commerce-contracts";
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

const THANKS = `
function run(input) {
  if (input.order === null) return {};
  return { commands: [{
    kind: "create_discount",
    key: "thanks_" + input.order.id,
    title: "Thank you",
    code: "THANKS-" + input.order.id.slice(-8).toUpperCase(),
    percentOff: 5,
    usageLimit: 1,
  }] };
}`;

it(
  "gives one code for each order across an eviction of the merchant object",
  { timeout: 300_000 },
  pluginEviction,
);

async function pluginEviction(): Promise<void> {
  const storage = mkdtempSync(join(tmpdir(), "underclerk-eviction-"));
  const evidence: Evidence = { clock: NOW, merchantId };
  let backend = await startWorkerdBackend({ persistDirectory: storage });
  try {
    const staff = new ThanksDesk(backend.admin);
    await staff.createTea();
    expect(await staff.install()).toMatchObject({ outcome: "applied" });
    const orders: string[] = [];
    for (let order = 1; order <= 2; order += 1)
      orders.push(
        await (
          await Buyer.start(backend.buyer, `thanks_${order}`)
        ).buyLines([catalogLine(SMALL_SENCHA)]),
      );
    await expect
      .poll(() => codes(backend.admin), { timeout: 20_000 })
      .toHaveLength(2);

    // The third order, then an eviction before the handler can be sure to
    // have run.
    orders.push(
      await (
        await Buyer.start(backend.buyer, "thanks_3")
      ).buyLines([catalogLine(SMALL_SENCHA)]),
    );
    await backend.close();
    backend = await startWorkerdBackend({ persistDirectory: storage });

    // The object starts again from its storage; a request lets the handler
    // pass run.
    await expect
      .poll(
        async () => {
          await backend.admin.readSnapshot(merchantId);
          return codes(backend.admin);
        },
        { timeout: 30_000 },
      )
      .toHaveLength(3);
    // Later passes create nothing more.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await backend.admin.readSnapshot(merchantId);
    const final = await codes(backend.admin);
    expect(final).toEqual(
      orders
        .map((orderId) => `THANKS-${orderId.slice(-8).toUpperCase()}`)
        .sort(),
    );

    Object.assign(evidence, { orders: orders.length, codes: final });
  } finally {
    writeEvidence("PLUGIN_EVICTION_ARTIFACT_DIR", "plugin-eviction", evidence);
    await backend.close();
    rmSync(storage, { recursive: true, force: true });
  }
}

async function codes(admin: CommerceAdminClient): Promise<string[]> {
  return (await required(admin.listDiscounts(merchantId)))
    .flatMap((discount) =>
      discount.method.kind === "code" ? [...discount.method.codes] : [],
    )
    .sort();
}

class ThanksDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "thanks");
  }

  install() {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase("install_thanks"),
        definition: thanks(),
        settings: {},
        handlers: [
          {
            handlerId: "thanks",
            eventKinds: ["order.created"],
            source: THANKS,
          },
        ],
        expectedRevision: null,
      }),
    );
  }
}

function thanks(): PluginDefinition {
  return {
    pluginId: "thanks",
    version: 1,
    kind: "merchant",
    title: "Thanks",
    purpose: "A thank-you code for each order.",
    requirements: {
      hookPoints: [],
      reads: [],
      commands: ["create_discount"],
      dependsOn: [],
    },
    contributions: {
      routes: [],
      pipelineSteps: [],
      entityTypes: [],
      settings: [],
      functions: [],
    },
    limits: {
      instructionBudget: 100,
      memoryBytes: 8 * 1024 * 1024,
      outputBytes: 16 * 1024,
    },
  };
}
