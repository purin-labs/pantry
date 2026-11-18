// Plan 77 step 3, Japan export shipping as a built-in plugin: the Japan
// cookie shop ships to Singapore, and the plugin list names the plugin that
// does it. Ken pays for two boxes. The preview of a pause names the shipping
// step that stops. While the plugin is paused, the shipping storefront
// sells nothing: its catalog is gone, and Mei, who filled her cart before
// the pause, cannot check out. Ken's order and shipment stay, and the tea
// counter still sells for pickup. After a resume, Mei pays. Set
// JAPAN_EXPORT_PAUSE_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import type { CommerceAdminClient } from "@seams/commerce-client";
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
import { OrderDesk, SMALL_SENCHA } from "./order-desk.ts";
import { ParcelBuyer } from "./parcel-buyer.ts";

it(
  "stops shipping from Japan while its plugin is paused",
  { timeout: 60_000 },
  japanExportPause,
);

async function japanExportPause(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new ExportDesk(admin);
    await staff.createTea();
    const before = await staff.plugin();
    expect(before).toMatchObject({
      kind: "built_in",
      state: "active",
      contributions: { routes: [], pipelineSteps: ["shipping"] },
    });

    // 1. Ken pays for two boxes to Singapore.
    const ken = await ParcelBuyer.start(buyer, "export_ken");
    const quoted = await ken.quote();
    if (quoted.outcome !== "quoted") throw new Error("Ken has no quote");
    const placed = await ken.pay(quoted.checkout);
    if (placed.state !== "placed") throw new Error("Ken has no order");

    // 2. Mei fills her cart; then staff preview and pause the plugin.
    const mei = await ParcelBuyer.start(buyer, "export_mei");
    const cart = await mei.prepare();
    const preview = await required(
      admin.previewPluginChange(merchantId, "japan_export", "pause"),
    );
    expect(preview).toMatchObject({
      refusal: null,
      effects: [
        { kind: "pipeline_steps", available: false, steps: ["shipping"] },
      ],
    });
    expect(await staff.pause(before.revision)).toMatchObject({
      outcome: "applied",
    });

    // 3. The shipping storefront sells nothing.
    const meiToken = await ParcelBuyer.start(buyer, "export_mei_again");
    const closedCatalog = await meiToken.catalogStatus();
    const refused = await mei.checkout(cart);
    expect({ catalog: closedCatalog, checkout: refused }).toMatchObject({
      catalog: "http",
      checkout: {
        outcome: "rejected",
        error: { field: "buyerCheckout.shippingServiceAvailability" },
      },
    });

    // 4. Ken's order and shipment stay; the tea counter still sells.
    const shipments = await staff.shipmentsOf(placed.orderId);
    expect(shipments).toHaveLength(1);
    const tea = await (
      await Buyer.start(buyer, "export_tea")
    ).buyLines([catalogLine(SMALL_SENCHA)]);
    expect(tea).toMatch(/^order_/);

    // 5. After a resume, Mei pays.
    expect(await staff.resume(before.revision + 1)).toMatchObject({
      outcome: "applied",
    });
    const reopened = await mei.checkout(cart);
    if (reopened.outcome !== "quoted")
      throw new Error(`Mei has no quote: ${JSON.stringify(reopened.error)}`);
    expect((await mei.pay(reopened.checkout)).state).toBe("placed");

    Object.assign(evidence, {
      plugin: {
        pluginId: before.pluginId,
        steps: before.contributions.pipelineSteps,
      },
      preview: preview.effects,
      paused: {
        catalog: closedCatalog,
        checkout: refused.outcome === "rejected" ? refused.error : null,
      },
      kenShipments: shipments.length,
      receipts: staff.receipts,
    });
  } finally {
    writeEvidence(
      "JAPAN_EXPORT_PAUSE_ARTIFACT_DIR",
      "japan-export-pause",
      evidence,
    );
    backend.close();
  }
}

class ExportDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "japan_export");
  }

  async plugin() {
    const plugin = (
      await required(this.admin.listPlugins(merchantId))
    ).plugins.find((item) => item.pluginId === "japan_export");
    if (plugin === undefined) throw new Error("Japan export is not listed");
    return plugin;
  }

  async shipmentsOf(orderId: string) {
    return (await this.snapshot()).shipments.filter(
      (shipment) => shipment.orderId === orderId,
    );
  }

  pause(expectedRevision: number) {
    return this.edit(
      this.admin.pausePlugin({
        ...this.editBase(`pause_${this.step}`),
        pluginId: "japan_export",
        expectedRevision,
      }),
    );
  }

  resume(expectedRevision: number) {
    return this.edit(
      this.admin.resumePlugin({
        ...this.editBase(`resume_${this.step}`),
        pluginId: "japan_export",
        expectedRevision,
      }),
    );
  }
}
