import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import type { GrantSubject, RequestAuthority } from "@purin-labs/contracts";
import type {
  CommerceGraphQueryResult,
  CommerceContextRequest,
} from "@purin-labs/commerce-contracts";
import {
  parseCommerceGraphQuery,
  parseCommerceGraphResponse,
  CommerceAdminClient,
  CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";

import { catalogHarnessToolCatalogDigest } from "../src/agent-tools/catalog/selection";
import { createCatalogHarnessCodeMode } from "../src/agent-tools/catalog/code-mode";
import { TOOL_REGISTRY } from "../src/agent-tools/registry";
import type {
  HarnessCodeModeAuthority,
} from "../src/agent-tools/catalog/types";
import type { AccessGrant } from "../src/authorization/access-grants/types";
import { CommerceGraphReader } from "../src/commerce/entity-plane/graph-reader";
import { runMerchantReport } from "../src/commerce/entity-plane/merchant-report-runner";
import { CommerceEngineSource } from "../src/commerce/entity-plane/commerce-source";
import {
  assembleCommerceContext,
  selectCommerceContextSourceGrant,
} from "../src/commerce/entity-plane/context-read";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { isRecord } from "@purin-labs/std";
import {
  startCommerceWorker,
  type CommerceWorker,
} from "./commerce-fixture-worker";

const NOW = "2026-09-27T08:00:00.000Z";
const SOURCE_TIME = "2026-09-27T07:00:00.000Z";
const ORGANISATION_ID = required(parseOrganisationId("organisation_urk_read_acceptance"));
const MERCHANT_ID = "merchant_urk_read_acceptance";
const INTEGRATION_ID = "integration_urk_commerce";
const AUTHORITY: RequestAuthority = {
  kind: "shared_conversation",
  organisationId: ORGANISATION_ID,
  requesterPersonId: "person_urk_operator",
  membershipRevision: 1,
  role: "operator",
  connectorId: "connector_urk_slack",
  integrationAccountId: "integration_urk_slack",
  conversationId: "channel_urk_operations",
};

it(
  "reads paged payment and shipment evidence through the tool host and real Commerce HTTP/SQLite, fences access and rejects mixed reports",
  acceptsCommerceReads,
  30_000,
);

async function acceptsCommerceReads(): Promise<void> {
  const fixture = await createFixture();
  try {
    const inventory = await fixture.admin.readMigrationInventory(MERCHANT_ID);
    if (!inventory.ok) throw new Error(JSON.stringify(inventory.error));
    const migrationInventory = {
      resources: inventory.value.resources,
      migrationDigest: inventory.value.migrationDigest,
    };
    const input = readInput(fixture);
    const paymentRequest = pageRequest("payment", null);
    const grant = required(
      selectCommerceContextSourceGrant({ ...input, request: paymentRequest }),
    );
    expect(grant.grantId).toBe("grant_channel_payment");

    const payments = required(
      await runMerchantReport({ ...input, name: "payment_failures" }),
    );
    expect(payments).toMatchObject({
      kind: "reported",
      value: 30,
      populationTruncated: true,
    });
    if (payments.kind !== "reported")
      throw new Error("Expected payment report");
    expect(payments.population).toHaveLength(25);
    expect(payments.freshness).toContainEqual({
      state: "current",
      observedAt: SOURCE_TIME,
    });

    const shipments = required(
      await runMerchantReport({ ...input, name: "fulfillment_exceptions" }),
    );
    expect(shipments).toMatchObject({ kind: "reported", value: 1 });

    const catalogSelection = {
      allowedCapabilities: ["commerce.entity_plane.context"] as const,
    };
    const tools = required(
      await createCatalogHarnessCodeMode({
        registry: TOOL_REGISTRY,
        expectedCatalogDigest: await catalogHarnessToolCatalogDigest(
          TOOL_REGISTRY,
          catalogSelection,
        ),
        catalogSelection,
        admission: {
          begin: unexpectedCapability,
          claim: unexpectedCapability,
          complete: unexpectedCapability,
          settle: unexpectedCapability,
          abandon: unexpectedCapability,
        },
        claimCapability: acceptCapability,
        services: {
          commerce: {
            readEntityContext: readContext.bind(null, fixture),
            readMerchantReport: readReport.bind(null, fixture),
          },
        },
      }),
    );

    const mixedRead = await tools.executeTool(
      "commerce_entity_context",
      JSON.stringify({
        request: contextRequest({
          kind: "entity_seeds",
          seeds: [
            { origin: "system", typeId: "order", entityId: "order_shipment" },
            {
              origin: "system",
              typeId: "fulfillment",
              entityId: "fulfillment_shipment",
            },
          ],
        }),
      }),
      "mixed_investigation",
    );
    expect(mixedRead.status).toBe("failed");
    expect(readToolResult(mixedRead)).toMatchObject({
      ok: false,
      error: {
        code: "read_failed",
        message: expect.stringContaining(
          "Read orders, payments and fulfillments in separate calls",
        ),
      },
    });

    const identifiers: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    do {
      const request = pageRequest("payment", cursor);
      const page = await tools.executeTool(
        "commerce_entity_context",
        JSON.stringify({ request }),
        `payment_page_${pageCount}`,
      );
      expect(page.status).toBe("succeeded");
      const output = readToolResult(page);
      const parsed = parseToolGraph(output);
      identifiers.push(...parsed.entities.map(recordId));
      cursor = parsed.nextCursor;
      pageCount += 1;
      if (pageCount > 4) throw new Error("Payment pagination did not converge");
    } while (cursor !== null);
    expect(pageCount).toBe(3);
    expect(new Set(identifiers).size).toBe(30);
    expect(identifiers).not.toContain("payment_captured");

    const malformedPageRead = await tools.executeTool(
      "commerce_entity_context",
      JSON.stringify({
        request: {
          ...exactRequest("fulfillment", "fulfillment_shipment"),
          selection: {
            kind: "selector",
            selector: {
              selectorId: "type:fulfillment",
              revision: 1,
              query: {
                kind: "entity_type_page",
                entityTypeId: { origin: "system", typeId: "fulfillment" },
                filter: { kind: "all" },
                sorts: [],
                pagination: { limit: 10, cursor: null },
              },
              traversal: { maxDepth: 0, resultLimit: 10 },
            },
          },
        },
      }),
      "malformed_fulfillment_page",
    );
    expect(malformedPageRead.status).toBe("failed");
    expect(readToolResult(malformedPageRead)).toMatchObject({
      ok: false,
      error: {
        code: "read_failed",
        message: expect.stringContaining(
          "place traversal inside selector.query",
        ),
      },
    });

    const fulfillmentRead = await tools.executeTool(
      "commerce_entity_context",
      JSON.stringify({
        request: contextRequest({
          kind: "selector",
          selector: {
            selectorId: "type:fulfillment",
            revision: 1,
            query: {
              kind: "entity_type_page",
              entityTypeId: { origin: "system", typeId: "fulfillment" },
              filter: { kind: "all" },
              sorts: [],
              pagination: { limit: 10, cursor: null },
              traversal: { maxDepth: 0, resultLimit: 10 },
            },
          },
        }),
      }),
      "fulfillment_deadline_sweep",
    );
    expect(fulfillmentRead.status).toBe("succeeded");
    const fulfillmentPage = parseToolGraph(readToolResult(fulfillmentRead));
    expect(fulfillmentPage.entities.map(recordId)).toEqual([
      "fulfillment_shipment",
    ]);
    expect(fulfillmentPage.entities[0]?.attributes).toContainEqual(
      expect.objectContaining({
        attributeId: "expected_by",
        value: { kind: "timestamp", value: SOURCE_TIME },
      }),
    );

    const detail = await tools.executeTool(
      "commerce_entity_context",
      JSON.stringify({
        request: exactRequest("shipment", "shipment_exception"),
      }),
      "shipment_investigation",
    );
    expect(detail.status).toBe("succeeded");
    const shipmentDetail = parseToolGraph(readToolResult(detail));
    expect(shipmentDetail.entities.map(recordId)).toEqual([
      "shipment_exception",
    ]);
    expect(shipmentDetail.entities[0]?.attributes).toContainEqual(
      expect.objectContaining({
        attributeId: "lifecycle",
        value: { kind: "status", value: "delivery_exception" },
      }),
    );

    fixture.grants = fixture.grants.filter(isOperatorGrant);
    const denied = await assembleCommerceContext({
      ...readInput(fixture),
      request: paymentRequest,
    });
    expect(denied).toEqual({
      ok: false,
      error: { code: "commerce_context_authority_denied" },
    });
    fixture.grants = sourceGrants();

    fixture.changeAfterCount = true;
    const changed = required(
      await runMerchantReport({
        ...readInput(fixture),
        name: "payment_failures",
      }),
    );
    expect(changed).toMatchObject({
      kind: "unavailable",
      dependency: "consistent_merchant_snapshot",
    });
    const refreshed = required(
      await runMerchantReport({
        ...readInput(fixture),
        name: "payment_failures",
      }),
    );
    expect(refreshed).toMatchObject({ kind: "reported", value: 29 });

    await writeRecords(
      fixture.commerce,
      Array.from({ length: 30 }, (_, index) =>
        fixturePayment(
          paymentId(index),
          `order_${paymentId(index)}`,
          "captured",
          2,
        ),
      ),
      true,
    );
    const empty = required(
      await runMerchantReport({
        ...readInput(fixture),
        name: "payment_failures",
      }),
    );
    expect(empty).toMatchObject({
      kind: "reported",
      value: 0,
      population: [],
      populationTruncated: false,
      freshness: [{ state: "unavailable", reason: expect.any(String) }],
    });

    const investigation = await investigatePaymentAttempts(fixture, tools);

    const artifact = resolve(
      process.cwd(),
      "../../output/acceptance/plan39-selective-integration/commerce-reads.json",
    );
    mkdirSync(resolve(artifact, ".."), { recursive: true });
    writeFileSync(
      artifact,
      JSON.stringify(
        {
          scenario: "Urk commerce read integration",
          sourceTime: SOURCE_TIME,
          reportTime: NOW,
          selectedGrant: grant.grantId,
          mixedRead: readToolResult(mixedRead),
          malformedPageRead: readToolResult(malformedPageRead),
          migrationInventory,
          payments,
          shipments,
          pageCount,
          paymentIds: identifiers,
          shipmentDetail,
          fulfillmentPage,
          denied,
          changed,
          refreshed,
          empty,
          investigation,
          boundary:
            "Tool host, source-grant selection, graph reader, Commerce HTTP API and SQLite. No model or Slack delivery is simulated by this test.",
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await fixture.commerce.dispose();
  }
}

async function investigatePaymentAttempts(
  fixture: Fixture,
  tools: HarnessCodeModeAuthority,
) {
  const orderId = "order_repeated_attempts";
  await writeRecords(
    fixture.commerce,
    [
      fixtureOrder(orderId),
      fixturePayment("attempt_first", orderId, "failed", 1),
      fixturePayment("attempt_retry", orderId, "failed", 1),
    ],
    true,
  );

  const order = await tools.executeTool(
    "commerce_entity_context",
    JSON.stringify({ request: exactRequest("order", orderId) }),
    "order_investigation",
  );
  expect(order.status).toBe("succeeded");
  const orderDetail = parseToolGraph(readToolResult(order));
  expect(orderDetail.entities.map(recordId)).toEqual([orderId]);
  expect(orderDetail.entities[0]?.attributes).toContainEqual(
    expect.objectContaining({
      attributeId: "lifecycle",
      value: { kind: "status", value: "confirmed" },
    }),
  );

  const failed = await tools.executeTool(
    "commerce_entity_context",
    JSON.stringify({ request: exactRequest("payment", "attempt_first") }),
    "payment_investigation",
  );
  expect(failed.status).toBe("succeeded");
  const failedDetail = parseToolGraph(readToolResult(failed));
  expect(failedDetail.entities[0]?.attributes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        attributeId: "order_id",
        value: { kind: "short_text", value: orderId },
      }),
      expect.objectContaining({
        attributeId: "failed_at",
        value: { kind: "timestamp", value: SOURCE_TIME },
      }),
      expect.objectContaining({
        attributeId: "failure_reason",
        value: { kind: "short_text", value: "Card declined" },
      }),
    ]),
  );

  const linkedRequest = contextRequest({
    kind: "selector",
    selector: {
      selectorId: "payments_for_order",
      revision: 1,
      query: {
        kind: "entity_type_page",
        entityTypeId: { origin: "system", typeId: "payment" },
        filter: {
          kind: "attribute",
          filter: {
            operator: "equals",
            attributeId: "order_id",
            value: { kind: "short_text", value: orderId },
          },
        },
        sorts: [],
        pagination: { limit: 10, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 10 },
      },
    },
  });
  const before = await tools.executeTool(
    "commerce_entity_context",
    JSON.stringify({ request: linkedRequest }),
    "linked_attempts_before",
  );
  expect(before.status).toBe("succeeded");
  const beforeDetail = parseToolGraph(readToolResult(before));
  expect(beforeDetail.entities.map(recordId).sort()).toEqual([
    "attempt_first",
    "attempt_retry",
  ]);

  await writeRecords(
    fixture.commerce,
    [fixturePayment("attempt_success", orderId, "captured", 1)],
    true,
  );
  const after = await tools.executeTool(
    "commerce_entity_context",
    JSON.stringify({ request: linkedRequest }),
    "linked_attempts_after",
  );
  expect(after.status).toBe("succeeded");
  const afterDetail = parseToolGraph(readToolResult(after));
  expect(afterDetail.entities.map(recordId).sort()).toEqual([
    "attempt_first",
    "attempt_retry",
    "attempt_success",
  ]);
  const success = afterDetail.entities.find(isSuccessfulAttempt);
  expect(success?.attributes).toContainEqual(
    expect.objectContaining({
      attributeId: "captured_at",
      value: { kind: "timestamp", value: NOW },
    }),
  );
  expect(success?.attributes.some(isFailureAttribute)).toBe(false);

  const batched = await tools.executeTool(
    "commerce_entity_context",
    JSON.stringify({
      request: contextRequest({
        kind: "entity_seeds",
        seeds: [
          { origin: "system", typeId: "payment", entityId: "attempt_first" },
          { origin: "system", typeId: "payment", entityId: "attempt_retry" },
          { origin: "system", typeId: "payment", entityId: "attempt_success" },
        ],
      }),
    }),
    "batched_attempts_after_resolution",
  );
  expect(batched.status).toBe("succeeded");
  const batchedDetail = parseToolGraph(readToolResult(batched));
  expect(batchedDetail.entities.map(recordId).sort()).toEqual([
    "attempt_first",
    "attempt_retry",
    "attempt_success",
  ]);
  expect(batchedDetail.entities).toEqual(
    expect.arrayContaining(afterDetail.entities),
  );

  const fulfillment = await tools.executeTool(
    "commerce_entity_context",
    JSON.stringify({
      request: exactRequest("fulfillment", "fulfillment_shipment"),
    }),
    "fulfillment_deadline",
  );
  expect(fulfillment.status).toBe("succeeded");
  const fulfillmentDetail = parseToolGraph(readToolResult(fulfillment));
  expect(fulfillmentDetail.entities[0]?.attributes).toContainEqual(
    expect.objectContaining({
      attributeId: "expected_by",
      value: { kind: "timestamp", value: SOURCE_TIME },
    }),
  );
  return {
    orderDetail,
    failedDetail,
    beforeDetail,
    afterDetail,
    batchedDetail,
    fulfillmentDetail,
  };
}

