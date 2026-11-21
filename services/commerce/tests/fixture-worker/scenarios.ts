// Named seed scenarios of the fixture Worker. A client suite posts
// { kind, ...input } to /v1/admin/merchants/:merchantId/test-fixture. Each
// scenario writes Commerce state that no public route creates, or acts as
// an outside party (the carrier), so client suites need no Commerce source.
import {
  CommerceAdminClient,
  parseFulfillment,
  parseLocation,
  parseOrder,
  parsePayment,
  parseSalesChannel,
  parseShipment,
} from "@purin-labs/commerce-client";
import { isRecord } from "@purin-labs/std";
import { createPrivateKey, createPublicKey, sign as signPayload } from "node:crypto";

import {
  writeFulfillment,
  writeLocation,
  writeOrder,
  writePayment,
  writeSalesChannel,
  writeShipment,
} from "../../src/commerce-persistence.ts";
import type { CommerceDatabase } from "../../src/database.ts";
import type { CommerceSigner } from "../../src/commerce-authority/contracts.ts";
import { refreshCommerceAttributeRelation } from "../../src/entity-plane/commerce-attribute-relation.ts";
import { EntityPlaneService } from "../../src/entity-plane/service.ts";
import { createJapanShippingGateway } from "../../src/plugins/japan-export/index.ts";
import type { ShippingTrackingEventInput } from "../../src/shipping-gateway.ts";
import type { Env } from "../../src/worker.ts";
import { configurePhase4Shipping } from "../../scripts/configure-plan22-phase4-shipping.ts";
import { rebuildPhase3Cafe } from "../../scripts/rebuild-plan22-phase3-cafe.ts";
import { seedEntityPlaneParityCorpus } from "./entity-plane-parity-corpus.ts";
import { verifyInventoryOutboxMigration } from "./journeys/inventory-outbox-signing-fixture.ts";
import { makeMailSupplierAmbiguous, seedMailOrder, seedMailPurchasing } from "./journeys/mail-purchasing-fixture.ts";
import { resolveAttentionPayment, seedOrderAttention } from "./journeys/order-attention-fixture.ts";
import { seedOrderCapacity } from "./journeys/order-capacity-fixture.ts";

export type FixtureScenarioContext = Readonly<{
  database: CommerceDatabase;
  storage: DurableObjectStorage;
  merchantId: string;
  now: () => string;
  env: Env;
  /** The production merchant routes of the same Durable Object. */
  api: (request: Request) => Promise<Response>;
  /** The identity of this start of the Durable Object. */
  instance: string;
  /** Stops the Durable Object after this answer, as an idle period does. */
  stopAfterAnswer: () => void;
}>;

