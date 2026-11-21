// Plan 77 step 3: an agent lists a merchant's plugins, previews a pause of
// gift cards and store credit, and pauses it. The preview names the value
// that stays owed and the checkouts that hold some of it. While the plugin is
// paused its routes answer 404 and checkout ignores gift card codes; another
// merchant still issues gift cards. A key that may only read cannot pause, a
// plugin that another active plugin needs cannot pause, and after the resume
// the balances are as before. Set PLUGIN_ARTIFACT_DIR to keep the run's
// evidence; the file repeats byte for byte for the same commit.
import { clientInput } from "./command-input.ts";
import {
  CommerceAdminClient,
  type CommerceClientResult,
  type CommercePluginPreviewV1,
} from "@purin-labs/commerce-client";
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
  organisationId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { OrderDesk, SMALL_SENCHA } from "./order-desk.ts";
import { TransitionMatrix } from "./transition-matrix.ts";

// A fixed code, so that the evidence repeats; a merchant's codes are random.
const MIA_CODE = "MIA1-2345-6789-ABCD";
const SECOND_MERCHANT = "merchant_plugin_second";

it(
  "pauses a merchant's gift cards after a preview, and resumes them with the balances kept",
  { timeout: 60_000 },
  pauseAndResume,
);

async function pauseAndResume(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  const matrix = new TransitionMatrix(["plugin"], {
    "plugin * remove":
      "merchant-plugin-journey.test.ts removes a merchant plugin and refuses to remove a built-in one",
    "plugin removed *":
      "merchant-plugin-journey.test.ts asks a removed plugin for every change",
    "plugin * auto_pause":
      "merchant-plugin-journey.test.ts pauses a merchant plugin after three failures; no route asks for it",
  });
  try {
    const { admin, buyer, fetch } = backend;
    const staff = new PluginDesk(admin);
    await staff.createTea();

    // Every built-in plugin starts active.
    const listed = await required(admin.listPlugins(merchantId));
    expect(
      listed.plugins.map((plugin) => [
        plugin.pluginId,
        plugin.state,
        plugin.revision,
      ]),
    ).toEqual(
      [
        "collections",
        "media",
        "markets",
        "discounts",
        "customers",
        "draft_orders",
        "returns",
        "stored_value",
        "food_service",
        "purchasing",
        "production_demand",
        "companies",
        "japan_export",
      ].map((pluginId) => [pluginId, "active", 1]),
    );
    const storedValue = listed.plugins.find(
      (plugin) => plugin.pluginId === "stored_value",
    );
    if (storedValue === undefined) throw new Error("No stored value plugin");
    expect(storedValue).toMatchObject({
      kind: "built_in",
      specSection: 17,
      contributions: {
        pipelineSteps: ["stored_value"],
        routes: expect.arrayContaining([
          "issue_gift_card",
          "read_gift_card_balance",
        ]),
      },
    });

    // A key that may only read settings lists and previews, but cannot pause.
    const reader = new CommerceAdminClient({
      baseUrl: BASE_URL,
      serviceToken: await issueKey(fetch, ["settings:read"]),
      fetch,
    });
    expect((await reader.listPlugins(merchantId)).ok).toBe(true);
    expect(
      status(
        await reader.pausePlugin(clientInput(staff.change("discounts", 1))),
      ),
    ).toBe(403);

    // Mia's ¥3,000 gift card; Ken's open quote holds part of it.
    await staff.issueGiftCard("gift_mia", MIA_CODE, 3_000);
    const ken = await Buyer.start(buyer, "plugin_ken");
    ken.giftCardCodes = [MIA_CODE];
    const held = await ken.quote([catalogLine(SMALL_SENCHA)]);
    expect(held.quote.storedValue?.due).toEqual(jpy(0));
    const balanceBefore = await staff.giftCardBalance("gift_mia");

    // The preview says what a pause does and leaves; it changes nothing.
    const preview = await required(
      admin.previewPluginChange(merchantId, "stored_value", "pause"),
    );
    expect(preview).toEqual({
      schemaVersion: "commerce.plugin-preview.v1",
      pluginId: "stored_value",
      change: "pause",
      refusal: null,
      effects: [
        {
          kind: "routes",
          available: false,
          routes: storedValue.contributions.routes,
        },
        { kind: "pipeline_steps", available: false, steps: ["stored_value"] },
        { kind: "open_balances", accounts: 1, balances: [jpy(3_000)] },
        { kind: "held_checkouts", checkouts: 1 },
      ],
    } satisfies CommercePluginPreviewV1);
    expect(await staff.pluginState("stored_value")).toEqual(["active", 1]);

    // The pause: the gift card routes answer 404, and checkout ignores the
    // code, so the card pays everything.
    const paused = await staff.pause("stored_value", 1);
    matrix.check("plugin", "active", "pause", paused);
    expect(paused).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "pause_plugin",
        resource: { kind: "plugin", id: "stored_value", revision: 2 },
      },
    });
    expect(
      status(
        await admin.issueGiftCard(
          clientInput(staff.giftCard("gift_late", MIA_CODE, 500)),
        ),
      ),
    ).toBe(404);
    expect(status(await admin.listStoredValueAccounts(merchantId))).toBe(404);
    const lia = await Buyer.start(buyer, "plugin_lia");
    expect(
      status(
        await buyer.readGiftCardBalance(
          merchantId,
          STOREFRONT,
          lia.token,
          MIA_CODE,
        ),
      ),
    ).toBe(404);
    lia.giftCardCodes = [MIA_CODE];
    const ignored = await lia.quote([catalogLine(SMALL_SENCHA)]);
    expect(ignored.quote.storedValue).toBeUndefined();

    // Another merchant keeps its own plugins.
    await required(
      admin.provisionMerchant({
        schemaVersion: "commerce.provision-merchant.v2",
        externalReference: organisationId,
        merchantId: SECOND_MERCHANT,
        createdAt: NOW,
      }),
    );
    expect(
      await required(
        admin.issueGiftCard({
          ...clientInput(
            staff.giftCard("gift_second", "SEC1-2345-6789-ABCD", 1_000),
          ),
          merchantId: SECOND_MERCHANT,
        }),
      ),
    ).toMatchObject({ outcome: "applied" });

    // A paused plugin cannot pause again; a stale revision is refused; draft
    // orders need customers, so customers cannot pause; an active plugin
    // cannot resume.
    matrix.check(
      "plugin",
      "paused",
      "pause",
      await staff.pause("stored_value", 2),
    );
    expect(await staff.pause("discounts", 5)).toMatchObject(
      rejectedWith({ code: "stale_resource_revision" }),
    );
    expect(await staff.pause("customers", 1)).toMatchObject(
      rejectedWith({ field: "plugin.dependents" }),
    );
    expect(
      (
        await required(
          admin.previewPluginChange(merchantId, "customers", "pause"),
        )
      ).refusal,
    ).toEqual({
      code: "resource_relationship_invalid",
      field: "plugin.dependents",
    });
    matrix.check(
      "plugin",
      "active",
      "resume",
      await staff.resume("discounts", 1),
    );

    // The resume: the balance is as before, and the code pays again.
    const resumed = await staff.resume("stored_value", 2);
    matrix.check("plugin", "paused", "resume", resumed);
    expect(await staff.giftCardBalance("gift_mia")).toEqual(balanceBefore);
    const noa = await Buyer.start(buyer, "plugin_noa");
    noa.giftCardCodes = [MIA_CODE];
    const paying = await noa.quote([catalogLine(SMALL_SENCHA)]);
    expect(paying.quote.storedValue?.due).toEqual(jpy(0));
    expect(await staff.pluginEvents()).toEqual([
      "plugin.paused",
      "plugin.resumed",
    ]);

    const report = matrix.report();
    expect(report.unexplained).toEqual([]);
    expect(report.stalePatterns).toEqual([]);
    Object.assign(evidence, {
      receipts: staff.receipts,
      preview,
      matrix: report,
      plugins: (await required(admin.listPlugins(merchantId))).plugins.map(
        (plugin) => ({
          pluginId: plugin.pluginId,
          state: plugin.state,
          revision: plugin.revision,
        }),
      ),
    });
  } finally {
    writeEvidence("PLUGIN_ARTIFACT_DIR", "plugins", evidence);
    backend.close();
  }
}

