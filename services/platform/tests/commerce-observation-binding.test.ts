/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  createSessionInformationFlowSchema,
  recordCommerceObservationEntities,
  sessionObservedCommerceEntity,
} from "@purin-labs/agent/actors/agent-session-information-flow";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const ORGANISATION = "organisation_observation_binding";
const SESSION = "session_observation_binding";
const OTHER_SESSION = "session_observation_other";
const DIGEST = "a".repeat(64);

describe("commerce observation binding", () => {
  it("admits only the records a read returned, at the revision it saw", () => {
    const sql = schema();
    recordCommerceObservationEntities({
      sql,
      organisationId: ORGANISATION,
      sessionId: SESSION,
      evidenceDigest: DIGEST,
      entities: [
        { entityType: "offer", entityId: "offer_matcha_latte", revision: 3 },
        { entityType: "product", entityId: "product_matcha", revision: 1 },
      ],
      observedAt: 1_000,
    });

    expect(observed(sql, "offer", "offer_matcha_latte", 3)).toBe(true);
    expect(observed(sql, "product", "product_matcha", 1)).toBe(true);

    // A record the read never returned cannot be proposed against, even with a
    // plausible identifier.
    expect(observed(sql, "offer", "offer_hojicha_latte", 3)).toBe(false);
    // Nor can a different revision of a record that was returned.
    expect(observed(sql, "offer", "offer_matcha_latte", 4)).toBe(false);
    // Nor can the same identifier under a different entity type.
    expect(observed(sql, "product", "offer_matcha_latte", 3)).toBe(false);
  });

  it("keeps one session's observations out of another's", () => {
    const sql = schema();
    recordCommerceObservationEntities({
      sql,
      organisationId: ORGANISATION,
      sessionId: SESSION,
      evidenceDigest: DIGEST,
      entities: [
        { entityType: "order", entityId: "order_pickup", revision: 2 },
      ],
      observedAt: 1_000,
    });
    expect(observed(sql, "order", "order_pickup", 2)).toBe(true);
    expect(
      sessionObservedCommerceEntity({
        sql,
        organisationId: ORGANISATION,
        sessionId: OTHER_SESSION,
        entityType: "order",
        entityId: "order_pickup",
        revision: 2,
      }),
    ).toBe(false);
  });

  it("keeps one organisation's observations out of another's", () => {
    const sql = schema();
    recordCommerceObservationEntities({
      sql,
      organisationId: ORGANISATION,
      sessionId: SESSION,
      evidenceDigest: DIGEST,
      entities: [
        { entityType: "order", entityId: "order_pickup", revision: 2 },
      ],
      observedAt: 1_000,
    });
    expect(
      sessionObservedCommerceEntity({
        sql,
        organisationId: "organisation_other",
        sessionId: SESSION,
        entityType: "order",
        entityId: "order_pickup",
        revision: 2,
      }),
    ).toBe(false);
  });

  it("records the same record twice from two reads without duplicating it", () => {
    const sql = schema();
    for (const digest of [DIGEST, "b".repeat(64)]) {
      recordCommerceObservationEntities({
        sql,
        organisationId: ORGANISATION,
        sessionId: SESSION,
        evidenceDigest: digest,
        entities: [
          { entityType: "shipment", entityId: "shipment_customs", revision: 5 },
        ],
        observedAt: 1_000,
      });
    }
    expect(observed(sql, "shipment", "shipment_customs", 5)).toBe(true);
  });

  it("ignores a record with no usable identity or revision", () => {
    const sql = schema();
    recordCommerceObservationEntities({
      sql,
      organisationId: ORGANISATION,
      sessionId: SESSION,
      evidenceDigest: DIGEST,
      entities: [
        { entityType: "offer", entityId: "", revision: 3 },
        { entityType: "", entityId: "offer_blank_type", revision: 3 },
        { entityType: "offer", entityId: "offer_zero_revision", revision: 0 },
      ],
      observedAt: 1_000,
    });
    expect(observed(sql, "offer", "offer_zero_revision", 0)).toBe(false);
    expect(observed(sql, "offer", "offer_blank_type", 3)).toBe(false);
  });
});

function schema(): SqlStorage {
  const sql = sqlStorage(emptySqliteFixture().storage);
  createSessionInformationFlowSchema(sql);
  return sql;
}

function observed(
  sql: SqlStorage,
  entityType: string,
  entityId: string,
  revision: number,
): boolean {
  return sessionObservedCommerceEntity({
    sql,
    organisationId: ORGANISATION,
    sessionId: SESSION,
    entityType,
    entityId,
    revision,
  });
}