type Scenario = (context: FixtureScenarioContext, input: Record<string, unknown>) => unknown | Promise<unknown>;

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  /** Moves the merchant watermark, as an outside write would. */
  advance_merchant_revision: ({ database, merchantId, now }) => {
    database
      .prepare("UPDATE merchant SET revision = revision + 1, updated_at = ? WHERE merchant_id = ?")
      .run(now(), merchantId);
    return readMerchantRevision(database, merchantId);
  },
  /** The real-store corpus of Platform's entity-plane parity test. */
  entity_plane_parity_corpus: ({ database, merchantId, now }, input) =>
    seedEntityPlaneParityCorpus(database, {
      organisationId: requireText(input.organisationId, "organisationId"),
      merchantId,
      now,
    }),
  /**
   * Imported records, as a provider import writes them without commands:
   * { records: [{ kind: "order", record }, …], advanceRevision?: true }.
   * Each record is parsed by the client contract first.
   */
  write_commerce_records: ({ database, merchantId }, input) => {
    if (!Array.isArray(input.records)) throw new Error("Fixture input records must be a list");
    database.transaction(() => {
      for (const entry of input.records as unknown[]) writeCommerceRecord(database, merchantId, entry);
      refreshCommerceAttributeRelation(database, merchantId);
      if (input.advanceRevision === true)
        database.prepare("UPDATE merchant SET revision = revision + 1 WHERE merchant_id = ?").run(merchantId);
    });
    return readMerchantRevision(database, merchantId);
  },
  /** The Plan 22 phase 3 café: the cafe_patisserie demo, ready to publish its menu. */
  plan22_phase3_cafe: (context, input) =>
    rebuildPhase3Cafe(selfClient(context), {
      organisationId: requireText(input.organisationId, "organisationId"),
      merchantId: context.merchantId,
    }),
  /** Plan 22 phase 4 shipping on top of the phase 3 café. */
  plan22_phase4_shipping: (context, input) =>
    configurePhase4Shipping(selfClient(context), {
      organisationId: requireText(input.organisationId, "organisationId"),
      merchantId: context.merchantId,
    }),
  // Seeds of Pantry Platform's E2E journeys (formerly an in-process fixture).
  order_capacity: ({ database, merchantId }) => seedOrderCapacity(database, merchantId),
  order_attention: ({ database, merchantId }) => seedOrderAttention(database, merchantId),
  order_attention_resolve: ({ database, merchantId }) => resolveAttentionPayment(database, merchantId),
  mail_purchasing: ({ database, merchantId, now, env }, input) =>
    seedMailPurchasing(
      database,
      new EntityPlaneService({ database, now, signer: fixtureSigner(env) }),
      merchantId,
      requireText(input.organisationId, "organisationId"),
    ),
  mail_supplier_ambiguous: ({ database, merchantId }) => makeMailSupplierAmbiguous(database, merchantId),
  mail_order: ({ database, merchantId }) => seedMailOrder(database, merchantId),
  /** An inventory position that reports only its available quantity. */
  inventory_available_only: ({ database, merchantId }, input) => {
    database
      .prepare(
        "UPDATE inventory_position SET balance_kind = 'available_only', on_hand_amount = NULL, allocated_amount = NULL, revision = revision + 1 WHERE merchant_id = ? AND inventory_position_id = ? AND allocated_amount = 0",
      )
      .run(merchantId, requireText(input.positionId, "positionId"));
    database.prepare("UPDATE merchant SET revision = revision + 1 WHERE merchant_id = ?").run(merchantId);
  },
  outbox_status: ({ database, merchantId }) =>
    database
      .prepare(
        "SELECT status, rejected_reason AS reason, COUNT(*) AS count FROM observation_outbox WHERE merchant_id = ? GROUP BY status, rejected_reason",
      )
      .all(merchantId),
  /**
   * The rows that this object changed since it started, with the identity of
   * that start. A client suite reads it before and after a run to count the
   * rows that the run wrote; Cloudflare bills each written row.
   */
  storage_row_changes: ({ database, instance }) => ({
    instance,
    changes: database.prepare("SELECT total_changes() AS changes").get<{ changes: number }>()?.changes ?? 0,
  }),
  /** Stops the object, so that the next request starts it again. */
  stop_object: ({ stopAfterAnswer }) => stopAfterAnswer(),
  outbox_signing_migration: ({ database, merchantId, env }) =>
    verifyInventoryOutboxMigration(database, merchantId, fixtureSigner(env)),
  /**
   * Arms a lost response: the first publish-catalog-listing that commits
   * answers 503 e2e_committed_response_lost. Counters never reset, so a
   * second arming keeps them.
   */
  lose_first_committed_publish: async ({ storage }) => {
    const current = await storage.get<EffectEvidence>(EFFECT_EVIDENCE_KEY);
    if (current === undefined) await storage.put(EFFECT_EVIDENCE_KEY, EMPTY_EFFECT_EVIDENCE);
    return (await storage.get<EffectEvidence>(EFFECT_EVIDENCE_KEY)) ?? EMPTY_EFFECT_EVIDENCE;
  },
  /**
   * Every row of the named tables for this merchant, in a fixed order:
   * { tables: ["merchant", "product", …] }. Evaluation harnesses compare
   * Commerce's records before and after a fault with these reads.
   */
  merchant_records: ({ database, merchantId }, input) => {
    if (!Array.isArray(input.tables)) throw new Error("Fixture input tables must be a list");
    const records: Record<string, readonly unknown[]> = {};
    for (const table of input.tables as unknown[]) {
      const order = typeof table === "string" ? MERCHANT_RECORD_ORDER[table] : undefined;
      if (order === undefined) throw new Error(`Fixture cannot read table ${String(table)}`);
      records[table as string] = database
        .prepare(`SELECT * FROM ${table as string} WHERE merchant_id = ? ORDER BY ${order}`)
        .all(merchantId);
    }
    return records;
  },
  /** The carrier's signature on a tracking event for the shipment's route. */
  sign_tracking_event: ({ env }, input) => ({
    signature: createJapanShippingGateway(env.JAPAN_CARRIER_SIGNING_KEY).signTrackingEvent(
      input.event as ShippingTrackingEventInput,
    ),
  }),
};

