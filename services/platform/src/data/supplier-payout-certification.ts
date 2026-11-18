import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";
import { isNonEmptyString, isNonNegativeInteger } from "@seams/std";

/**
 * Evidence that one payout rail actually works, for one exact account.
 *
 * Kept apart from checkout certification because the thing being proved is
 * different. A checkout packet proves Pantry can take money from a customer; a
 * payout packet proves it can send money to a third party who has no obligation
 * to give it back. Sharing a store would let evidence for one activate the
 * other.
 */
export const SUPPLIER_PAYOUT_ADAPTER_VERSIONS = {
  gmo_aozora_private: "gmo_aozora_private@unreleased",
  wise_enterprise_payouts: "wise_enterprise_payouts@unreleased",
} as const;

export type SupplierPayoutRail = keyof typeof SUPPLIER_PAYOUT_ADAPTER_VERSIONS;

/**
 * Where a packet's evidence came from.
 *
 * These are not interchangeable. A fixture proves the adapter's own logic; a
 * sandbox run proves Pantry and the provider agree on shapes; only a controlled
 * live run against the real account, with real money, proves the path that
 * actually pays a supplier.
 */
const PAYOUT_EVIDENCE_SOURCES = [
  "deterministic_fixture",
  "provider_sandbox",
  "controlled_live",
] as const;

export type PayoutEvidenceSource = (typeof PAYOUT_EVIDENCE_SOURCES)[number];

/**
 * What a payout rail must evidence.
 *
 * The four beyond a happy path are the ones that cost money when wrong: an
 * interrupted submission whose outcome is unknown, a duplicate delivery, a
 * return after apparent success, and a reversal. A rail that has not shown all
 * four has not shown it can be trusted with a supplier's payment.
 */
export const PAYOUT_CERTIFICATION_CHECKS = [
  "transfer_success",
  "transfer_rejection",
  "interruption_recovery",
  "duplicate_submission",
  "inquiry_reconciliation",
  "return_handling",
  "reversal_handling",
  "fee_ceiling_enforcement",
] as const;

export type PayoutCertificationCheck =
  (typeof PAYOUT_CERTIFICATION_CHECKS)[number];

export type SupplierPayoutCertification = Readonly<{
  testRunId: string;
  rail: SupplierPayoutRail;
  integrationAccountId: string;
  /** The Wise profile or GMO source account this run actually used. */
  sourceReference: string;
  fundingMode: "balance";
  environment: "development" | "production";
  adapterVersion: string;
  evidenceSource: PayoutEvidenceSource;
  checks: readonly PayoutCertificationCheck[];
  certifiedCurrency: string;
  /** The largest amount this run proved. Anything above it is uncertified. */
  certifiedMaximumMinor: number;
  evidenceDigest: string;
  certifiedAt: number;
}>;

type PayoutCertificationError = Readonly<{
  code:
    | "payout_certification_invalid"
    | "payout_certification_incomplete"
    | "payout_certification_environment_mismatch"
    | "payout_certification_conflict";
  field?: string;
}>;

/**
 * Whether this evidence can certify a rail in this environment.
 *
 * Production sends real money to a third party. Only a controlled live run
 * against the actual account proves that; activating it on a fixture or a
 * sandbox packet would be certifying a simulation.
 */
function payoutEvidenceSupportsEnvironment(
  source: PayoutEvidenceSource,
  environment: "development" | "production",
): boolean {
  return environment === "production"
    ? source === "controlled_live"
    : source !== "controlled_live";
}

export async function recordSupplierPayoutCertification(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    certification: SupplierPayoutCertification;
    now: number;
  }>,
): Promise<
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: PayoutCertificationError }>
> {
  const { certification } = input;
  const missing = PAYOUT_CERTIFICATION_CHECKS.filter(
    (check) => !certification.checks.includes(check),
  );
  if (missing.length > 0) {
    // A partial matrix is not a smaller certification, it is no certification:
    // the checks it skipped are exactly the ones that cost money.
    return {
      ok: false,
      error: { code: "payout_certification_incomplete", field: missing[0] },
    };
  }
  if (
    !payoutEvidenceSupportsEnvironment(
      certification.evidenceSource,
      certification.environment,
    )
  ) {
    return {
      ok: false,
      error: { code: "payout_certification_environment_mismatch" },
    };
  }
  if (
    certification.adapterVersion !==
    SUPPLIER_PAYOUT_ADAPTER_VERSIONS[certification.rail]
  ) {
    // Evidence is per adapter version. A packet for an older build says nothing
    // about the one deployed.
    return {
      ok: false,
      error: { code: "payout_certification_invalid", field: "adapterVersion" },
    };
  }
  try {
    await input.db
      .prepare(
        `INSERT INTO supplier_payout_certification (
         organisation_id, test_run_id, rail, integration_account_id, source_reference,
         funding_mode, environment, adapter_version, evidence_source,
         matrix_version, checks_json, certified_currency, certified_maximum_minor,
         evidence_digest, certified_at, recorded_at, certified_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'organisation_admin')`,
      )
      .bind(
        input.organisationId,
        certification.testRunId,
        certification.rail,
        certification.integrationAccountId,
        certification.sourceReference,
        certification.fundingMode,
        certification.environment,
        certification.adapterVersion,
        certification.evidenceSource,
        JSON.stringify(certification.checks),
        certification.certifiedCurrency,
        certification.certifiedMaximumMinor,
        certification.evidenceDigest,
        certification.certifiedAt,
        input.now,
      )
      .run();
    return { ok: true };
  } catch {
    return { ok: false, error: { code: "payout_certification_conflict" } };
  }
}

