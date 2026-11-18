import {
  CommerceAdminClient,
  type CommerceFirstPartyShipmentV1,
} from "@seams/commerce-client";
import type { ShippingRouteBinding } from "@seams/commerce-contracts";
import { pathToFileURL } from "node:url";

import { createJapanShippingGateway } from "../src/plugins/japan-export/index.ts";

type AdvanceArguments = Readonly<{
  organisationId: string;
  merchantId: string;
  orderId: string;
  baseUrl: string;
  serviceToken: string;
  carrierSigningKey: string;
}>;

type FirstPartyShipment = CommerceFirstPartyShipmentV1;

if (isMainModule()) await main();

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2), process.env);
  const client = new CommerceAdminClient({
    baseUrl: arguments_.baseUrl,
    serviceToken: arguments_.serviceToken,
  });
  const gateway = createJapanShippingGateway(arguments_.carrierSigningKey);

  let { snapshot, shipment } = await readShipment(client, arguments_);
  if (shipment.lifecycle.state === "ready") {
    const rate = await client.quoteShipmentLabelRate({
      merchantId: arguments_.merchantId,
      idempotencyKey: `advance_${shipment.id}_rate`,
      shipmentId: shipment.id,
      shipmentRevision: shipment.revision,
    });
    if (!rate.ok) throw stepFailure("label rate quote", rate.error.message);
    const purchased = await client.purchaseShippingLabel({
      merchantId: arguments_.merchantId,
      expectedMerchantRevision: snapshot.merchantRevision,
      idempotencyKey: `advance_${shipment.id}_label`,
      shipmentId: shipment.id,
      shipmentRevision: rate.value.rate.shipmentRevision,
      labelRateId: rate.value.rate.labelRateId,
      labelAttemptId: `label_attempt_${shipment.id}_1`,
    });
    if (!purchased.ok)
      throw stepFailure("label purchase", purchased.error.message);
    if (purchased.value.outcome === "rejected") {
      throw stepFailure(
        "label purchase",
        JSON.stringify(purchased.value.error),
      );
    }
    ({ snapshot, shipment } = await readShipment(client, arguments_));
  }

  for (const state of ["in_transit", "delivered"] as const) {
    if (shipmentStateRank(shipment.lifecycle.state) >= shipmentStateRank(state))
      continue;
    const event = {
      shipmentId: shipment.id,
      state,
      providerEventId: `advance_${shipment.id}_${state}`,
      occurredAt: now(),
      location:
        state === "in_transit"
          ? "Tokyo"
          : snapshot.routeBinding.kind === "domestic_japan"
            ? "Japan"
            : "Singapore",
    };
    const recorded = await client.recordShippingTracking({
      merchantId: arguments_.merchantId,
      expectedMerchantRevision: snapshot.merchantRevision,
      idempotencyKey: `advance_${shipment.id}_${state}`,
      shipmentId: shipment.id,
      shipmentRevision: shipment.revision,
      event: {
        ...event,
        signature: gateway.signTrackingEvent({
          routeBinding: snapshot.routeBinding,
          serviceCode: snapshot.serviceCode,
          ...event,
        }),
      },
    });
    if (!recorded.ok)
      throw stepFailure(`tracking ${state}`, recorded.error.message);
    if (recorded.value.outcome === "rejected") {
      throw stepFailure(
        `tracking ${state}`,
        JSON.stringify(recorded.value.error),
      );
    }
    ({ snapshot, shipment } = await readShipment(client, arguments_));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        orderId: arguments_.orderId,
        shipmentId: shipment.id,
        shipmentRevision: shipment.revision,
        state: shipment.lifecycle.state,
        merchantRevision: snapshot.merchantRevision,
      },
      null,
      2,
    )}\n`,
  );
}

async function readShipment(
  client: CommerceAdminClient,
  arguments_: AdvanceArguments,
): Promise<
  Readonly<{
    snapshot: Readonly<{
      merchantRevision: number;
      routeBinding: ShippingRouteBinding;
      serviceCode: string;
    }>;
    shipment: FirstPartyShipment;
  }>
> {
  const snapshot = await client.readSnapshot(arguments_.merchantId);
  if (!snapshot.ok)
    throw stepFailure("snapshot readback", snapshot.error.message);
  const shipment = snapshot.value.resources.shipments.find(
    (candidate) =>
      candidate.kind === "first_party" &&
      candidate.orderId === arguments_.orderId,
  );
  if (shipment === undefined || shipment.kind !== "first_party") {
    throw stepFailure(
      "shipment lookup",
      `no first-party shipment for ${arguments_.orderId}`,
    );
  }
  const fulfillment = snapshot.value.resources.fulfillments.find(
    (candidate) => candidate.id === shipment.fulfillmentId,
  );
  if (
    fulfillment?.kind !== "shipping" ||
    fulfillment.binding.kind !== "first_party_checkout"
  ) {
    throw stepFailure(
      "shipment route lookup",
      `no accepted shipping route for ${shipment.id}`,
    );
  }
  return {
    snapshot: {
      merchantRevision: snapshot.value.merchantRevision,
      routeBinding: fulfillment.binding.acceptedShippingQuote.routeBinding,
      serviceCode:
        fulfillment.binding.acceptedShippingQuote.carrierRate.service.code,
    },
    shipment,
  };
}

function shipmentStateRank(state: string): number {
  switch (state) {
    case "ready":
      return 0;
    case "label_purchased":
      return 1;
    case "in_transit":
      return 2;
    case "delivered":
      return 3;
    default:
      return 4;
  }
}

function now(): string {
  return new Date().toISOString();
}

function stepFailure(operation: string, message: string): Error {
  return new Error(`${operation} failed: ${message}`);
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  return (
    scriptPath !== undefined &&
    import.meta.url === pathToFileURL(scriptPath).href
  );
}

function parseArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): AdvanceArguments {
  const values = new Map<string, string>();
  const start = argv[0] === "--" ? 1 : 0;
  for (let index = start; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(
        "Usage: advance-local-shipment --organisation <organisation_id> --merchant <merchant_id> --order <order_id>",
      );
    }
    values.set(flag, value);
  }
  return {
    organisationId: requireIdentity(
      values.get("--organisation"),
      "--organisation",
      "organisation_",
    ),
    merchantId: requireIdentity(
      values.get("--merchant"),
      "--merchant",
      "merchant_",
    ),
    orderId: requireIdentity(values.get("--order"), "--order", "order_"),
    baseUrl: env.UNDERCLERK_BASE_URL ?? "http://127.0.0.1:7800",
    serviceToken: requireSecret(
      env.UNDERCLERK_SERVICE_TOKEN,
      "UNDERCLERK_SERVICE_TOKEN",
    ),
    carrierSigningKey: requireSecret(
      env.JAPAN_CARRIER_SIGNING_KEY,
      "JAPAN_CARRIER_SIGNING_KEY",
    ),
  };
}

function requireIdentity(
  value: string | undefined,
  field: string,
  prefix: string,
): string {
  if (
    value === undefined ||
    !value.startsWith(prefix) ||
    value !== value.trim()
  ) {
    throw new Error(`${field} must be a normalized ${prefix} identity`);
  }
  return value;
}

function requireSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
