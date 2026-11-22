/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  listSupplierPayoutCertifications,
  payoutIsCertified,
  recordSupplierPayoutCertification,
  PAYOUT_CERTIFICATION_CHECKS,
  SUPPLIER_PAYOUT_ADAPTER_VERSIONS,
  type SupplierPayoutCertification,
} from "../src/data/supplier-payout-certification";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { d1Database } from "./sqlite-d1";
const ORGANISATION = "organisation_cert" as OrganisationId;
const OTHER = "organisation_other" as OrganisationId;
const DIGEST = "ab".repeat(32);

let db: SingleDatabase;
let database: DatabaseSync;

function packet(
  overrides: Partial<SupplierPayoutCertification> = {},
): SupplierPayoutCertification {
  return {
    testRunId: "run_1",
    rail: "gmo_aozora_private",
    integrationAccountId: integrationAccountFor(ORGANISATION),
    sourceReference: "source_account_1",
    fundingMode: "balance",
    environment: "development",
    adapterVersion: SUPPLIER_PAYOUT_ADAPTER_VERSIONS.gmo_aozora_private,
    evidenceSource: "provider_sandbox",
    checks: [...PAYOUT_CERTIFICATION_CHECKS],
    certifiedCurrency: "JPY",
    certifiedMaximumMinor: 100_000,
    evidenceDigest: DIGEST,
    certifiedAt: 1,
    ...overrides,
  };
}