function isSuccessfulAttempt(
  entity: CommerceGraphQueryResult["entities"][number],
): boolean {
  return entity.reference.entityId === "attempt_success";
}

function isFailureAttribute(
  attribute: CommerceGraphQueryResult["entities"][number]["attributes"][number],
): boolean {
  return (
    attribute.attributeId === "failed_at" ||
    attribute.attributeId === "failure_reason"
  );
}

type Fixture = {
  commerce: CommerceWorker;
  admin: CommerceAdminClient;
  reader: CommerceGraphReader;
  grants: readonly AccessGrant[];
  changeAfterCount: boolean;
};

type FixtureRecord = Readonly<{ kind: string; record: unknown }>;

async function createFixture(): Promise<Fixture> {
  const commerceEngine = await startCommerceWorker({ now: NOW });
  const admin = new CommerceAdminClient({
    baseUrl: commerceEngine.baseUrl,
    serviceToken: commerceEngine.serviceToken,
    fetch: commerceEngine.fetch,
  });
  const provisioned = await admin.provisionMerchant({
    schemaVersion: "commerce.provision-merchant.v2",
    externalReference: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    createdAt: SOURCE_TIME,
  });
  if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));
  // Imported marketplace data, written as a provider import writes it.
  await writeRecords(
    commerceEngine,
    [
      {
        kind: "sales_channel",
        record: {
          id: "channel_shop",
          revision: 1,
          name: "Existing store",
          kind: "marketplace",
          lifecycle: { state: "active", activeAt: SOURCE_TIME },
          occurredAt: SOURCE_TIME,
        },
      },
      {
        kind: "location",
        record: {
          id: "location_shipping",
          revision: 1,
          name: "Dispatch",
          kind: "warehouse",
          lifecycle: { state: "active", activeAt: SOURCE_TIME },
          occurredAt: SOURCE_TIME,
        },
      },
      ...Array.from({ length: 30 }, (_, index) => [
        fixtureOrder(`order_${paymentId(index)}`),
        fixturePayment(paymentId(index), `order_${paymentId(index)}`, "failed", 1),
      ]).flat(),
      fixtureOrder("order_payment_captured"),
      fixturePayment("payment_captured", "order_payment_captured", "captured", 1),
      fixtureOrder("order_shipment"),
      {
        kind: "fulfillment",
        record: {
          id: "fulfillment_shipment",
          revision: 1,
          orderId: "order_shipment",
          locationId: "location_shipping",
          lineItems: [{ lineItemId: "line_1", quantity: 1 }],
          expectedBy: SOURCE_TIME,
          occurredAt: SOURCE_TIME,
          kind: "shipping",
          binding: { kind: "external", sourceReference: "shipment_exception" },
          lifecycle: {
            state: "handed_to_carrier",
            handedOverAt: SOURCE_TIME,
            shipmentId: "shipment_exception",
          },
        },
      },
      {
        kind: "shipment",
        record: {
          id: "shipment_exception",
          revision: 1,
          orderId: "order_shipment",
          fulfillmentId: "fulfillment_shipment",
          kind: "external",
          carrier: "Test carrier",
          trackingNumber: "TRACK-1",
          estimatedDeliveryAt: SOURCE_TIME,
          events: [],
          occurredAt: SOURCE_TIME,
          lifecycle: {
            state: "delivery_exception",
            occurredAt: SOURCE_TIME,
            reason: "Carrier customs hold",
          },
        },
      },
    ],
    true,
  );
  const transport = { commerce: commerceEngine, changeAfterCount: false };
  const client = new CommerceEntityPlaneClient({
    baseUrl: commerceEngine.baseUrl,
    serviceToken: commerceEngine.serviceToken,
    fetch: fetchCommerce.bind(null, transport),
  });
  return Object.assign(transport, {
    admin,
    grants: sourceGrants(),
    reader: new CommerceGraphReader({
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      commerce: new CommerceEngineSource({
        organisationId: ORGANISATION_ID,
        merchantId: MERCHANT_ID,
        integrationAccountId: INTEGRATION_ID,
        client,
      }),
    }),
  });
}

