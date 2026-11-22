import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  projectEmailOperationalProposal,
  readEmailOperationalProposalProjection,
  recordOperationalEmailAttestation,
  registerEmailSenderAccount,
  registerOperationalEmailContact,
  registerSupplierOperationalEmailContact,
} from "../src/data/email-operational";
import { createMigratedDatabase } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { requireIntegrationAccountId, requireOrganisationId } from "./test-ids";

describe("operational email directory", () => {
  it(
    "allows one organisation to claim a Google sender identity",
    senderClaimTest,
  );
  it(
    "requires a new revision when a canonical contact changes",
    contactRevisionTest,
  );
  it("builds the canonical primary supplier email target", supplierContactTest);
  it(
    "keeps an operator attestation terminal during actor reprojection",
    attestationTest,
  );
});

async function senderClaimTest(): Promise<void> {
  const db = directoryDatabase();
  const first = ids("organisation_sender_first", "integration_sender_first");
  const second = ids("organisation_sender_second", "integration_sender_second");
  expect(
    await registerEmailSenderAccount({
      db,
      ...first,
      environment: "production",
      googleSubject: "google-subject-one",
      observedAddress: "sender@example.com",
      now: 1,
    }),
  ).toEqual({ ok: true, value: null });
  expect(
    await registerEmailSenderAccount({
      db,
      ...second,
      environment: "production",
      googleSubject: "google-subject-one",
      observedAddress: "sender@example.com",
      now: 2,
    }),
  ).toEqual({
    ok: false,
    error: { code: "email_sender_identity_claimed" },
  });
}

async function contactRevisionTest(): Promise<void> {
  const db = directoryDatabase();
  const organisationId = requireOrganisationId("organisation_contact_revision");
  const target = {
    kind: "supplier_contact" as const,
    supplierId: "supplier_1",
    contactId: "contact_1",
    contactRevision: 1,
  };
  expect(
    await registerOperationalEmailContact({
      db,
      organisationId,
      target,
      address: "first@example.com",
      displayName: "First",
      state: "active",
      relationshipState: "active",
      now: 1,
    }),
  ).toEqual({ ok: true, value: null });
  expect(
    await registerOperationalEmailContact({
      db,
      organisationId,
      target,
      address: "changed@example.com",
      displayName: "First",
      state: "active",
      relationshipState: "active",
      now: 2,
    }),
  ).toEqual({
    ok: false,
    error: { code: "email_operational_contact_invalid" },
  });
  expect(
    await registerOperationalEmailContact({
      db,
      organisationId,
      target: { ...target, contactRevision: 2 },
      address: "changed@example.com",
      displayName: "First",
      state: "active",
      relationshipState: "active",
      now: 3,
    }),
  ).toEqual({ ok: true, value: null });
}

async function supplierContactTest(): Promise<void> {
  const db = directoryDatabase();
  const organisationId = requireOrganisationId("organisation_supplier_contact");
  expect(
    await registerSupplierOperationalEmailContact({
      db,
      organisationId,
      supplierId: "supplier_primary",
      contactRevision: 7,
      address: "Orders@Supplier.Example",
      displayName: "Supplier Orders",
      now: 7,
    }),
  ).toEqual({ ok: true, value: null });
  const contact = await db
    .prepare(
      `SELECT contact_id AS contactId, contact_revision AS contactRevision,
          observed_address AS observedAddress, contact_state AS contactState,
          relationship_state AS relationshipState
       FROM email_operational_contact
       WHERE organisation_id = ? AND contact_kind = 'supplier_contact'
         AND entity_id = ?`,
    )
    .bind(organisationId, "supplier_primary")
    .first<Record<string, unknown>>();
  expect(contact).toEqual({
    contactId: "primary_email",
    contactRevision: 7,
    observedAddress: "orders@supplier.example",
    contactState: "active",
    relationshipState: "active",
  });
}

async function attestationTest(): Promise<void> {
  const db = directoryDatabase();
  const organisationId = requireOrganisationId("organisation_attestation");
  const integrationAccountId = requireIntegrationAccountId(
    "integration_attestation",
  );
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES (?, 'attestation', 'Attestation', 0)",
    )
    .bind(organisationId)
    .run();
  const placement = await ensureInitialOrganisationPlacement({
    db,
    organisationId,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 1,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  const scope = await requireOrganisationExecutionScope(
    {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    organisationId,
  );
  const projection = {
    scope,
    integrationAccountId,
    proposalId: "proposal_attestation",
    caseId: "case_attestation",
    target: {
      kind: "customer_contact" as const,
      customerId: "customer_attestation",
      contactId: "contact_attestation",
      contactRevision: 1,
    },
    currentVersion: 1,
    targetDigest: "1".repeat(64),
    subjectDigest: "2".repeat(64),
    bodyDigest: "3".repeat(64),
    snapshotDigest: "4".repeat(64),
    lifecycleKind: "send_indeterminate" as const,
    providerMessageId: null,
    providerThreadId: null,
    indeterminateRfcMessageId: "<proposal@example.com>",
    createdAt: 1,
    now: 2,
  };
  expect(await projectEmailOperationalProposal(projection)).toEqual({
    ok: true,
    value: null,
  });
  expect(
    await recordOperationalEmailAttestation({
      db,
      organisationId,
      proposalId: projection.proposalId,
      attestation: "present",
      attestedBy: "control_attestation",
      attestedAt: 3,
    }),
  ).toEqual({ ok: true, value: null });
  expect(
    await projectEmailOperationalProposal({ ...projection, now: 4 }),
  ).toEqual({ ok: true, value: null });
  expect(
    await recordOperationalEmailAttestation({
      db,
      organisationId,
      proposalId: projection.proposalId,
      attestation: "absent",
      attestedBy: "control_attestation_other",
      attestedAt: 5,
    }),
  ).toEqual({
    ok: false,
    error: { code: "email_operational_attestation_conflict" },
  });
  await expect(
    readEmailOperationalProposalProjection({
      db,
      organisationId,
      proposalId: projection.proposalId,
    }),
  ).resolves.toMatchObject({
    lifecycleKind: "operator_attested_present",
  });
}

function directoryDatabase(): SingleDatabase {
  const sqlite = new DatabaseSync(":memory:");
  const db = createMigratedDatabase(sqlite);
  sqlite.exec("PRAGMA foreign_keys = OFF");
  return db;
}

function ids(
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): {
  readonly organisationId: ReturnType<typeof requireOrganisationId>;
  readonly integrationAccountId: ReturnType<typeof requireIntegrationAccountId>;
} {
  return {
    organisationId: requireOrganisationId(organisationIdRaw),
    integrationAccountId: requireIntegrationAccountId(integrationAccountIdRaw),
  };
}