function status(result: CommerceClientResult<unknown>): number | "ok" {
  if (result.ok) return "ok";
  return "status" in result.error ? result.error.status : 0;
}

async function issueKey(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
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
      body: JSON.stringify({ label: "Plugin reader", scopes }),
    },
  );
  const body = (await response.json()) as { key?: unknown };
  if (response.status !== 201 || typeof body.key !== "string")
    throw new Error("The reading key was not issued");
  return body.key;
}

class PluginDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "plugins");
  }

  change(pluginId: string, expectedRevision: number) {
    return {
      schemaVersion: "commerce.pause-plugin.v1" as const,
      ...this.editBase(`pause_${pluginId}_${this.step}`),
      pluginId,
      expectedRevision,
    };
  }

  pause(pluginId: string, expectedRevision: number) {
    return this.edit(
      this.admin.pausePlugin(
        clientInput(this.change(pluginId, expectedRevision)),
      ),
    );
  }

  resume(pluginId: string, expectedRevision: number) {
    return this.edit(
      this.admin.resumePlugin({
        ...this.editBase(`resume_${pluginId}_${this.step}`),
        pluginId,
        expectedRevision,
      }),
    );
  }

  async pluginState(pluginId: string) {
    const plugin = (
      await required(this.admin.listPlugins(merchantId))
    ).plugins.find((item) => item.pluginId === pluginId);
    return [plugin?.state, plugin?.revision];
  }

  giftCard(accountId: string, code: string, amountMinor: number) {
    return {
      schemaVersion: "commerce.issue-gift-card.v1" as const,
      ...this.editBase(`issue_${accountId}`),
      accountId,
      code,
      amount: jpy(amountMinor),
      expiresAt: null,
      note: null,
    };
  }

  async issueGiftCard(accountId: string, code: string, amountMinor: number) {
    await this.apply(
      this.admin.issueGiftCard(
        clientInput(this.giftCard(accountId, code, amountMinor)),
      ),
    );
  }

  async giftCardBalance(accountId: string) {
    const account = (
      await required(this.admin.listStoredValueAccounts(merchantId))
    ).find((item) => item.id === accountId);
    if (account === undefined) throw new Error(`${accountId} is missing`);
    return account.balance;
  }

  async pluginEvents() {
    return (
      await required(this.admin.readEvents(merchantId, { limit: 200 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("plugin."));
  }
}
