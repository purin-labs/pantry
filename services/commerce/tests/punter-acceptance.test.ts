// Punter's buyer journeys against a disposable Commerce backend. The backend
// is the real HTTP API and SQLite store with the deterministic payment gateway
// and Japan carrier stub, seeded by seed-local-commerce.ts at a fixed clock.
// Punter runs as its own process and reaches it only over HTTP. Staff advance
// a paid order one fulfillment step each time the buyer polls it, so Punter
// observes every state and runs reproduce. Set PUNTER_ACCEPTANCE_ARTIFACT_DIR
// to keep each run's evidence.
import { clientInput } from "./command-input.ts";
import { execFileSync, spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  type CommerceClientResult,
  type CommerceResourcesV1,
  type CommerceMutationResultV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import { CommerceAuthority } from "../src/commerce-authority.ts";
import type { CommerceSigner } from "../src/commerce-authority/contracts.ts";
import { CommerceHttpApi } from "../src/http.ts";
import {
  createJapanExportShipping,
  createJapanShippingGateway,
} from "../src/plugins/japan-export/index.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { DeterministicPaymentGateway } from "../src/payments/provider.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import { createLocalShippingAddressValidationService } from "../src/shipping-address-validation.ts";
import {
  LOCAL_COMMERCE_MERCHANT,
  seedLocalCommerce,
} from "../scripts/seed-local-commerce.ts";
import type { Variant } from "@purin-labs/type-utils";

const NOW = "2026-08-14T10:00:00.000Z";
const SERVICE_TOKEN = "punter_acceptance_service_token";
const BUYER_SESSION_SECRET = "punter_acceptance_buyer_session_secret";
const CARRIER_SIGNING_KEY = "punter-acceptance-carrier-key";
const ORDER_READ = /\/checkouts\/[^/]+\/order$/u;
const REPOSITORY_DIRECTORY = fileURLToPath(
  new URL("../../../", import.meta.url),
);
const PUNTER_DIRECTORY = join(REPOSITORY_DIRECTORY, "scripts/punter");
const { organisationId, merchantId } = LOCAL_COMMERCE_MERCHANT;

type Journey = Readonly<{
  name: "pickup" | "shipping";
  command: string;
  storefrontId: string;
  scenarioVariable: "PUNTER_PICKUP_SCENARIO" | "PUNTER_SHIPPING_SCENARIO";
  scenario: string;
  runId: string;
}>;

const JOURNEYS: readonly Journey[] = [
  {
    name: "pickup",
    command: "src/cli.ts",
    storefrontId: "storefront_cafe",
    scenarioVariable: "PUNTER_PICKUP_SCENARIO",
    scenario: "local_cafe",
    runId: "punter_real_backend_pickup",
  },
  {
    name: "shipping",
    command: "src/shipping-cli.ts",
    storefrontId: "storefront_cookie_store_sg",
    scenarioVariable: "PUNTER_SHIPPING_SCENARIO",
    scenario: "local_online_cookie",
    runId: "punter_real_backend_online_cookie",
  },
];

type StaffAction = Readonly<{
  action: string;
  subject: string;
  outcome: string;
  receiptId?: string;
  effectId?: string;
}>;

type Backend = Readonly<{
  baseUrl: string;
  admin: CommerceAdminClient;
  staffActions: StaffAction[];
  close: () => Promise<void>;
}>;

type PunterRun = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

for (const journey of JOURNEYS) {
  it(
    `Punter completes the ${journey.name} journey against a disposable backend`,
    { timeout: 90_000 },
    runJourney.bind(undefined, journey),
  );
}

async function runJourney(journey: Journey): Promise<void> {
  const backend = await startBackend();
  try {
    const punter = await runPunter(journey, backend.baseUrl);
    const records = await readRecords(backend.admin);
    writeArtifacts(journey, punter, backend.staffActions, records);
    expect(punter.exitCode, `${punter.stdout}\n${punter.stderr}`).toBe(0);
    const result = JSON.parse(punter.stdout);
    expect(result.ok).toBe(true);
    // Commerce holds exactly the order Punter placed, paid once and fulfilled.
    expect(records.orders.map(recordId)).toEqual([
      result.evidence.payment.orderId,
    ]);
    expect(records.payments).toEqual([
      expect.objectContaining({
        id: result.evidence.payment.paymentId,
        lifecycle: expect.objectContaining({ state: "captured" }),
      }),
    ]);
    if (journey.name === "pickup") {
      expect(records.fulfillments).toEqual([
        expect.objectContaining({
          kind: "pickup",
          lifecycle: expect.objectContaining({ state: "completed" }),
        }),
      ]);
    } else {
      expect(records.shipments).toEqual([
        expect.objectContaining({
          lifecycle: expect.objectContaining({ state: "delivered" }),
        }),
      ]);
    }
  } finally {
    await backend.close();
  }
}

async function startBackend(): Promise<Backend> {
  const directory = mkdtempSync(join(tmpdir(), "underclerk-punter-"));
  const database = new NodeCommerceDatabase(
    join(directory, "underclerk.sqlite3"),
  );
  initializeCommerceSchema(database, NOW);
  const authority = new CommerceAuthority({
    database,
    signer: new AcceptanceSigner(),
    paymentGateway: new DeterministicPaymentGateway(now),
    now,
    shippingGateway: createJapanShippingGateway(CARRIER_SIGNING_KEY),
    shipping: createJapanExportShipping(CARRIER_SIGNING_KEY),
  });
  let sessions = 0;
  const api = new CommerceHttpApi({
    authority,
    buyerSessions: new BuyerSessionAuthority({
      secret: BUYER_SESSION_SECRET,
      now,
      newSessionId: () => `session_punter_${(sessions += 1)}`,
    }),
    addressValidations: createLocalShippingAddressValidationService(
      database,
      now,
    ),
    serviceToken: SERVICE_TOKEN,
  });
  const server = createServer();
  await listen(server);
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  const admin = new CommerceAdminClient({
    baseUrl,
    serviceToken: SERVICE_TOKEN,
    fetch: api.fetch,
  });
  const staffActions: StaffAction[] = [];
  await seedLocalCommerce(
    admin,
    new CommerceStorefrontClient({ baseUrl, fetch: api.fetch }),
  );
  await bakeSesameCookies(admin, staffActions);
  server.on(
    "request",
    serveRequest.bind(
      undefined,
      api,
      baseUrl,
      advanceFulfillment.bind(undefined, admin, staffActions),
    ),
  );
  return {
    baseUrl,
    admin,
    staffActions,
    close: async () => {
      await closeServer(server);
      authority.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function now(): string {
  return NOW;
}

/** A fixed Ed25519 key, so receipts and signatures reproduce. */
class AcceptanceSigner implements CommerceSigner {
  readonly keyId = "key_punter_acceptance";
  readonly publicKeyB64: string;
  readonly #privateKey: KeyObject;

  constructor() {
    const seed = createHash("sha256").update(this.keyId).digest();
    this.#privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        seed,
      ]),
      format: "der",
      type: "pkcs8",
    });
    this.publicKeyB64 = String(
      createPublicKey(this.#privateKey).export({ format: "jwk" }).x,
    );
  }

  sign(payload: Uint8Array): string {
    return sign(null, payload, this.#privateKey).toString("base64url");
  }
}

// The café's morning sesame cookie bake, as Platform's café operations run it.
async function bakeSesameCookies(
  admin: CommerceAdminClient,
  staffActions: StaffAction[],
): Promise<void> {
  const snapshot = await required(admin.readSnapshot(merchantId));
  const positions = snapshot.resources.inventoryPositions;
  const inputs = [
    "inventory_flour",
    "inventory_butter",
    "inventory_sugar",
    "inventory_black_sesame",
  ].map(inventoryPosition.bind(undefined, positions));
  const output = inventoryPosition(positions, "inventory_sesame_cookie");
  const key = "acceptance_sesame_cookie_bake";
  record(
    staffActions,
    "complete_production_batch",
    "production_batch_sesame_cookie_20260814_a",
    await admin.completeProductionBatch({
      merchantId,
      expectedMerchantRevision: snapshot.merchantRevision,
      idempotencyKey: key,
      productionBatchId: "production_batch_sesame_cookie_20260814_a",
      demand: { kind: "stock" },
      outputLotId: "lot_sesame_cookie_20260814_a",
      outputInventoryPositionId: output.id,
      recipeId: "recipe_sesame_cookie_stocked",
      recipeRevision: 1,
      stationId: "station_bakery",
      locationId: "location_cafe",
      plannedYield: { amount: 24, scale: 0, unit: "each" },
      actualYield: { amount: 22, scale: 0, unit: "each" },
      outputLotCode: "SESAME-COOKIE-20260814-A",
      outputExpiresAt: "2026-08-21T00:00:00.000Z",
      expectedInputPositionRevisions: inputs.map(positionRevision),
      expectedOutputPositionRevision: output.revision,
    }),
  );
}

type InventoryPosition =
  CommerceResourcesV1["inventoryPositions"][number];

function inventoryPosition(
  positions: readonly InventoryPosition[],
  inventoryItemId: string,
): InventoryPosition {
  const position = positions.find(
    (candidate) => candidate.inventoryItemId === inventoryItemId,
  );
  if (position === undefined)
    throw new Error(`Seeded café lacks ${inventoryItemId}`);
  return position;
}

function positionRevision(position: InventoryPosition) {
  return { inventoryPositionId: position.id, revision: position.revision };
}

/** Takes the next staff step for the first unfinished fulfillment. */
async function advanceFulfillment(
  admin: CommerceAdminClient,
  staffActions: StaffAction[],
): Promise<void> {
  const snapshot = await required(admin.readSnapshot(merchantId));
  for (const fulfillment of snapshot.resources.fulfillments) {
    const order = snapshot.resources.orders.find(
      (candidate) => candidate.id === fulfillment.orderId,
    );
    if (order === undefined) continue;
    const base = {
      organisationId,
      merchantId,
      expectedMerchantRevision: snapshot.merchantRevision,
      requestedAt: NOW,
    };
    if (fulfillment.kind === "pickup") {
      const done = await advancePickup(admin, staffActions, {
        base,
        order,
        fulfillment,
        payment: snapshot.resources.payments.find(
          (candidate) => candidate.orderId === order.id,
        ),
      });
      if (done) continue;
      return;
    }
    const shipment = snapshot.resources.shipments.find(
      (candidate) =>
        candidate.kind === "first_party" && candidate.orderId === order.id,
    );
    if (
      fulfillment.kind !== "shipping" ||
      fulfillment.binding.kind !== "first_party_checkout" ||
      shipment?.kind !== "first_party"
    )
      continue;
    const done = await advanceShipment(admin, staffActions, {
      base,
      shipment,
      quote: fulfillment.binding.acceptedShippingQuote,
    });
    if (!done) return;
  }
}

type Base = Readonly<{
  organisationId: string;
  merchantId: string;
  expectedMerchantRevision: number;
  requestedAt: string;
}>;
type Resources = CommerceResourcesV1;
type PickupFulfillment = Variant<Resources["fulfillments"][number], "pickup">;

/** One café staff step; true once the pickup is complete. */
async function advancePickup(
  admin: CommerceAdminClient,
  staffActions: StaffAction[],
  input: Readonly<{
    base: Base;
    order: Resources["orders"][number];
    fulfillment: PickupFulfillment;
    payment: Resources["payments"][number] | undefined;
  }>,
): Promise<boolean> {
  const { base, order, fulfillment } = input;
  const target = {
    orderId: order.id,
    orderRevision: order.revision,
    fulfillmentId: fulfillment.id,
    fulfillmentRevision: fulfillment.revision,
  };
  switch (fulfillment.lifecycle.state) {
    case "requested":
    case "preparing": {
      if (await preparationPending(admin, staffActions, input)) return false;
      const key = `staff_${fulfillment.id}_ready`;
      record(
        staffActions,
        "mark_pickup_ready",
        fulfillment.id,
        await admin.markPickupReady({
          ...clientInput(base),
          idempotencyKey: key,
          ...clientInput(target),
        }),
      );
      return false;
    }
    case "ready_for_pickup": {
      if (input.payment === undefined)
        throw new Error(`Order ${order.id} has no payment`);
      const key = `staff_${fulfillment.id}_complete`;
      record(
        staffActions,
        "complete_pickup",
        fulfillment.id,
        await admin.completePickup({
          ...clientInput(base),
          idempotencyKey: key,
          ...clientInput(target),
          paymentId: input.payment.id,
          paymentRevision: input.payment.revision,
        }),
      );
      return false;
    }
    default:
      return true;
  }
}

/** Made-to-order lines go through the bar's preparation ticket first. */
async function preparationPending(
  admin: CommerceAdminClient,
  staffActions: StaffAction[],
  input: Readonly<{
    base: Base;
    order: Resources["orders"][number];
    fulfillment: PickupFulfillment;
  }>,
): Promise<boolean> {
  const { base, order, fulfillment } = input;
  if (!order.lineItems.some(needsPreparation)) return false;
  const foodService = await required(admin.readFoodServiceSnapshot(merchantId));
  const ticketId = `preparation_ticket_${order.id}_${fulfillment.id}`;
  const ticket = foodService.resources.preparationTickets.find(
    (candidate) => candidate.ticketId === ticketId,
  );
  if (ticket?.lifecycle.state === "completed") return false;
  const operation =
    ticket === undefined
      ? {
          kind: "create" as const,
          ticketId,
          orderId: order.id,
          fulfillmentId: fulfillment.id,
          stationId: "station_bar",
        }
      : {
          kind:
            ticket.lifecycle.state === "queued"
              ? ("start" as const)
              : ("complete" as const),
          ticketId,
          expectedTicketRevision: ticket.revision,
        };
  const key = `staff_${ticketId}_${operation.kind}`;
  record(
    staffActions,
    `preparation_${operation.kind}`,
    ticketId,
    await admin.managePreparationTicket({
      ...clientInput(base),
      idempotencyKey: key,
      operation,
    }),
  );
  return true;
}

function needsPreparation(
  line: Resources["orders"][number]["lineItems"][number],
): boolean {
  return (
    line.source.kind === "food_service" &&
    line.source.preparation.kind === "immediate_recipe"
  );
}

type FirstPartyShipment = Variant<
  Resources["shipments"][number],
  "first_party"
>;
type AcceptedShippingQuote = Variant<
  Variant<Resources["fulfillments"][number], "shipping">["binding"],
  "first_party_checkout"
>["acceptedShippingQuote"];

/** One fulfillment-desk step: label, then signed carrier events; true once delivered. */
async function advanceShipment(
  admin: CommerceAdminClient,
  staffActions: StaffAction[],
  input: Readonly<{
    base: Base;
    shipment: FirstPartyShipment;
    quote: AcceptedShippingQuote;
  }>,
): Promise<boolean> {
  const { base, shipment } = input;
  switch (shipment.lifecycle.state) {
    case "ready": {
      const rate = await required(
        admin.quoteShipmentLabelRate({
          merchantId,
          idempotencyKey: `staff_${shipment.id}_rate`,
          shipmentId: shipment.id,
          shipmentRevision: shipment.revision,
        }),
      );
      const key = `staff_${shipment.id}_label`;
      record(
        staffActions,
        "purchase_shipping_label",
        shipment.id,
        await admin.purchaseShippingLabel({
          ...clientInput(base),
          idempotencyKey: key,
          shipmentId: shipment.id,
          shipmentRevision: rate.rate.shipmentRevision,
          labelRateId: rate.rate.labelRateId,
          labelAttemptId: `label_attempt_${shipment.id}_1`,
        }),
      );
      return false;
    }
    case "label_purchased":
      await recordCarrierEvent(admin, staffActions, input, "in_transit");
      return false;
    case "in_transit":
      await recordCarrierEvent(admin, staffActions, input, "delivered");
      return false;
    default:
      return true;
  }
}

async function recordCarrierEvent(
  admin: CommerceAdminClient,
  staffActions: StaffAction[],
  input: Readonly<{
    base: Base;
    shipment: FirstPartyShipment;
    quote: AcceptedShippingQuote;
  }>,
  state: "in_transit" | "delivered",
): Promise<void> {
  const { base, shipment, quote } = input;
  const event = {
    shipmentId: shipment.id,
    state,
    providerEventId: `staff_${shipment.id}_${state}`,
    occurredAt: NOW,
    location:
      state === "in_transit"
        ? "Tokyo"
        : quote.routeBinding.kind === "domestic_japan"
          ? "Japan"
          : "Singapore",
  };
  const key = `staff_${shipment.id}_${state}`;
  record(
    staffActions,
    `record_tracking_${state}`,
    shipment.id,
    await admin.recordShippingTracking({
      ...clientInput(base),
      idempotencyKey: key,
      shipmentId: shipment.id,
      shipmentRevision: shipment.revision,
      event: {
        ...event,
        signature: createJapanShippingGateway(
          CARRIER_SIGNING_KEY,
        ).signTrackingEvent({
          routeBinding: quote.routeBinding,
          serviceCode: quote.carrierRate.service.code,
          ...event,
        }),
      },
    }),
  );
}

/** Records an applied staff mutation; anything else stops the journey. */
function record(
  staffActions: StaffAction[],
  action: string,
  subject: string,
  result: CommerceClientResult<CommerceMutationResultV1>,
): void {
  if (!result.ok) throw new Error(`${action} failed: ${result.error.message}`);
  if (result.value.outcome === "rejected") {
    staffActions.push({ action, subject, outcome: "rejected" });
    throw new Error(`${action} rejected: ${result.value.error.code}`);
  }
  staffActions.push({
    action,
    subject,
    outcome: result.value.outcome,
    receiptId: result.value.receipt.receiptId,
    effectId: result.value.receipt.effectId,
  });
}

async function required<T>(
  pending: Promise<CommerceClientResult<T>>,
): Promise<T> {
  const result = await pending;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Serves the API over HTTP; a buyer's order poll first lets staff act. */
async function serveRequest(
  api: CommerceHttpApi,
  baseUrl: string,
  beforeOrderRead: () => Promise<void>,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(incoming.url ?? "/", baseUrl);
    if (incoming.method === "GET" && ORDER_READ.test(url.pathname))
      await beforeOrderRead();
    const response = await api.fetch(
      new Request(url, {
        method: incoming.method,
        headers: requestHeaders(incoming),
        body:
          incoming.method === "GET" || incoming.method === "HEAD"
            ? undefined
            : await readBody(incoming),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
  }
  return headers;
}

async function readBody(
  incoming: IncomingMessage,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const received = Buffer.concat(chunks);
  const body = new Uint8Array(received.byteLength);
  body.set(received);
  return body;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Runs Punter's own CLI; it reaches the backend only through baseUrl. */
function runPunter(journey: Journey, baseUrl: string): Promise<PunterRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", journey.command],
      {
        cwd: PUNTER_DIRECTORY,
        env: {
          ...process.env,
          PUNTER_UNDERCLERK_BASE_URL: baseUrl,
          PUNTER_MERCHANT_ID: merchantId,
          PUNTER_STOREFRONT_ID: journey.storefrontId,
          PUNTER_RUN_ID: journey.runId,
          [journey.scenarioVariable]: journey.scenario,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function readRecords(admin: CommerceAdminClient): Promise<Resources> {
  return (await required(admin.readSnapshot(merchantId))).resources;
}

function recordId(resource: Readonly<{ id: string }>): string {
  return resource.id;
}

function writeArtifacts(
  journey: Journey,
  punter: PunterRun,
  staffActions: readonly StaffAction[],
  records: Resources,
): void {
  const root = process.env.PUNTER_ACCEPTANCE_ARTIFACT_DIR;
  if (root === undefined) return;
  const directory = join(root, journey.name);
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, "run.json"), {
    journey: journey.name,
    commit: git("rev-parse", "HEAD"),
    uncommittedChanges: git(
      "status",
      "--porcelain",
      "--",
      "services/commerce",
      "scripts/punter",
      "packages",
    )
      .split("\n")
      .filter(Boolean),
    clock: NOW,
    backend: {
      api: "UnderclerkHttpApi over localhost HTTP",
      store: "disposable SQLite",
      payments: "DeterministicPaymentGateway (provider stub)",
      carrier: "createJapanShippingGateway (provider stub)",
      seed: "seedLocalCommerce, then the sesame cookie bake",
    },
    punter: {
      command: `node --experimental-strip-types ${journey.command}`,
      directory: "scripts/punter",
      environment: {
        PUNTER_MERCHANT_ID: merchantId,
        PUNTER_STOREFRONT_ID: journey.storefrontId,
        PUNTER_RUN_ID: journey.runId,
        [journey.scenarioVariable]: journey.scenario,
      },
      exitCode: punter.exitCode,
    },
  });
  writeFileSync(join(directory, "punter-output.json"), punter.stdout);
  writeJson(join(directory, "staff-actions.json"), staffActions);
  writeJson(join(directory, "merchant-records.json"), {
    orders: records.orders,
    payments: records.payments,
    fulfillments: records.fulfillments,
    shipments: records.shipments,
  });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPOSITORY_DIRECTORY,
    encoding: "utf8",
  }).trim();
}
