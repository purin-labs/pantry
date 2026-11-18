/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  acceptShopifyLocationObservation,
  assignShopifyLocationClassification,
  createShopifyLocationObservationSchema,
  parseShopifyLocationObservationEnvelope,
  readShopifyLocationObservation,
} from "../src/actors/shopify-location-observation";
import {
  createCommerceProjectionSchema,
  readCurrentCommerceProjection,
} from "../src/actors/commerce-projection";
import { parseUserId } from "../src/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const ORGANISATION_ID = "organisation_shopify_locations";
const INTEGRATION_ACCOUNT_ID = "integration_shopify_locations";
const OBSERVED_AT = "2026-08-08T00:00:00.000Z";
const SHOPIFY_COMMERCE_SYSTEM = { kind: "shopify" as const, revision: 1 };
const SHOPIFY_AUTHORITY = {
  kind: "selected" as const,
  commerceSystem: SHOPIFY_COMMERCE_SYSTEM,
};
const UNSELECTED_AUTHORITY = { kind: "unselected" as const };

describe("Shopify location observations", () => {
  it("stores provider facts without fabricating a canonical Location kind", () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createShopifyLocationObservationSchema(sql);
    const input = parseEnvelope({
      revision: 1,
      eventId: "shopify-location-event-1",
    });

    expect(
      acceptShopifyLocationObservation(sql, input, UNSELECTED_AUTHORITY),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "applied",
        observation: { classification: { state: "pending" } },
      },
    });
    expect(
      acceptShopifyLocationObservation(sql, input, UNSELECTED_AUTHORITY),
    ).toMatchObject({
      ok: true,
      value: { disposition: "duplicate" },
    });
    expect(readShopifyLocationObservation(sql, input)).toMatchObject({
      ok: true,
      value: {
        providerLocationId: "8001",
        providerLocationGid: "gid://shopify/Location/8001",
        sourceRevision: 1,
        name: "Nuki warehouse",
        active: true,
        updatedAt: "2026-08-07T23:59:00.000Z",
        classification: { state: "pending" },
      },
    });
  });

  it("assigns the merchant kind once and atomically creates the canonical Location", () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createShopifyLocationObservationSchema(sql);
    createCommerceProjectionSchema(sql);
    const first = parseEnvelope({
      revision: 2,
      eventId: "shopify-location-event-2",
    });
    expect(
      acceptShopifyLocationObservation(sql, first, SHOPIFY_AUTHORITY),
    ).toMatchObject({
      ok: true,
      value: { disposition: "applied" },
    });

    const classifier = parseUserId("user_d436fc37-c4a8-563a-9b91-963da26bf9fe");
    if (!classifier.ok) throw new Error(classifier.error.code);
    const assignment = {
      organisationId: first.organisationId,
      integrationAccountId: first.integrationAccountId,
      providerLocationId: first.providerLocationId,
      expectedSourceRevision: 2,
      kind: "warehouse" as const,
      classifiedByUserId: classifier.value,
      mappingRevision: 1,
      classifiedAt: first.acceptedAt + 1,
    };
    expect(
      assignShopifyLocationClassification(
        sql,
        assignment,
        SHOPIFY_COMMERCE_SYSTEM,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "assigned",
        observation: {
          classification: {
            state: "assigned",
            kind: "warehouse",
            classifiedByUserId: "user_d436fc37-c4a8-563a-9b91-963da26bf9fe",
            mappingRevision: 1,
          },
        },
        projection: { disposition: "accepted" },
      },
    });
    expect(
      assignShopifyLocationClassification(
        sql,
        assignment,
        SHOPIFY_COMMERCE_SYSTEM,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "already_assigned",
        projection: { disposition: "duplicate" },
      },
    });
    expect(
      readCurrentCommerceProjection(sql, {
        organisationId: first.organisationId,
        kind: "location",
        canonicalId: "gid://shopify/Location/8001",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        kind: "location",
        projection: {
          name: "Nuki warehouse",
          kind: "warehouse",
        },
      },
    });

    const replay = {
      ...first,
      eventId: "shopify-location-replay",
      observedAt: "2026-08-08T00:01:00.000Z",
    };
    expect(
      acceptShopifyLocationObservation(sql, replay, SHOPIFY_AUTHORITY),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "duplicate",
        observation: { eventId: "shopify-location-event-2" },
      },
    });

    const stale = {
      ...first,
      sourceRevision: 1,
      eventId: "shopify-location-event-1",
    };
    expect(
      acceptShopifyLocationObservation(sql, stale, SHOPIFY_AUTHORITY),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "out_of_order",
        observation: { sourceRevision: 2 },
      },
    });

    const conflict = { ...first, name: "Different warehouse" };
    expect(
      acceptShopifyLocationObservation(sql, conflict, SHOPIFY_AUTHORITY),
    ).toEqual({
      ok: false,
      error: {
        code: "shopify_location_observation_conflict",
        sourceRevision: 2,
      },
    });

    const newer = parseEnvelope({
      revision: 3,
      eventId: "shopify-location-event-3",
    });
    expect(
      acceptShopifyLocationObservation(sql, newer, SHOPIFY_AUTHORITY),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "applied",
        observation: {
          sourceRevision: 3,
          classification: { state: "assigned", kind: "warehouse" },
        },
      },
    });
    expect(
      readCurrentCommerceProjection(sql, {
        organisationId: first.organisationId,
        kind: "location",
        canonicalId: "gid://shopify/Location/8001",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        kind: "location",
        projection: { provenance: { revision: 3 } },
      },
    });
    expect(
      assignShopifyLocationClassification(
        sql,
        {
          ...assignment,
          expectedSourceRevision: 3,
        },
        SHOPIFY_COMMERCE_SYSTEM,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        disposition: "already_assigned",
        projection: {
          disposition: "duplicate",
          observations: [{ revision: 3 }],
        },
      },
    });
    expect(
      assignShopifyLocationClassification(
        sql,
        {
          ...assignment,
          expectedSourceRevision: 3,
          kind: "fulfillment_center",
          mappingRevision: 2,
        },
        SHOPIFY_COMMERCE_SYSTEM,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "shopify_location_classification_conflict",
        mappingRevision: 1,
      },
    });
  });

  it("rejects malformed source envelopes at the boundary", () => {
    expect(
      parseShopifyLocationObservationEnvelope(
        { apiVersion: "2026-07", resource: { kind: "location" } },
        1,
      ),
    ).toEqual({
      ok: false,
      error: { code: "shopify_location_observation_invalid", field: "context" },
    });
    const pending = locationEnvelope({
      revision: 1,
      eventId: "shopify-location-event-assigned",
    });
    const assigned = {
      ...pending,
      resource: {
        ...pending.resource,
        resource: {
          ...pending.resource.resource,
          classification: { state: "assigned", kind: "warehouse" },
        },
      },
    };
    expect(
      parseShopifyLocationObservationEnvelope(
        assigned,
        Date.parse(OBSERVED_AT),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "shopify_location_observation_invalid",
        field: "resource.resource.classification",
      },
    });
  });
});

function parseEnvelope(input: {
  readonly revision: number;
  readonly eventId: string;
}) {
  const parsed = parseShopifyLocationObservationEnvelope(
    locationEnvelope(input),
    Date.parse(OBSERVED_AT),
  );
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function locationEnvelope(input: {
  readonly revision: number;
  readonly eventId: string;
}) {
  return {
    apiVersion: "2026-07",
    context: {
      organisationId: ORGANISATION_ID,
      integrationAccountId: INTEGRATION_ACCOUNT_ID,
      revision: input.revision,
      occurredAt: OBSERVED_AT,
      observedAt: OBSERVED_AT,
      eventId: input.eventId,
      customerReference: "shopify-location",
    },
    resource: {
      kind: "location",
      resource: {
        id: "gid://shopify/Location/8001",
        name: "Nuki warehouse",
        classification: { state: "pending" },
        active: true,
        updatedAt: "2026-08-07T23:59:00.000Z",
      },
    },
  };
}
