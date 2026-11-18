import { describe, expect, it } from "vitest";

import { upsertUser } from "../src/data/control-plane";
import {
  newControlMutationIdentity,
  parseControlMutationBoundary,
  prepareControlMutationReceipt,
  readControlMutationReplay,
} from "../src/data/control-mutation";
import { createMigratedDatabase } from "./sqlite-d1";

describe("control mutation receipts", () => {
  it("replays the canonical receipt and rejects one key used with another body", async () => {
    const db = createMigratedDatabase();
    const owner = await upsertUser({
      db,
      identity: {
        issuer: "https://accounts.google.com",
        subject: "mutation-owner",
        email: "mutation@example.com",
        displayName: "Mutation Owner",
        emailVerified: true,
      },
      now: 1,
    });
    const first = await parseControlMutationBoundary({
      request: mutationRequest("mutation-key-0001"),
      body: { environment: "development", name: "Merchant" },
      requireConfigurationVersion: false,
    });
    const reordered = await parseControlMutationBoundary({
      request: mutationRequest("mutation-key-0001"),
      body: { name: "Merchant", environment: "development" },
      requireConfigurationVersion: false,
    });
    if (!first.ok || !reordered.ok) {
      throw new Error("valid mutation boundary was rejected");
    }
    expect(reordered.value.requestHash).toBe(first.value.requestHash);
    const scope = {
      userId: owner.userId,
      organisationScope: "organisation:create",
      route: "/v1/control/organisations",
      operation: "organisation.create",
    };
    const identity = newControlMutationIdentity({
      portalSubjectHash: "subject-hash",
      causationId: "request-1",
      now: 10,
    });
    await prepareControlMutationReceipt(db, {
      scope,
      boundary: first.value,
      identity,
      responseStatus: 201,
      responseBody: {
        receipt_id: identity.receiptId,
        organisation_id: "organisation_1",
      },
    }).run();

    await expect(
      readControlMutationReplay({
        db,
        scope,
        boundary: first.value,
      }),
    ).resolves.toEqual({
      kind: "replay",
      receipt: {
        responseStatus: 201,
        responseBody: {
          receipt_id: identity.receiptId,
          organisation_id: "organisation_1",
        },
      },
    });

    const conflicting = await parseControlMutationBoundary({
      request: mutationRequest("mutation-key-0001"),
      body: { environment: "production", name: "Merchant" },
      requireConfigurationVersion: false,
    });
    if (!conflicting.ok) {
      throw new Error("valid conflicting mutation boundary was rejected");
    }
    await expect(
      readControlMutationReplay({
        db,
        scope,
        boundary: conflicting.value,
      }),
    ).resolves.toEqual({ kind: "conflict" });
  });

  it("requires a positive configuration fence for versioned mutations", async () => {
    await expect(
      parseControlMutationBoundary({
        request: mutationRequest("mutation-key-0002"),
        body: {},
        requireConfigurationVersion: true,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "configuration_version_missing" },
    });
  });
});

function mutationRequest(idempotencyKey: string): Request {
  return new Request("https://satyr.example/v1/control/organisations", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
}