async function writeRecords(
  commerceEngine: CommerceWorker,
  records: readonly FixtureRecord[],
  advanceRevision: boolean,
): Promise<void> {
  await commerceEngine.fixture(MERCHANT_ID, {
    kind: "write_commerce_records",
    records,
    advanceRevision,
  });
}

async function fetchCommerce(
  fixture: Pick<Fixture, "commerce" | "changeAfterCount">,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const response = await fixture.commerce.fetch(request);
  if (
    fixture.changeAfterCount &&
    new URL(request.url).pathname.endsWith("/query-plan")
  ) {
    const body = await response.clone().json();
    if (
      isRecord(body) &&
      isRecord(body.result) &&
      Array.isArray(body.result.aggregations) &&
      body.result.aggregations.length > 0
    ) {
      fixture.changeAfterCount = false;
      await writeRecords(
        fixture.commerce,
        [fixturePayment(paymentId(0), `order_${paymentId(0)}`, "captured", 2)],
        true,
      );
    }
  }
  return response;
}

function readInput(fixture: Fixture) {
  return {
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    grants: fixture.grants,
    requestAuthority: AUTHORITY,
    causationId: "turn_urk_read_acceptance",
    reader: fixture.reader,
    allowedSensitivity: "internal" as const,
    now: NOW,
  };
}