/**
 * Whether one exact payout may be sent.
 *
 * Every dimension is matched exactly. A packet for another organisation, another
 * source account, another funding mode, another environment, or a smaller
 * amount does not cover this payout — and a payout above what was tested is
 * uncertified however much smaller evidence exists.
 */
export async function payoutIsCertified(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    rail: SupplierPayoutRail;
    integrationAccountId: string;
    sourceReference: string;
    fundingMode: "balance";
    environment: "development" | "production";
    currency: string;
    amountMinor: number;
  }>,
): Promise<boolean> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS certified
     FROM supplier_payout_certification
     WHERE organisation_id = ? AND rail = ? AND integration_account_id = ? AND source_reference = ?
       AND funding_mode = ? AND environment = ? AND adapter_version = ?
       AND matrix_version = 1 AND certified_currency = ?
       AND certified_maximum_minor >= ?
     LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.rail,
      input.integrationAccountId,
      input.sourceReference,
      input.fundingMode,
      input.environment,
      SUPPLIER_PAYOUT_ADAPTER_VERSIONS[input.rail],
      input.currency,
      input.amountMinor,
    )
    .first<{ readonly certified: unknown }>();
  return row?.certified === 1;
}

/** Every packet recorded for one organisation, newest first, for the operator view. */
export async function listSupplierPayoutCertifications(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly SupplierPayoutCertification[]> {
  const result = await db
    .prepare(
      `SELECT test_run_id AS testRunId, rail,
            integration_account_id AS integrationAccountId,
            source_reference AS sourceReference, funding_mode AS fundingMode,
            environment, adapter_version AS adapterVersion,
            evidence_source AS evidenceSource, checks_json AS checksJson,
            certified_currency AS certifiedCurrency,
            certified_maximum_minor AS certifiedMaximumMinor,
            evidence_digest AS evidenceDigest, certified_at AS certifiedAt
     FROM supplier_payout_certification
     WHERE organisation_id = ?
     ORDER BY certified_at DESC, test_run_id ASC`,
    )
    .bind(organisationId)
    .all<Record<string, unknown>>();
  // A row the recorder could not have written is not evidence. It is left out
  // rather than read back under a type it does not have, or failing the view.
  return (result.results ?? []).flatMap((row) => {
    const certification = parseCertificationRow(row);
    return certification ? [certification] : [];
  });
}

function parseCertificationRow(
  row: Record<string, unknown>,
): SupplierPayoutCertification | null {
  const checks = parseCertificationChecks(row.checksJson);
  const source = PAYOUT_EVIDENCE_SOURCES.find(
    (known) => known === row.evidenceSource,
  );
  const {
    testRunId,
    rail,
    integrationAccountId,
    sourceReference,
    fundingMode,
    environment,
    adapterVersion,
    certifiedCurrency,
    certifiedMaximumMinor,
    evidenceDigest,
    certifiedAt,
  } = row;
  if (
    !isNonEmptyString(testRunId) ||
    !isSupplierPayoutRail(rail) ||
    !isNonEmptyString(integrationAccountId) ||
    !isNonEmptyString(sourceReference) ||
    fundingMode !== "balance" ||
    (environment !== "development" && environment !== "production") ||
    !isNonEmptyString(adapterVersion) ||
    source === undefined ||
    checks === null ||
    !isNonEmptyString(certifiedCurrency) ||
    !isNonNegativeInteger(certifiedMaximumMinor) ||
    !isNonEmptyString(evidenceDigest) ||
    !isNonNegativeInteger(certifiedAt)
  )
    return null;
  return {
    testRunId,
    rail,
    integrationAccountId,
    sourceReference,
    fundingMode,
    environment,
    adapterVersion,
    evidenceSource: source,
    checks,
    certifiedCurrency,
    certifiedMaximumMinor,
    evidenceDigest,
    certifiedAt,
  };
}

function isSupplierPayoutRail(raw: unknown): raw is SupplierPayoutRail {
  return (
    typeof raw === "string" &&
    Object.hasOwn(SUPPLIER_PAYOUT_ADAPTER_VERSIONS, raw)
  );
}

function parseCertificationChecks(
  raw: unknown,
): readonly PayoutCertificationCheck[] | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const checks: PayoutCertificationCheck[] = [];
  for (const value of parsed) {
    const check = PAYOUT_CERTIFICATION_CHECKS.find((known) => known === value);
    if (check === undefined) return null;
    checks.push(check);
  }
  return checks;
}