function seed(organisationId: string, name: string): void {
  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, ?, 'beta', 1, 'active')`,
    )
    .run(organisationId, name);
  database
    .prepare(
      `INSERT INTO app_user (
       user_id, issuer, subject, email, display_name,
       email_verified, created_at, last_authenticated_at
     ) VALUES (?, 'https://accounts.google.com', ?, ?, 'Cert', 1, 1, 1)`,
    )
    .run(
      `app_user_${organisationId}`,
      `subject_${organisationId}`,
      `${organisationId}@test.invalid`,
    );
  database
    .prepare(
      `INSERT INTO provider_connection (
       provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
       credential_generation, credential_ref, lifecycle, granted_scopes,
       created_by_user_id, created_at, updated_at, environment
     ) VALUES (?, ?, 'stripe', 'api_key', 'connection_credential',
       1, 'credential_1', 'active', '[]', ?, 1, 1, 'development')`,
    )
    .run(
      `connection_${organisationId}`,
      organisationId,
      `app_user_${organisationId}`,
    );
  database
    .prepare(
      `INSERT INTO integration_account (
       integration_account_id, organisation_id, provider_connection_id, provider,
       provider_account_id, account_kind, display_name, lifecycle,
       lifecycle_reason_code, capability_set, audience_policy, retention_policy,
       created_at, updated_at, environment, is_default_for_provider
     ) VALUES (?, ?, ?, 'stripe',
       ?, 'merchant_account', 'GMO', 'active',
       NULL, '[]', '{"kind":"operator"}', '{"kind":"organisation_default"}',
       1, 1, 'development', 1)`,
    )
    .run(
      integrationAccountFor(organisationId),
      organisationId,
      `connection_${organisationId}`,
      `provider_account_${organisationId}`,
    );
}

/** Each organisation owns its own account row; ids are globally unique. */
function integrationAccountFor(organisationId: string): string {
  return `integration_gmo_${organisationId}`;
}

async function record(overrides: Partial<SupplierPayoutCertification> = {}) {
  return recordSupplierPayoutCertification({
    db,
    organisationId: ORGANISATION,
    certification: packet(overrides),
    now: 10,
  });
}

async function certified(overrides: Record<string, unknown> = {}) {
  return payoutIsCertified({
    db,
    organisationId: ORGANISATION,
    rail: "gmo_aozora_private",
    integrationAccountId: integrationAccountFor(ORGANISATION),
    sourceReference: "source_account_1",
    fundingMode: "balance",
    environment: "development",
    currency: "JPY",
    amountMinor: 10_000,
    ...overrides,
  } as Parameters<typeof payoutIsCertified>[0]);
}

describe("supplier payout certification", function payoutCertificationSuite() {
  beforeEach(function freshDatabase() {
    database = new DatabaseSync(":memory:");
    database.exec(singleDatabaseSchema());
    db = d1Database(database);
    seed(ORGANISATION, "Cert organisation");
  });

  it("certifies a rail that evidenced the whole matrix", async function full() {
    expect(await record()).toEqual({ ok: true });
    expect(await certified()).toBe(true);
  });

  it("refuses a partial matrix", async function partial() {
    const result = await record({
      // Dropping the interruption check leaves exactly the failure mode that
      // costs money unproven.
      checks: PAYOUT_CERTIFICATION_CHECKS.filter(
        (c) => c !== "interruption_recovery",
      ),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "payout_certification_incomplete",
        field: "interruption_recovery",
      },
    });
    expect(await certified()).toBe(false);
  });

  it("will not certify production from a sandbox run", async function sandboxProduction() {
    expect(
      await record({
        environment: "production",
        evidenceSource: "provider_sandbox",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "payout_certification_environment_mismatch" },
    });
  });

  it("will not certify production from a fixture", async function fixtureProduction() {
    expect(
      await record({
        environment: "production",
        evidenceSource: "deterministic_fixture",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "payout_certification_environment_mismatch" },
    });
  });

  it("will not certify development from a live run", async function liveDevelopment() {
    // A controlled live run proves production, and recording it as development
    // evidence would let a real-money run stand in for a sandbox one.
    expect(await record({ evidenceSource: "controlled_live" })).toMatchObject({
      ok: false,
      error: { code: "payout_certification_environment_mismatch" },
    });
  });

  it("refuses evidence for an adapter version that is not deployed", async function staleAdapter() {
    expect(
      await record({ adapterVersion: "gmo_aozora_private@2020-01-01" }),
    ).toMatchObject({
      ok: false,
      error: { code: "payout_certification_invalid" },
    });
  });

  it("does not cover an amount larger than the run proved", async function ceiling() {
    await record({ certifiedMaximumMinor: 50_000 });
    expect(await certified({ amountMinor: 50_000 })).toBe(true);
    // One yen above what was tested is uncertified, however close it is.
    expect(await certified({ amountMinor: 50_001 })).toBe(false);
  });

  it("does not cover another currency", async function currency() {
    await record();
    expect(await certified({ currency: "USD" })).toBe(false);
  });

  it("does not cover another source account", async function sourceAccount() {
    await record();
    expect(await certified({ sourceReference: "source_account_2" })).toBe(
      false,
    );
  });

  it("does not cover the other rail", async function rail() {
    await record();
    expect(await certified({ rail: "wise_enterprise_payouts" })).toBe(false);
  });

  it("does not cover production because development was certified", async function environment() {
    await record();
    expect(await certified({ environment: "production" })).toBe(false);
  });

  it("does not reuse certification across integration accounts with the same source reference", async function exactAccount() {
    await record();
    expect(await certified({ integrationAccountId: "integration_other" })).toBe(
      false,
    );
  });

  it("never lets one organisation's evidence certify another's rail", async function crossOrganisation() {
    await record();
    seed(OTHER, "Other organisation");
    expect(
      await payoutIsCertified({
        db,
        organisationId: OTHER,
        rail: "gmo_aozora_private",
        integrationAccountId: integrationAccountFor(ORGANISATION),
        sourceReference: "source_account_1",
        fundingMode: "balance",
        environment: "development",
        currency: "JPY",
        amountMinor: 10_000,
      }),
    ).toBe(false);
  });

  it("keeps a recorded packet immutable", async function immutable() {
    await record();
    expect(() =>
      database
        .prepare(
          "UPDATE supplier_payout_certification SET certified_maximum_minor = 999999",
        )
        .run(),
    ).toThrow(/immutable/u);
  });

  it("lists what an organisation has certified", async function lists() {
    await record();
    const listed = await listSupplierPayoutCertifications(db, ORGANISATION);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.evidenceSource).toBe("provider_sandbox");
    expect(listed[0]?.checks).toEqual([...PAYOUT_CERTIFICATION_CHECKS]);
  });

  it("leaves out a stored row the recorder could not have written", async function skipsMalformedRow() {
    await record();
    database
      .prepare(
        `INSERT INTO supplier_payout_certification (
           organisation_id, test_run_id, rail, integration_account_id,
           source_reference, funding_mode, environment, adapter_version,
           evidence_source, matrix_version, checks_json, certified_currency,
           certified_maximum_minor, evidence_digest, certified_at, recorded_at,
           certified_by
         )
         SELECT organisation_id, 'run_malformed', rail, integration_account_id,
           source_reference, funding_mode, environment, adapter_version,
           evidence_source, matrix_version, '["transfer_success","unknown"]',
           certified_currency, certified_maximum_minor, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
           certified_at, recorded_at, certified_by
         FROM supplier_payout_certification`,
      )
      .run();

    const listed = await listSupplierPayoutCertifications(db, ORGANISATION);

    expect(listed.map((packet) => packet.testRunId)).not.toContain(
      "run_malformed",
    );
    expect(listed).toHaveLength(1);
  });
});