async function readContext(
  fixture: Fixture,
  request: CommerceContextRequest,
) {
  return required(
    await assembleCommerceContext({ ...readInput(fixture), request }),
  );
}

async function readReport(
  fixture: Fixture,
  request: {
    name: import("../src/commerce/entity-plane/merchant-reports").MerchantReportName;
  },
) {
  return required(
    await runMerchantReport({ ...readInput(fixture), name: request.name }),
  );
}

function sourceGrants(): readonly AccessGrant[] {
  const grants: AccessGrant[] = [];
  for (const entityType of [
    "payment",
    "shipment",
    "order",
    "fulfillment",
  ] as const) {
    grants.push(
      sourceGrant(`grant_operator_${entityType}`, entityType, {
        kind: "organisation_role",
        role: "operator",
      }),
    );
    grants.push(
      sourceGrant(`grant_channel_${entityType}`, entityType, {
        kind: "conversation",
        integrationAccountId: "integration_urk_slack",
        conversationId: "channel_urk_operations",
      }),
    );
  }
  return grants;
}

function sourceGrant(
  grantId: string,
  entityType: "payment" | "shipment" | "order" | "fulfillment",
  subject: GrantSubject,
): AccessGrant {
  return {
    grantId,
    organisationId: ORGANISATION_ID,
    subject,
    target: {
      kind: "commerce_read",
      capabilityId: "commerce.entity.read",
      capabilityVersion: 1,
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "system", typeId: entityType },
      },
    },
    provenance: {
      kind: "integration_setup",
      integrationAccountId: INTEGRATION_ID,
      setupRevision: 1,
      materializationReceiptId: `receipt_${grantId}`,
    },
    lifecycle: { kind: "active", revision: 1, activatedAt: 1 },
  };
}

