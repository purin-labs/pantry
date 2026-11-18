/// <reference types="@cloudflare/workers-types" />

import type {
  AttachmentId,
  MessageAttachmentPreparationIdentity,
  MessageAttachmentPreparationLimits,
  MessageAttachmentPreparationReceipt,
  MessageAttachmentPreparationState,
  OrganisationAttachmentObjectKey,
} from "@seams/contracts";
import { describe, expect, test } from "vitest";

import {
  beginMessagePreparation,
  completeMessagePreparation,
  createMessagePreparationSchema,
  listMessagePreparationObjectKeys,
  readMessagePreparation,
} from "../src/actors/message-preparation-store";
import {
  emptySqliteFixture,
  sqlStorage,
  TestSqlStorage,
} from "./sqlite-storage";
import type { Variant } from "@seams/type-utils";

const ORGANISATION = "organisation_preparation";
const SESSION = "session_preparation";
const TURN = "turn_preparation";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const ATTACHMENT_A = attachmentId("a");
const ATTACHMENT_B = attachmentId("b");
const ATTACHMENT_C = attachmentId("c");
const RESULT_KEY = objectKey("result.json");
const MANIFEST_KEY = objectKey("manifest.json");
const LIMITS: MessageAttachmentPreparationLimits = {
  maxInputBytes: 10_000,
  maxOutputBytes: 20_000,
  maxDurationMs: 1_000,
  maxFrames: 4,
};

type PendingPreparation = Variant<MessageAttachmentPreparationState, "pending">;

const IDENTITY: MessageAttachmentPreparationIdentity = {
  organisationId: ORGANISATION,
  sessionId: SESSION,
  turnId: TURN,
  attachmentId: ATTACHMENT_A,
  sourceSha256: DIGEST_A,
  handlerRevision: "message-preparation.v1",
};

