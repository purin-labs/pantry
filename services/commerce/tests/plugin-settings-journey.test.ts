// Plan 77 step 3, the settings of a built-in plugin: the returns plugin
// takes return requests for 30 days after fulfilment. Staff shorten the
// window to 2 days, and a request three days after the buyer collected her
// tea is refused. The plugin refuses a key it does not name, a window over
// a year, and a stale revision; a pause and a resume keep the window. When
// staff clear the setting, the default of 30 days is back and the same
// request is taken. Set PLUGIN_SETTINGS_ARTIFACT_DIR to keep the run's
// evidence; the file repeats byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommercePluginSettingsV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  catalogLine,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const THREE_DAYS_LATER = "2026-08-17T10:00:00.000Z";

it(
  "shortens the return window by a setting of the returns plugin",
  { timeout: 60_000 },
  pluginSettings,
);

async function pluginSettings(): Promise<void> {
  let clock = NOW;
  const backend = await startBackend({ now: () => clock });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new SettingsDesk(admin);
    await staff.createTea();
    const before = await staff.returns();
    expect(before.settings).toEqual({ returnWindowDays: 30 });

    // Aoi collects her tea now.
    const orderId = await (
      await Buyer.start(buyer, "settings_aoi")
    ).buyLines([catalogLine(SMALL_SENCHA)]);
    expect(await staff.markReady(orderId)).toMatchObject({
      outcome: "applied",
    });
    expect(await staff.completePickup(orderId)).toMatchObject({
      outcome: "applied",
    });

    // Three days pass.
    clock = THREE_DAYS_LATER;

    // 1. Staff shorten the window to 2 days.
    expect(
      await staff.configure({ returnWindowDays: 2 }, before.revision),
    ).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "configure_plugin" },
    });
    const shortened = await staff.returns();
    expect(shortened).toMatchObject({
      state: "active",
      revision: before.revision + 1,
      settings: { returnWindowDays: 2 },
    });

    // 2. Three days after she collected it, her return is refused.
    expect(await staff.requestLate(orderId, "short")).toMatchObject(
      rejectedWith({ field: "return.window" }),
    );

    // 3. The plugin refuses what it does not take.
    const refusals = {
      unknownKey: await staff.configure(
        { returnWindowDays: 2, restockingFeePercent: 10 },
        shortened.revision,
      ),
      overAYear: await staff.configure(
        { returnWindowDays: 400 },
        shortened.revision,
      ),
      text: await staff.configure(
        { returnWindowDays: "2" },
        shortened.revision,
      ),
      stale: await staff.configure({ returnWindowDays: 7 }, before.revision),
    };
    expect(refusals).toMatchObject({
      unknownKey: rejectedWith({
        field: "plugin.settings.restockingFeePercent",
      }),
      overAYear: rejectedWith({ field: "plugin.settings.returnWindowDays" }),
      text: rejectedWith({ field: "plugin.settings.returnWindowDays" }),
      stale: rejectedWith({ code: "stale_resource_revision" }),
    });

    // 4. A pause and a resume keep the window.
    expect(await staff.pause(shortened.revision)).toMatchObject({
      outcome: "applied",
    });
    expect(await staff.resume(shortened.revision + 1)).toMatchObject({
      outcome: "applied",
    });
    const resumed = await staff.returns();
    expect(resumed).toMatchObject({
      state: "active",
      settings: { returnWindowDays: 2 },
    });
    expect(await staff.requestLate(orderId, "resumed")).toMatchObject(
      rejectedWith({ field: "return.window" }),
    );

    // 5. Staff clear the setting: the default of 30 days is back.
    expect(await staff.configure({}, resumed.revision)).toMatchObject({
      outcome: "applied",
    });
    const cleared = await staff.returns();
    expect(cleared.settings).toEqual({ returnWindowDays: 30 });
    expect(await staff.requestLate(orderId, "default")).toMatchObject({
      outcome: "applied",
    });

    const pluginEvents = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("plugin."));
    expect(pluginEvents).toEqual([
      "plugin.configured",
      "plugin.paused",
      "plugin.resumed",
      "plugin.configured",
    ]);

    Object.assign(evidence, {
      settings: {
        before: before.settings,
        shortened: shortened.settings,
        resumed: resumed.settings,
        cleared: cleared.settings,
      },
      refusals,
      pluginEvents,
    });
  } finally {
    writeEvidence("PLUGIN_SETTINGS_ARTIFACT_DIR", "plugin-settings", evidence);
    backend.close();
  }
}

class SettingsDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "plugin_settings");
  }

  async returns() {
    const plugin = (
      await required(this.admin.listPlugins(merchantId))
    ).plugins.find((item) => item.pluginId === "returns");
    if (plugin === undefined) throw new Error("The returns plugin is missing");
    return plugin;
  }

  configure(settings: CommercePluginSettingsV1, expectedRevision: number) {
    return this.edit(
      this.admin.configurePlugin({
        ...this.editBase(`configure_${this.step}`),
        pluginId: "returns",
        settings,
        expectedRevision,
      }),
    );
  }

  pause(expectedRevision: number) {
    return this.edit(
      this.admin.pausePlugin({
        ...this.editBase(`pause_${this.step}`),
        pluginId: "returns",
        expectedRevision,
      }),
    );
  }

  resume(expectedRevision: number) {
    return this.edit(
      this.admin.resumePlugin({
        ...this.editBase(`resume_${this.step}`),
        pluginId: "returns",
        expectedRevision,
      }),
    );
  }

  /** A return of one tin. */
  async requestLate(orderId: string, key: string) {
    return this.edit(
      this.admin.requestReturn({
        ...this.editBase(`return_${key}`),
        returnId: `return_${key}`,
        orderId,
        lines: [
          {
            orderLineId: await this.lineId(orderId),
            quantity: 1,
            reason: "Dented tin",
          },
        ],
      }),
    );
  }
}