function pageRequest(
  typeId: "payment" | "shipment",
  cursor: string | null,
): CommerceContextRequest {
  return contextRequest({
    kind: "selector",
    selector: {
      selectorId: `type:${typeId}`,
      revision: 1,
      query: {
        kind: "entity_type_page",
        entityTypeId: { origin: "system", typeId },
        filter: {
          kind: "attribute",
          filter: {
            operator: "equals",
            attributeId: "lifecycle",
            value: {
              kind: "status",
              value: typeId === "payment" ? "failed" : "delivery_exception",
            },
          },
        },
        sorts: [],
        pagination: { limit: 10, cursor },
        traversal: { maxDepth: 0, resultLimit: 10 },
      },
    },
  });
}

function exactRequest(
  typeId: "payment" | "shipment" | "order" | "fulfillment",
  entityId: string,
): CommerceContextRequest {
  return contextRequest({
    kind: "entity_seeds",
    seeds: [{ origin: "system", typeId, entityId }],
  });
}

function contextRequest(selection: unknown): CommerceContextRequest {
  const query = parseCommerceGraphQuery({
    kind: "commerce_context",
    selection,
    traversal: { maxDepth: 0, resultLimit: 10 },
    allowedSensitivity: "internal",
    allowedAttributeIds: [
      "lifecycle",
      "order_id",
      "failed_at",
      "failure_reason",
      "captured_at",
      "expected_by",
    ],
    freshnessRequirement: "current_only",
  });
  if (query.kind !== "commerce_context")
    throw new Error("Invalid context fixture");
  return query;
}

