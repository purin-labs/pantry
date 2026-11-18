import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL as NodeUrl } from "node:url";

import { describe, expect, it } from "vitest";

import {
  approveCustomConnectorRevision,
  createCustomConnectorDraft,
  createCustomConnectorRevision,
  prepareCustomConnectorDraftDocument,
  listCustomConnectorSummaries,
  resolveCustomConnectorDetail,
  resolveCustomConnectorRevision,
  validateCustomConnectorRevision,
  type CustomConnectorApprovalReview,
  type JsonObject,
} from "../src/custom-connectors";
import { d1Database } from "./sqlite-d1";
import { isRecord } from "@seams/std";
import { requireUserId, requireOrganisationId } from "./test-ids";

const baselineSql = singleDatabaseSchema();

describe("custom connector revision persistence", function revisionSuite() {
  it("keeps draft content immutable and binds approval to validated destination and effects", async function persistsReviewLifecycle() {
    const database = new DatabaseSync(":memory:");
    database.exec(baselineSql);
    seedIdentities(database);
    const db = d1Database(database);
    const organisationId = requireOrganisationId("organisation_custom_connector");
    const authorId = requireUserId("user_10d06d84-d6fc-51b3-b7da-b518ea116d6c");
    const approverId = requireUserId("user_1ee0fca4-cbe6-52f2-bd7b-d767d7867b3d");
    const document = await prepareCustomConnectorDraftDocument(
      fixture("github-rest.json"),
    );
    expect(document.ok).toBe(true);
    if (!document.ok) return;

    const draft = await createCustomConnectorDraft({
      db,
      organisationId,
      createdByUserId: authorId,
      document: document.value,
      now: 10,
    });
    expect(draft.reviewState).toBe("draft");

    const validated = await validateCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      revision: draft.revision,
      authoringDigest: draft.authoringDigest,
      now: 20,
    });
    if (!validated.ok) throw new Error(JSON.stringify(validated.error));
    expect(validated.value.reviewState).toBe("validated");
    if (validated.value.reviewState !== "validated") return;

    const mismatchedReview = await approveCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      revision: draft.revision,
      definitionDigest: validated.value.definitionDigest,
      approvedByUserId: approverId,
      review: {
        origin: "https://example.com",
        effects: approvalEffects(validated.value.definition),
      },
      now: 30,
    });
    expect(mismatchedReview).toEqual({
      ok: false,
      error: {
        code: "custom_connector_approval_review_mismatch",
        field: "origin",
      },
    });

    const approved = await approveCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      revision: draft.revision,
      definitionDigest: validated.value.definitionDigest,
      approvedByUserId: approverId,
      review: {
        origin: validated.value.definition.origin,
        effects: approvalEffects(validated.value.definition),
      },
      now: 30,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok || approved.value.reviewState !== "approved") return;
    expect(approved.value.approval).toMatchObject({
      approvedByUserId: approverId,
      approvedAt: 30,
      origin: validated.value.definition.origin,
    });

    expect(function mutateApprovedContent() {
      database
        .prepare(
          `UPDATE custom_connector_revision
           SET authoring_document = '{}'
           WHERE organisation_id = ? AND connector_id = ? AND revision = ?`,
        )
        .run(organisationId, draft.connectorId, draft.revision);
    }).toThrow(/custom_connector_revision_content_immutable/u);
    expect(function mutateApprovalEvidence() {
      database
        .prepare(
          `UPDATE custom_connector_revision
           SET approved_origin = 'https://attacker.example'
           WHERE organisation_id = ? AND connector_id = ? AND revision = ?`,
        )
        .run(organisationId, draft.connectorId, draft.revision);
    }).toThrow(/custom_connector_revision_approval_immutable/u);

    const invalidDocument = await prepareCustomConnectorDraftDocument({
      schemaVersion: 1,
    });
    expect(invalidDocument.ok).toBe(true);
    if (!invalidDocument.ok) return;
    const next = await createCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      expectedHeadRevision: draft.revision,
      createdByUserId: authorId,
      document: invalidDocument.value,
      now: 40,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const failedValidation = await validateCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      revision: next.value.revision,
      authoringDigest: next.value.authoringDigest,
      now: 50,
    });
    expect(failedValidation).toMatchObject({
      ok: false,
      error: { code: "custom_connector_validation_failed" },
    });
    const persistedDraft = await resolveCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      revision: next.value.revision,
    });
    expect(persistedDraft).toMatchObject({
      ok: true,
      value: {
        reviewState: "draft",
        lastValidationAttemptedAt: 50,
        validationFailure: { code: "definition_invalid" },
      },
    });

    const stale = await createCustomConnectorRevision({
      db,
      organisationId,
      connectorId: draft.connectorId,
      expectedHeadRevision: draft.revision,
      createdByUserId: authorId,
      document: invalidDocument.value,
      now: 60,
    });
    expect(stale).toEqual({
      ok: false,
      error: { code: "custom_connector_revision_conflict" },
    });
    const summaries = await listCustomConnectorSummaries({ db, organisationId });
    expect(summaries).toMatchObject({
      ok: true,
      value: [
        {
          connectorId: draft.connectorId,
          lifecycle: "draft",
          headRevision: next.value.revision,
          reviewState: "draft",
          accountCount: 0,
        },
      ],
    });
    const detail = await resolveCustomConnectorDetail({
      db,
      organisationId,
      connectorId: draft.connectorId,
    });
    expect(detail).toMatchObject({
      ok: true,
      value: {
        summary: { connectorId: draft.connectorId },
        revisions: [
          { revision: next.value.revision, reviewState: "draft" },
          { revision: draft.revision, reviewState: "approved" },
        ],
        accounts: [],
      },
    });
    database.close();
  });
});

function approvalEffects(definition: {
  readonly operations: readonly { readonly id: string }[];
}): CustomConnectorApprovalReview["effects"] {
  const effects: { readonly operationId: string; readonly effect: "read" }[] =
    [];
  for (const operation of definition.operations) {
    effects.push({ operationId: operation.id, effect: "read" });
  }
  return effects;
}

function fixture(name: string): JsonObject {
  const raw: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(
        new NodeUrl(`fixtures/custom-connectors/${name}`, import.meta.url),
      ),
      "utf8",
    ),
  );
  if (!isRecord(raw)) throw new Error("custom connector fixture is invalid");
  // JSON.parse output is JSON by construction.
  return raw as JsonObject;
}

function seedIdentities(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO organisation (organisation_id, organisation_handle, name, created_at)
    VALUES ('organisation_custom_connector', 'custom-connector', 'Custom connector', 1);
    INSERT INTO app_user (
      user_id, issuer, subject, email, display_name,
      email_verified, created_at, last_authenticated_at
    ) VALUES
      ('user_10d06d84-d6fc-51b3-b7da-b518ea116d6c', 'test', 'author', 'author@example.com', 'Author', 1, 1, 1),
      ('user_1ee0fca4-cbe6-52f2-bd7b-d767d7867b3d', 'test', 'approver', 'approver@example.com', 'Approver', 1, 1, 1);
  `);
}
