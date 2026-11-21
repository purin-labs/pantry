import { describe, expect, it } from "vitest";
import {
  parseCommerceListEntryRef,
  parseCommerceRelationshipRef,
  parseEntityPlanePublishedResourceMetadataRequest,
  parseEntityPlanePublishedResourceMetadataResponse,
  parsePublishedCommerceSelector,
} from "@purin-labs/commerce-client";

import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import { EntityPlaneService } from "../src/entity-plane/service.ts";
import { listRelationships } from "../src/entity-plane/relationships.ts";
import { refreshCommerceRelationshipRelation } from "../src/entity-plane/commerce-relationship-relation.ts";
import { CommerceAuthority } from "../src/commerce-authority.ts";
import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import { CommerceHttpApi } from "../src/http.ts";
import { DeterministicPaymentGateway } from "../src/payments/provider.ts";
import { createJapanShippingGateway } from "../src/plugins/japan-export/index.ts";

const NOW = "2026-08-26T00:00:00.000Z";
const SIGNER = {
  keyId: "published-resource-test",
  publicKeyB64: "published-resource-test-public-key",
  sign: (payload: Uint8Array): string =>
    Buffer.from(payload).toString("base64url"),
};

describe("Commerce published-resource metadata", () => {
  it("enumerates published definitions and resolves each resource branch", async () => {
    const database = new NodeCommerceDatabase(":memory:");
    initializeCommerceSchema(database, NOW);
    database
      .prepare(
        `INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
      )
      .run("merchant_metadata", "organisation_metadata", NOW, NOW);
    const service = new EntityPlaneService({
      database,
      now: () => NOW,
      signer: SIGNER,
    });
    service.seedExportCoordinationPreset("merchant_metadata");

    const enumerated = service.readPublishedResourceMetadata({
      kind: "enumerate",
      organisationId: "organisation_metadata",
      merchantId: "merchant_metadata",
    });
    expect(enumerated.kind).toBe("enumerated");
    if (enumerated.kind !== "enumerated")
      throw new Error("enumerated response expected");
    expect(enumerated.entityTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "system",
          typeId: "shipment",
          lexiconSchemaRevision: 1,
        }),
        expect.objectContaining({
          origin: "custom",
          typeId: "trade_partner",
          publishedRevision: 1,
        }),
      ]),
    );
    expect(enumerated.lists).toEqual([
      expect.objectContaining({
        listId: "export_coordination",
        publishedRevision: 1,
      }),
    ]);
    const board = enumerated.views.find(
      (view) => view.viewId === "export_board",
    );
    expect(board).toMatchObject({
      viewId: "export_board",
      revision: 1,
      presentation: {
        kind: "board",
        configuration: { laneAttributeId: "stage" },
      },
    });
    if (board === undefined) throw new Error("export board expected");

    const entityTypeResource = service.readPublishedResourceMetadata(
      parseEntityPlanePublishedResourceMetadataRequest({
        kind: "resolve",
        organisationId: "organisation_metadata",
        merchantId: "merchant_metadata",
        resource: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: "trade_partner" },
        },
      }),
    );
    expect(entityTypeResource).toMatchObject({
      kind: "resolved",
      resource: {
        kind: "entity_type",
        entityType: {
          origin: "custom",
          typeId: "trade_partner",
          publishedRevision: 1,
        },
      },
    });

    const list = enumerated.lists[0];
    if (list === undefined) throw new Error("published list expected");
    const listResource = service.readPublishedResourceMetadata({
      kind: "resolve",
      organisationId: "organisation_metadata",
      merchantId: "merchant_metadata",
      resource: { kind: "commerce_list", listId: list.listId },
    });
    expect(listResource).toMatchObject({
      kind: "resolved",
      resource: {
        kind: "commerce_list",
        list: { listId: "export_coordination", publishedRevision: 1 },
      },
    });

    database
      .prepare(
        `INSERT INTO commerce_list_entry (
         merchant_id, entry_id, list_id, list_revision,
         entity_origin, entity_type_id, entity_id, revision,
         lifecycle_state, created_at, updated_at, updated_at_ms, membership_kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unique_entity')`,
      )
      .run(
        "merchant_metadata",
        "entry_metadata",
        "export_coordination",
        1,
        "system",
        "shipment",
        "shipment_metadata",
        1,
        "active",
        NOW,
        NOW,
        0,
      );
    const entryResource = service.readPublishedResourceMetadata({
      kind: "resolve",
      organisationId: "organisation_metadata",
      merchantId: "merchant_metadata",
      resource: {
        kind: "commerce_list_entry",
        entry: parseCommerceListEntryRef({
          entryId: "entry_metadata",
          listId: "export_coordination",
          revision: 1,
        }),
      },
    });
    expect(entryResource).toMatchObject({
      kind: "resolved",
      resource: {
        kind: "commerce_list_entry",
        entry: {
          entryId: "entry_metadata",
          listId: "export_coordination",
          revision: 1,
        },
        listRevision: 1,
        entityTypeId: { origin: "system", typeId: "shipment" },
        entityRef: {
          origin: "system",
          typeId: "shipment",
          entityId: "shipment_metadata",
        },
      },
    });

    database
      .prepare(
        `INSERT INTO sales_channel (
         merchant_id, resource_id, revision, name, kind,
         lifecycle_state, lifecycle_json, occurred_at
       ) VALUES (?, ?, 1, ?, 'online', 'active', ?, ?)`,
      )
      .run(
        "merchant_metadata",
        "channel_metadata",
        "Online",
        JSON.stringify({ state: "active" }),
        NOW,
      );
    database
      .prepare(
        `INSERT INTO commerce_order (
         merchant_id, resource_id, revision, sales_channel_id, origin_kind,
         buyer_kind, lifecycle_state, order_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, ?, 'online', 'guest', 'confirmed', ?, ?)`,
      )
      .run(
        "merchant_metadata",
        "order_metadata",
        "channel_metadata",
        JSON.stringify({ id: "order_metadata" }),
        NOW,
      );
    database
      .prepare(
        `INSERT INTO location (
         merchant_id, resource_id, revision, name, kind,
         lifecycle_state, lifecycle_json, occurred_at
       ) VALUES (?, ?, 1, ?, 'warehouse', 'active', ?, ?)`,
      )
      .run(
        "merchant_metadata",
        "location_metadata",
        "Warehouse",
        JSON.stringify({ state: "active" }),
        NOW,
      );
    database
      .prepare(
        `INSERT INTO fulfillment (
         merchant_id, resource_id, revision, order_id, location_id,
         fulfillment_kind, lifecycle_state, fulfillment_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, ?, ?, 'shipping', 'requested', ?, ?)`,
      )
      .run(
        "merchant_metadata",
        "fulfillment_metadata",
        "order_metadata",
        "location_metadata",
        JSON.stringify({ id: "fulfillment_metadata" }),
        NOW,
      );
    database
      .prepare(
        `INSERT INTO shipment (
         merchant_id, resource_id, revision, order_id, fulfillment_id,
         lifecycle_state, shipment_snapshot_json, occurred_at
       ) VALUES (?, ?, 1, ?, ?, 'ready', ?, ?)`,
      )
      .run(
        "merchant_metadata",
        "shipment_metadata",
        "order_metadata",
        "fulfillment_metadata",
        JSON.stringify({ id: "shipment_metadata" }),
        NOW,
      );

    const systemRelationship = listRelationships(
      database,
      "merchant_metadata",
      13,
      undefined,
      undefined,
    ).find((relationship) => relationship.origin === "system");
    expect(systemRelationship).toBeDefined();
    if (systemRelationship === undefined)
      throw new Error("system relationship expected");
    refreshCommerceRelationshipRelation(database, "merchant_metadata");
    const relationshipResource = service.readPublishedResourceMetadata({
      kind: "resolve",
      organisationId: "organisation_metadata",
      merchantId: "merchant_metadata",
      resource: {
        kind: "relationship",
        relationship: {
          origin: systemRelationship.origin,
          relationshipId: systemRelationship.relationshipId,
          definition: systemRelationship.definition,
          revision: systemRelationship.revision,
        },
      },
    });
    expect(relationshipResource).toMatchObject({
      kind: "resolved",
      resource: { kind: "relationship" },
    });

    expect(() =>
      service.readPublishedResourceMetadata({
        kind: "resolve",
        organisationId: "organisation_metadata",
        merchantId: "merchant_metadata",
        resource: {
          kind: "relationship",
          relationship: parseCommerceRelationshipRef({
            origin: systemRelationship.origin,
            relationshipId: systemRelationship.relationshipId,
            definition: systemRelationship.definition,
            revision: Number(systemRelationship.revision) + 1,
          }),
        },
      }),
    ).toThrow("Published resource not found");

    const selector = parsePublishedCommerceSelector({
      selectorId: "export_board",
      revision: board.revision,
      query: {
        kind: "saved_commerce_view",
        viewId: "export_board",
        pagination: { limit: 20, cursor: null },
      },
    });
    const selectorResource = service.readPublishedResourceMetadata({
      kind: "resolve",
      organisationId: "organisation_metadata",
      merchantId: "merchant_metadata",
      resource: { kind: "saved_selector", selector },
    });
    expect(selectorResource).toMatchObject({
      kind: "resolved",
      resource: {
        kind: "saved_selector",
        selector: { selectorId: "export_board", revision: 1 },
        view: { viewId: "export_board", revision: 1 },
      },
    });

    expect(() =>
      service.readPublishedResourceMetadata({
        kind: "resolve",
        organisationId: "organisation_metadata",
        merchantId: "merchant_metadata",
        resource: {
          kind: "saved_selector",
          selector: parsePublishedCommerceSelector({
            selectorId: "export_board",
            revision: 1,
            query: {
              kind: "entity_type_page",
              entityTypeId: { origin: "system", typeId: "shipment" },
              filter: { kind: "all" },
              sorts: [],
              pagination: { limit: 20, cursor: null },
              traversal: { maxDepth: 0, resultLimit: 20 },
            },
          }),
        },
      }),
    ).toThrow("Published resource not found");

    const staleEntryEvidence = service.readPublishedResourceMetadata({
      kind: "resolve",
      organisationId: "organisation_metadata",
      merchantId: "merchant_metadata",
      resource: {
        kind: "commerce_list_entry",
        entry: parseCommerceListEntryRef({
          entryId: "entry_metadata",
          listId: "export_coordination",
          revision: 2,
        }),
      },
    });
    expect(staleEntryEvidence).toMatchObject({
      kind: "resolved",
      resource: {
        kind: "commerce_list_entry",
        entry: {
          entryId: "entry_metadata",
          listId: "export_coordination",
          revision: 1,
        },
      },
    });

    expect(() =>
      service.readPublishedResourceMetadata({
        kind: "resolve",
        organisationId: "organisation_metadata",
        merchantId: "merchant_metadata",
        resource: {
          kind: "saved_selector",
          selector: parsePublishedCommerceSelector({
            ...selector,
            revision: 2,
          }),
        },
      }),
    ).toThrow("Published resource not found");

    database
      .prepare(
        `UPDATE commerce_list_head
       SET lifecycle_state = 'archived'
       WHERE merchant_id = ? AND list_id = ?`,
      )
      .run("merchant_metadata", "export_coordination");
    expect(() =>
      service.readPublishedResourceMetadata(
        parseEntityPlanePublishedResourceMetadataRequest({
          kind: "resolve",
          organisationId: "organisation_metadata",
          merchantId: "merchant_metadata",
          resource: { kind: "commerce_list", listId: "export_coordination" },
        }),
      ),
    ).toThrow("Published resource not found");

    expect(() =>
      service.readPublishedResourceMetadata({
        kind: "enumerate",
        organisationId: "organisation_other",
        merchantId: "merchant_metadata",
      }),
    ).toThrow("outside the organisation authority");

    const encoded =
      parseEntityPlanePublishedResourceMetadataResponse(enumerated);
    expect(encoded.kind).toBe("enumerated");
    database.close();
  });

  it("protects the published-resource route with the service token", async () => {
    const database = new NodeCommerceDatabase(":memory:");
    initializeCommerceSchema(database, NOW);
    const authority = new CommerceAuthority({
      database,
      signer: SIGNER,
      paymentGateway: new DeterministicPaymentGateway(),
      now: () => NOW,
      shippingGateway: createJapanShippingGateway(
        "published-resource-shipping-key",
      ),
    });
    authority.provisionMerchant({
      schemaVersion: "commerce.provision-merchant.v2",
      externalReference: "organisation_route",
      merchantId: "merchant_route",
      createdAt: NOW,
    });
    const service = new EntityPlaneService({
      database,
      now: () => NOW,
      signer: SIGNER,
    });
    service.seedExportCoordinationPreset("merchant_route");
    const api = new CommerceHttpApi({
      authority,
      buyerSessions: new BuyerSessionAuthority({
        secret: "published-resource-buyer-secret-0123456789",
        now: () => NOW,
      }),
      serviceToken: "published-resource-service-token",
      entityPlane: service,
    });
    const url =
      "https://commerce.test/v1/admin/merchants/merchant_route/entity-plane/published-resources";
    const request = {
      kind: "enumerate",
      organisationId: "organisation_route",
      merchantId: "merchant_route",
    };
    const unauthorized = await api.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(unauthorized.status).toBe(401);
    const authorized = await api.fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer published-resource-service-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    expect(authorized.status).toBe(200);
    expect(
      parseEntityPlanePublishedResourceMetadataResponse(
        await authorized.json(),
      ),
    ).toMatchObject({
      kind: "enumerated",
      organisationId: "organisation_route",
      merchantId: "merchant_route",
      views: expect.arrayContaining([
        expect.objectContaining({ viewId: "export_board" }),
      ]),
    });
    authority.close();
  });
});
