// Plan 80 step 1, one request shape: a write body carries only the
// command's own fields. The path names the merchant and the plugin, the
// Idempotency-Key header names the attempt, and the server's clock gives the
// time. Staff shorten the return window an hour after the shop opens; the
// receipt carries the server's time, and the receipt and its delivery name
// only the merchant. A retry with the same key and the same
// fields in another order answers the first receipt, and the same key with
// another window is refused. A body that names a field the server gives or
// a path field, or a write with no key, is refused before any change. A
// merchant id that holds a path is refused. A second merchant may use the
// same key. Set REQUEST_SHAPE_ARTIFACT_DIR to
// keep the run's evidence; the file repeats byte for byte for the same
// commit.
import type { CommerceAdminClient } from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  BASE_URL,
  NOW,
  SERVICE_TOKEN,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const AN_HOUR_LATER = "2026-08-14T11:00:00.000Z";
const SECOND_MERCHANT = "merchant_second_shop";

it(
  "takes a write body without the fields that the path, the key and the server give",
  { timeout: 60_000 },
  requestShape,
);

async function requestShape(): Promise<void> {
  let clock = NOW;
  const backend = await startBackend({ now: () => clock });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin } = backend;
    const send = (
      merchant: string,
      body: Record<string, unknown>,
      idempotencyKey?: string,
    ) =>
      backend.fetch(
        `${BASE_URL}/v1/admin/merchants/${merchant}/plugins/returns/settings`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${SERVICE_TOKEN}`,
            "content-type": "application/json",
            ...(idempotencyKey === undefined
              ? {}
              : { "idempotency-key": idempotencyKey }),
          },
          body: JSON.stringify(body),
        },
      );
    const before = await returnsPlugin(admin, merchantId);

    // 1. An hour after opening, staff shorten the window to 7 days.
    clock = AN_HOUR_LATER;
    const applied = await answer(
      send(
        merchantId,
        {
          expectedRevision: before.revision,
          settings: { returnWindowDays: 7 },
        },
        "shorten_window",
      ),
    );
    expect(applied).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "configure_plugin",
        merchantId,
        idempotencyKey: "shorten_window",
        committedAt: AN_HOUR_LATER,
      },
    });

    // The receipt and its delivery name the merchant only.
    const receipt =
      applied.outcome === "rejected" ? undefined : applied.receipt;
    // The feed as an operator's system reads it, before any client parses it.
    const feed = (await (
      await backend.fetch(
        `${BASE_URL}/v1/admin/merchants/${merchantId}/events?limit=300`,
        { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } },
      )
    ).json()) as {
      events: readonly {
        delivery: { deliveryId: string; schemaVersion: string };
      }[];
    };
    const delivery = feed.events.find(
      (event) => event.delivery.deliveryId === receipt?.deliveryId,
    )?.delivery;
    const owner = (record: object | undefined) =>
      Object.keys(record ?? {}).filter(
        (key) => key === "organisationId" || key === "actionNonce",
      );
    const signed = {
      receipt: receipt?.schemaVersion,
      delivery: delivery?.schemaVersion,
      ownerFields: [...owner(receipt), ...owner(delivery)],
    };
    expect(signed).toEqual({
      receipt: "underclerk.mutation-receipt.v2",
      delivery: "underclerk.commerce-delivery.v2",
      ownerFields: [],
    });

    // 2. The same attempt again, its fields in another order, a minute
    // later: the first receipt, and no second change.
    clock = "2026-08-14T11:01:00.000Z";
    const replayed = await answer(
      send(
        merchantId,
        {
          settings: { returnWindowDays: 7 },
          expectedRevision: before.revision,
        },
        "shorten_window",
      ),
    );
    expect(replayed).toEqual({ ...applied, outcome: "replayed" });

    // 3. The same key with another window is refused.
    const conflict = await answer(
      send(
        merchantId,
        {
          expectedRevision: before.revision,
          settings: { returnWindowDays: 9 },
        },
        "shorten_window",
      ),
    );
    expect(conflict).toMatchObject({
      outcome: "rejected",
      error: { code: "idempotency_conflict" },
    });

    // 4. What the path, the key or the server gives cannot come in the body.
    const body = {
      expectedRevision: before.revision + 1,
      settings: { returnWindowDays: 14 },
    };
    const refusals = {
      organisationId: await refusal(
        send(
          merchantId,
          { ...body, organisationId: "organisation_other" },
          "a",
        ),
      ),
      requestedAt: await refusal(
        send(
          merchantId,
          { ...body, requestedAt: "2026-07-01T00:00:00.000Z" },
          "b",
        ),
      ),
      merchantId: await refusal(
        send(merchantId, { ...body, merchantId: SECOND_MERCHANT }, "c"),
      ),
      pluginId: await refusal(
        send(merchantId, { ...body, pluginId: "discounts" }, "d"),
      ),
      noKey: await refusal(send(merchantId, body)),
    };
    expect(refusals).toEqual({
      organisationId: { status: 400, field: "organisationId" },
      requestedAt: { status: 400, field: "requestedAt" },
      merchantId: { status: 400, field: "merchantId" },
      pluginId: { status: 400, field: "pluginId" },
      noKey: { status: 400, field: "Idempotency-Key" },
    });
    const kept = await returnsPlugin(admin, merchantId);
    expect(kept).toMatchObject({
      revision: before.revision + 1,
      settings: { returnWindowDays: 7 },
    });

    // 5. A merchant id cannot hold a path under another merchant's id.
    const pathId = await admin.provisionMerchant({
      schemaVersion: "underclerk.provision-merchant.v2",
      externalReference: "organisation_second_shop",
      merchantId: `${merchantId}/media`,
      createdAt: NOW,
    });
    expect(pathId.ok).toBe(false);

    // 6. Another merchant may use the same key: its own first change.
    await required(
      admin.provisionMerchant({
        schemaVersion: "underclerk.provision-merchant.v2",
        externalReference: "organisation_second_shop",
        merchantId: SECOND_MERCHANT,
        createdAt: NOW,
      }),
    );
    const second = await returnsPlugin(admin, SECOND_MERCHANT);
    const secondApplied = await answer(
      send(
        SECOND_MERCHANT,
        {
          expectedRevision: second.revision,
          settings: { returnWindowDays: 7 },
        },
        "shorten_window",
      ),
    );
    expect(secondApplied).toMatchObject({
      outcome: "applied",
      receipt: {
        merchantId: SECOND_MERCHANT,
        idempotencyKey: "shorten_window",
      },
    });
    if (applied.outcome !== "applied" || secondApplied.outcome !== "applied")
      throw new Error("A change did not apply");
    expect(secondApplied.receipt.receiptId).not.toBe(applied.receipt.receiptId);

    Object.assign(evidence, {
      applied: {
        receiptId: applied.receipt.receiptId,
        committedAt: applied.receipt.committedAt,
      },
      replayed: replayed.outcome,
      signed,
      conflict: conflict.outcome === "rejected" ? conflict.error.code : null,
      refusals,
      pathMerchantId: pathId.ok ? "provisioned" : "refused",
      window: kept.settings,
      secondMerchant: {
        receiptId: secondApplied.receipt.receiptId,
        committedAt: secondApplied.receipt.committedAt,
      },
    });
  } finally {
    writeEvidence("REQUEST_SHAPE_ARTIFACT_DIR", "request-shape", evidence);
    backend.close();
  }
}

async function returnsPlugin(admin: CommerceAdminClient, merchant: string) {
  const plugin = (await required(admin.listPlugins(merchant))).plugins.find(
    (item) => item.pluginId === "returns",
  );
  if (plugin === undefined)
    throw new Error(`${merchant} has no returns plugin`);
  return plugin;
}

async function answer(pending: Promise<Response>) {
  const response = await pending;
  if (response.status !== 200)
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as
    | {
        outcome: "applied" | "replayed";
        receipt: {
          schemaVersion: string;
          receiptId: string;
          deliveryId: string;
          committedAt: string;
          merchantId: string;
        };
      }
    | { outcome: "rejected"; error: { code: string } };
}

async function refusal(pending: Promise<Response>) {
  const response = await pending;
  const body = (await response.json()) as { field?: string };
  return { status: response.status, field: body.field };
}