describe("message preparation store", function messagePreparationStoreSuite() {
  test("survives a storage restart and accepts one exact completion", function persistsLifecycle() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createMessagePreparationSchema(sql);
    expect(listMessagePreparationObjectKeys(sql)).toEqual([]);

    const pending = pendingPreparation();
    expect(beginMessagePreparation(sql, pending)).toEqual({
      ok: true,
      value: pending,
    });

    const restarted = sqlStorage(new TestSqlStorage(fixture.database));
    expect(readMessagePreparation(restarted, IDENTITY)).toEqual({
      ok: true,
      value: pending,
    });

    const receipt = preparationReceipt();
    const completed = completeMessagePreparation(restarted, receipt);
    expect(completed).toEqual({
      ok: true,
      value: { kind: "completed", receipt },
    });
    expect(completeMessagePreparation(sql, receipt)).toEqual(completed);
    expect(readMessagePreparation(restarted, IDENTITY)).toEqual(completed);
    expect(listMessagePreparationObjectKeys(restarted)).toEqual([
      RESULT_KEY,
      MANIFEST_KEY,
    ]);
  });

  test("rejects identity, limit, and immutable-receipt conflicts", function fencesIdentityAndReceipt() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createMessagePreparationSchema(sql);
    const pending = pendingPreparation();
    expect(beginMessagePreparation(sql, pending)).toEqual({
      ok: true,
      value: pending,
    });

    expect(
      beginMessagePreparation(
        sql,
        pendingPreparation({ ...IDENTITY, sourceSha256: DIGEST_B }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "message_preparation_identity_conflict" },
    });
    expect(
      beginMessagePreparation(
        sql,
        pendingPreparation(IDENTITY, {
          ...LIMITS,
          maxFrames: LIMITS.maxFrames + 1,
        }),
      ),
    ).toEqual({
      ok: false,
      error: { code: "message_preparation_receipt_conflict" },
    });

    const receipt = preparationReceipt();
    expect(completeMessagePreparation(sql, receipt)).toMatchObject({
      ok: true,
    });
    expect(
      completeMessagePreparation(sql, {
        ...receipt,
        resultDigest: DIGEST_C,
      }),
    ).toEqual({
      ok: false,
      error: { code: "message_preparation_receipt_conflict" },
    });
    expect(
      completeMessagePreparation(sql, {
        ...receipt,
        identity: { ...IDENTITY, handlerRevision: "message-preparation.v2" },
      }),
    ).toEqual({
      ok: false,
      error: { code: "message_preparation_identity_conflict" },
    });
    expect(readMessagePreparation(sql, IDENTITY)).toEqual({
      ok: true,
      value: { kind: "completed", receipt },
    });
  });

  test("enforces completion deadline and measured elapsed time", function boundsCompletion() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createMessagePreparationSchema(sql);
    const pending = pendingPreparation(IDENTITY, LIMITS, 100, 150);
    expect(beginMessagePreparation(sql, pending)).toMatchObject({ ok: true });

    expect(
      completeMessagePreparation(
        sql,
        preparationReceipt(IDENTITY, LIMITS, 151),
      ),
    ).toEqual({
      ok: false,
      error: { code: "message_preparation_receipt_invalid" },
    });
    expect(
      completeMessagePreparation(sql, {
        ...preparationReceipt(IDENTITY, LIMITS, 110),
        usage: { activeWallMs: 11, inputBytes: 1, outputBytes: 1 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "message_preparation_receipt_invalid" },
    });
  });

  test("fails closed on unknown and malformed persisted JSON", function rejectsUntrustedRows() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createMessagePreparationSchema(sql);
    const unknownIdentity = identityFor(ATTACHMENT_B, DIGEST_B);
    const malformedIdentity = identityFor(ATTACHMENT_C, DIGEST_C);

    fixture.database
      .prepare(
        `INSERT INTO session_message_preparation
       (organisation_id, session_id, turn_id, attachment_id, state_json)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        unknownIdentity.organisationId,
        unknownIdentity.sessionId,
        unknownIdentity.turnId,
        unknownIdentity.attachmentId,
        JSON.stringify({ kind: "future" }),
      );
    fixture.database.exec("PRAGMA ignore_check_constraints = ON");
    fixture.database
      .prepare(
        `INSERT INTO session_message_preparation
       (organisation_id, session_id, turn_id, attachment_id, state_json)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        malformedIdentity.organisationId,
        malformedIdentity.sessionId,
        malformedIdentity.turnId,
        malformedIdentity.attachmentId,
        "{malformed",
      );
    fixture.database.exec("PRAGMA ignore_check_constraints = OFF");

    expect(readMessagePreparation(sql, unknownIdentity)).toEqual({
      ok: false,
      error: { code: "message_preparation_state_invalid" },
    });
    expect(readMessagePreparation(sql, malformedIdentity)).toEqual({
      ok: false,
      error: { code: "message_preparation_state_invalid" },
    });
    expect(() => listMessagePreparationObjectKeys(sql)).toThrow(
      "message_preparation_state_invalid",
    );
    expect(
      readMessagePreparation(sql, {
        ...IDENTITY,
        sourceSha256: "not-a-sha256",
      }),
    ).toEqual({
      ok: false,
      error: { code: "message_preparation_input_invalid" },
    });
  });
});

function pendingPreparation(
  identity: MessageAttachmentPreparationIdentity = IDENTITY,
  limits: MessageAttachmentPreparationLimits = LIMITS,
  startedAt = 100,
  deadlineAt = 1_000,
): PendingPreparation {
  return { kind: "pending", identity, limits, startedAt, deadlineAt };
}

function preparationReceipt(
  identity: MessageAttachmentPreparationIdentity = IDENTITY,
  limits: MessageAttachmentPreparationLimits = LIMITS,
  completedAt = 200,
): MessageAttachmentPreparationReceipt {
  return {
    identity,
    limits,
    resultDigest: DIGEST_B,
    derivedObjectKeys: [RESULT_KEY, MANIFEST_KEY],
    usage: { activeWallMs: 50, inputBytes: 100, outputBytes: 200 },
    completedAt,
    outcome: { kind: "prepared", resultObjectKey: RESULT_KEY },
  };
}

function identityFor(
  attachmentId: AttachmentId,
  sourceSha256: string,
): MessageAttachmentPreparationIdentity {
  return { ...IDENTITY, attachmentId, sourceSha256 };
}

function attachmentId(suffix: string): AttachmentId {
  return `att_${suffix.repeat(32)}` as AttachmentId;
}

function objectKey(name: string): OrganisationAttachmentObjectKey {
  return `attachments/${ORGANISATION}/derived/${DIGEST_A}/preparation/${name}` as OrganisationAttachmentObjectKey;
}