const MERCHANT_RECORD_ORDER: Readonly<Record<string, string>> = {
  merchant: "merchant_id",
  product: "resource_id",
  offer: "resource_id",
  command_receipt: "idempotency_key",
  custom_entity: "entity_id",
  custom_entity_attribute_value: "entity_id, entity_revision, attribute_id",
  commerce_relationship: "relationship_id",
};

export async function runFixtureScenario(context: FixtureScenarioContext, body: unknown): Promise<Response> {
  if (!isRecord(body) || typeof body.kind !== "string")
    return Response.json({ message: "Fixture request needs a kind" }, { status: 400 });
  const scenario = SCENARIOS[body.kind];
  if (scenario === undefined) return Response.json({ message: `Unknown fixture scenario ${body.kind}` }, { status: 404 });
  try {
    return Response.json((await scenario(context, body)) ?? { ok: true });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function readMerchantRevision(database: CommerceDatabase, merchantId: string): { merchantRevision: number } {
  const row = database
    .prepare("SELECT revision FROM merchant WHERE merchant_id = ?")
    .get<{ revision: number }>(merchantId);
  if (row === undefined) throw new Error(`Merchant ${merchantId} is not provisioned`);
  return { merchantRevision: row.revision };
}

// The seed scripts talk to Commerce through its admin client; here that
// client calls the production routes of the same Durable Object.
function selfClient(context: FixtureScenarioContext): CommerceAdminClient {
  return new CommerceAdminClient({
    baseUrl: "https://underclerk.fixture",
    serviceToken: context.env.UNDERCLERK_SERVICE_TOKEN,
    fetch: (input, init) => context.api(new Request(input, init)),
  });
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`Fixture input ${field} must be text`);
  return value;
}

function writeCommerceRecord(database: CommerceDatabase, merchantId: string, entry: unknown): void {
  if (!isRecord(entry)) throw new Error("Fixture record must be an object");
  switch (entry.kind) {
    case "sales_channel":
      return writeSalesChannel(database, merchantId, parseSalesChannel(entry.record));
    case "location":
      return writeLocation(database, merchantId, parseLocation(entry.record));
    case "order":
      return writeOrder(database, merchantId, parseOrder(entry.record));
    case "payment":
      return writePayment(database, merchantId, parsePayment(entry.record));
    case "fulfillment":
      return writeFulfillment(database, merchantId, parseFulfillment(entry.record));
    case "shipment":
      return writeShipment(database, merchantId, parseShipment(entry.record));
    default:
      throw new Error(`Unknown fixture record kind ${String(entry.kind)}`);
  }
}

export const EFFECT_EVIDENCE_KEY = "fixture:effect_evidence";

export type EffectEvidence = Readonly<{ mutations: number; receiptReads: number; committed: unknown }>;

const EMPTY_EFFECT_EVIDENCE: EffectEvidence = { mutations: 0, receiptReads: 0, committed: null };

// The Worker's own signing key, for seeds that sign as Commerce does.
function fixtureSigner(env: Env): CommerceSigner {
  const privateKey = createPrivateKey({
    key: Buffer.from(env.UNDERCLERK_SIGNING_PRIVATE_KEY_PKCS8_B64, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (jwk.x === undefined) throw new Error("Underclerk signing key must be Ed25519");
  return {
    keyId: env.UNDERCLERK_SIGNING_KEY_ID,
    publicKeyB64: jwk.x,
    sign: (payload) => signPayload(null, payload, privateKey).toString("base64url"),
  };
}
