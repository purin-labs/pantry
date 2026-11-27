import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  listIntegrationAccounts,
  resolveActiveProviderAccountContext,
} from "@purin-labs/connections/data/integration-account";
import { mailSourcePin } from "@purin-labs/area-inbox-contract/server/mail-source-authorization";
import { mailInferenceEligible } from "@purin-labs/area-inbox-contract/server/mail-inference-eligibility";
import {
  typeSafeAuthorityRevision,
  type TypeSafeAuthority,
} from "@purin-labs/agent/typesafe/authority";

/**
 * The Mail classification switch writes `mail_classification_eligibility`, the
 * record that the classifier already checks (Plan 88 section 2). There is no
 * second record of the switch.
 */
const SWITCH_REVIEW_MS = 10 * 365 * 24 * 60 * 60 * 1_000;

type JevMailSource = Readonly<{
  integrationAccountId: IntegrationAccountId;
  displayName: string;
  sourcePin: string;
}>;

/** Each active Gmail mailbox that Jev can sort. */
async function listJevMailSources(
  input: Readonly<{ db: OrganisationDatabase; organisationId: OrganisationId }>,
): Promise<readonly JevMailSource[]> {
  const sources: JevMailSource[] = [];
  const accounts = await listIntegrationAccounts(input);
  for (const account of accounts) {
    if (account.provider !== "gmail" || account.lifecycle.kind !== "active")
      continue;
    const context = await resolveActiveProviderAccountContext({
      db: input.db,
      organisationId: input.organisationId,
      integrationAccountId: account.integrationAccountId,
    });
    if (
      !context.ok ||
      context.value.connection.authorizationProduct.kind !== "gmail" ||
      context.value.connection.authorizationProduct.product !==
        "full_mailbox_pilot"
    )
      continue;
    sources.push({
      integrationAccountId: account.integrationAccountId,
      displayName: account.displayName,
      sourcePin: await mailSourcePin(context.value.connection),
    });
  }
  return sources;
}

export async function jevMailCoverage(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    authority: TypeSafeAuthority;
    now: number;
  }>,
): Promise<readonly (JevMailSource & Readonly<{ covered: boolean }>)[]> {
  const sources = await listJevMailSources(input);
  const covered = [];
  for (const source of sources)
    covered.push({
      ...source,
      covered: await mailInferenceEligible({
        db: input.db,
        organisationId: input.organisationId,
        integrationAccountId: source.integrationAccountId,
        sourcePin: source.sourcePin,
        typesafe: input.authority,
        now: input.now,
      }),
    });
  return covered;
}

/** Turns mail classification on for every current mailbox, under one authority. */
export async function enableJevMailClassification(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    authority: TypeSafeAuthority;
    actorId: string;
    now: number;
  }>,
): Promise<number> {
  const sources = await listJevMailSources(input);
  if (sources.length === 0) return 0;
  await input.db.batch(
    sources.map((source) =>
      input.db
        .prepare(
          `INSERT INTO mail_classification_eligibility
          (organisation_id, integration_account_id, source_pin, funding, connection_revision,
           model, purpose, evidence_reference, evidence_owner, disclosed_recipient,
           reviewed_at, review_expires_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, 'jev-1.13.0', 'mail_classification', 'jev-settings-switch', ?, 'typesafe', ?, ?, NULL)
          ON CONFLICT (organisation_id, integration_account_id, source_pin, funding, connection_revision)
          DO UPDATE SET evidence_reference = excluded.evidence_reference,
            evidence_owner = excluded.evidence_owner, reviewed_at = excluded.reviewed_at,
            review_expires_at = excluded.review_expires_at, revoked_at = NULL`,
        )
        .bind(
          input.organisationId,
          source.integrationAccountId,
          source.sourcePin,
          input.authority.kind,
          typeSafeAuthorityRevision(input.authority),
          input.actorId,
          input.now,
          input.now + SWITCH_REVIEW_MS,
        ),
    ),
  );
  return sources.length;
}

/** Turns mail classification off: no new call passes the eligibility check. */
export async function disableJevMailClassification(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    now: number;
  }>,
): Promise<void> {
  await input.db
    .prepare(
      `UPDATE mail_classification_eligibility SET revoked_at = ?
      WHERE organisation_id = ? AND revoked_at IS NULL`,
    )
    .bind(input.now, input.organisationId)
    .run();
}

/**
 * Moves the switch to a new authority when the Organisation connects or
 * removes its own key: each mailbox that was on stays on.
 */
export async function repinJevMailClassification(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    from: TypeSafeAuthority;
    to: TypeSafeAuthority;
    now: number;
  }>,
): Promise<void> {
  await input.db.batch([
    input.db
      .prepare(
        `INSERT INTO mail_classification_eligibility
        (organisation_id, integration_account_id, source_pin, funding, connection_revision,
         model, purpose, evidence_reference, evidence_owner, disclosed_recipient,
         reviewed_at, review_expires_at, revoked_at)
        SELECT organisation_id, integration_account_id, source_pin, ?, ?,
          model, purpose, evidence_reference, evidence_owner, disclosed_recipient,
          ?, review_expires_at, NULL
        FROM mail_classification_eligibility
        WHERE organisation_id = ? AND funding = ? AND connection_revision = ?
          AND revoked_at IS NULL AND review_expires_at > ?
        ON CONFLICT (organisation_id, integration_account_id, source_pin, funding, connection_revision)
        DO UPDATE SET reviewed_at = excluded.reviewed_at,
          review_expires_at = excluded.review_expires_at, revoked_at = NULL`,
      )
      .bind(
        input.to.kind,
        typeSafeAuthorityRevision(input.to),
        input.now,
        input.organisationId,
        input.from.kind,
        typeSafeAuthorityRevision(input.from),
        input.now,
      ),
    input.db
      .prepare(
        `UPDATE mail_classification_eligibility SET revoked_at = ?
        WHERE organisation_id = ? AND funding = ? AND connection_revision = ? AND revoked_at IS NULL`,
      )
      .bind(
        input.now,
        input.organisationId,
        input.from.kind,
        typeSafeAuthorityRevision(input.from),
      ),
  ]);
}