function fixturePayment(
  id: string,
  orderId: string,
  state: "failed" | "captured",
  revision: number,
): FixtureRecord {
  const occurredAt = state === "captured" ? NOW : SOURCE_TIME;
  return {
    kind: "payment",
    record: {
      id,
      revision,
      orderId,
      amount: { amountMinor: 2500, currency: "JPY" },
      occurredAt,
      lifecycle:
        state === "failed"
          ? { state, failedAt: occurredAt, reason: "Card declined" }
          : { state, capturedAt: occurredAt },
    },
  };
}

function fixtureOrder(id: string): FixtureRecord {
  const zero = { amountMinor: 0, currency: "JPY" };
  const price = { amountMinor: 2500, currency: "JPY" };
  return {
    kind: "order",
    record: {
      id,
      revision: 1,
      origin: {
        kind: "marketplace",
        salesChannelId: "channel_shop",
        marketplaceOrderId: id,
      },
      buyer: { kind: "guest" },
      lineItems: [
        {
          id: "line_1",
          source: {
            kind: "source_only",
            sourceItemReference: "existing-shop-product",
          },
          sku: "BOX",
          title: "Seasonal box",
          quantity: { amount: 1, scale: 0, unit: "each" },
          fulfilledQuantity: { amount: 0, scale: 0, unit: "each" },
          unitPrice: price,
          tax: zero,
          discount: zero,
          lineTotal: price,
        },
      ],
      totals: {
        subtotal: price,
        discount: zero,
        tax: zero,
        duty: zero,
        shipping: zero,
        serviceFee: zero,
        tip: zero,
        rounding: zero,
        total: price,
      },
      adjustments: [],
      lifecycle: { state: "confirmed", confirmedAt: SOURCE_TIME },
      occurredAt: SOURCE_TIME,
    },
  };
}

function paymentId(index: number): string {
  return `payment_${String(index).padStart(2, "0")}`;
}
function recordId(
  entity: CommerceGraphQueryResult["entities"][number],
): string {
  return entity.reference.entityId;
}
function isOperatorGrant(grant: AccessGrant): boolean {
  return grant.subject.kind === "organisation_role";
}
async function unexpectedCapability(): Promise<never> {
  throw new Error("Unselected capability invoked");
}
async function acceptCapability(): Promise<{ ok: true; value: null }> {
  return { ok: true, value: null };
}
function required<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function readToolResult(
  result: import("@purin-labs/contracts").AuthorizedHarnessToolResult,
): unknown {
  if (
    result.output.kind !== "inline" ||
    result.output.content[0]?.kind !== "text"
  )
    throw new Error("Missing tool output");
  return JSON.parse(result.output.content[0].text);
}

function parseToolGraph(output: unknown): CommerceGraphQueryResult {
  if (!isRecord(output) || output.ok !== true)
    throw new Error("Missing commerce tool result");
  return parseCommerceGraphResponse(output.result);
}
