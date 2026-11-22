import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { digestCanonical } from "@purin-labs/authority/policy/information-flow/digest";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseOperationalEmailTarget,
  resolveOperationalEmailContact,
  type OperationalEmailTarget,
} from "./email-operational";
import { resolveActiveProviderAccountContext } from "@purin-labs/connections/data/integration-account";
import { resolveCurrentOrganisationCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import { isRecord, parseJsonOrNull } from "@purin-labs/std";

export type ContactEndpoint =
  | Readonly<{ channel: "gmail"; address: string; waId?: never }>
  | Readonly<{ channel: "whatsapp"; waId: string; address?: never }>;

export type ContactVerificationCommand = Readonly<{
  commandId: string;
  verificationId: string;
  expectedRevision: number;
}> &
  (
    | Readonly<{
        kind: "verify";
        integrationAccountId: IntegrationAccountId;
        target: OperationalEmailTarget;
        endpoint: ContactEndpoint;
        evidenceRef: string;
      }>
    | Readonly<{
        kind: "revoke";
        integrationAccountId?: never;
        target?: never;
        endpoint?: never;
        evidenceRef?: never;
      }>
  );

export type VerifiedContactEndpoint = Readonly<{
  verificationId: string;
  revision: number;
  organisationId: OrganisationId;
  merchantId: string;
  integrationAccountId: IntegrationAccountId;
  target: OperationalEmailTarget;
  endpoint: ContactEndpoint;
}>;

type VerificationError = Readonly<{
  code:
    | "contact_verification_invalid"
    | "contact_verification_conflict"
    | "contact_verification_unavailable";
}>;

type Verification = Readonly<{
  revision: number;
  requestDigest: string;
  state: "verified" | "revoked";
  merchantId: string;
  integrationAccountId: IntegrationAccountId;
  target: OperationalEmailTarget;
  endpoint: ContactEndpoint;
}>;

export function parseContactVerificationCommand(
  raw: unknown,
): ContactVerificationCommand | null {
  if (
    !isRecord(raw) ||
    !reference(raw.commandId) ||
    !reference(raw.verificationId) ||
    !revision(raw.expectedRevision, 0)
  )
    return null;
  if (
    raw.kind === "revoke" &&
    Object.keys(raw).length === 4 &&
    raw.expectedRevision > 0
  ) {
    return {
      kind: "revoke",
      commandId: raw.commandId,
      verificationId: raw.verificationId,
      expectedRevision: raw.expectedRevision,
    };
  }
  if (
    raw.kind !== "verify" ||
    Object.keys(raw).length !== 8 ||
    typeof raw.integrationAccountId !== "string" ||
    !reference(raw.evidenceRef)
  )
    return null;
  const account = parseIntegrationAccountId(raw.integrationAccountId);
  const target = parseOperationalEmailTarget(raw.target);
  const endpoint = parseEndpoint(raw.endpoint);
  if (!account.ok || target === null || endpoint === null) return null;
  return {
    kind: "verify",
    commandId: raw.commandId,
    verificationId: raw.verificationId,
    expectedRevision: raw.expectedRevision,
    integrationAccountId: account.value,
    target,
    endpoint,
    evidenceRef: raw.evidenceRef,
  };
}

/** Only the authenticated contact-administration boundary publishes this evidence. */
export async function publishContactVerification(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    actorId: string;
    command: ContactVerificationCommand;
    now: number;
  }>,
): Promise<Result<{ revision: number }, VerificationError>> {
  const command = input.command;
  const requestDigest = await digestCanonical({
    actorId: input.actorId,
    command,
  });
  const previous = await input.db
    .prepare(
      "SELECT revision, request_digest FROM contact_endpoint_verification WHERE organisation_id = ? AND command_id = ?",
    )
    .bind(input.organisationId, command.commandId)
    .first<{ revision: number; request_digest: string }>();
  if (previous !== null) {
    return previous.request_digest === requestDigest
      ? { ok: true, value: { revision: previous.revision } }
      : failure("contact_verification_conflict");
  }
  const current = await readLatest(
    input.db,
    input.organisationId,
    command.verificationId,
  );
  if ((current?.revision ?? 0) !== command.expectedRevision)
    return failure("contact_verification_conflict");
  let merchantId: string;
  let accountId: string;
  let targetJson: string;
  let endpointJson: string;
  if (command.kind === "verify") {
    const merchant =
      await resolveCurrentOrganisationCommerceMerchantBinding(input);
    if (!merchant.ok) return failure("contact_verification_unavailable");
    merchantId = String(merchant.value.merchantId);
    const contact = await resolveOperationalEmailContact({
      db: input.db,
      organisationId: input.organisationId,
      target: command.target,
    });
    const account = await resolveActiveProviderAccountContext({
      db: input.db,
      organisationId: input.organisationId,
      integrationAccountId: command.integrationAccountId,
    });
    if (
      !contact.ok ||
      !account.ok ||
      account.value.account.provider !== command.endpoint.channel ||
      (command.endpoint.channel === "gmail" &&
        command.endpoint.address !== contact.value.address)
    ) {
      return failure("contact_verification_unavailable");
    }
    accountId = command.integrationAccountId;
    targetJson = JSON.stringify(command.target);
    endpointJson = JSON.stringify(command.endpoint);
  } else {
    if (current === null) return failure("contact_verification_unavailable");
    merchantId = current.merchantId;
    accountId = current.integrationAccountId;
    targetJson = JSON.stringify(current.target);
    endpointJson = JSON.stringify(current.endpoint);
  }
  const nextRevision = command.expectedRevision + 1;
  const inserted = await input.db
    .prepare(
      `INSERT INTO contact_endpoint_verification
    (organisation_id, verification_id, revision, command_id, request_digest, state, merchant_id,
     integration_account_id, target_json, endpoint_json, evidence_ref, verified_by, changed_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE COALESCE((SELECT MAX(revision) FROM contact_endpoint_verification
      WHERE organisation_id = ? AND verification_id = ?), 0) = ?
    ON CONFLICT DO NOTHING`,
    )
    .bind(
      input.organisationId,
      command.verificationId,
      nextRevision,
      command.commandId,
      requestDigest,
      command.kind === "verify" ? "verified" : "revoked",
      merchantId,
      accountId,
      targetJson,
      endpointJson,
      command.kind === "verify" ? command.evidenceRef : null,
      input.actorId,
      input.now,
      input.organisationId,
      command.verificationId,
      command.expectedRevision,
    )
    .run();
  if (inserted.meta.changes === 1)
    return { ok: true, value: { revision: nextRevision } };
  const raced = await input.db
    .prepare(
      "SELECT revision, request_digest FROM contact_endpoint_verification WHERE organisation_id = ? AND command_id = ?",
    )
    .bind(input.organisationId, command.commandId)
    .first<{ revision: number; request_digest: string }>();
  return raced !== null && raced.request_digest === requestDigest
    ? { ok: true, value: { revision: raced.revision } }
    : failure("contact_verification_conflict");
}

/**
 * Whether one verification revision currently establishes its contact.
 *
 * `not_current` is a known fact: the verification is missing, revoked or
 * superseded, one of the records it rests on is no longer active, or its
 * endpoint is ambiguous. `unreadable` means a record it rests on is in a state
 * this cannot interpret, which establishes nothing either way.
 */
type ContactVerificationStanding =
  | Readonly<{ kind: "verified"; endpoint: VerifiedContactEndpoint }>
  | Readonly<{ kind: "not_current"; endpoint?: never }>
  | Readonly<{ kind: "unreadable"; endpoint?: never }>;

/** The most verified contacts of one mailbox that a list returns. */
const MAX_VERIFIED_CONTACTS = 50;

/**
 * The contacts of one mailbox whose verification stands now, by address. A
 * verification that is superseded, revoked or no longer backed by its
 * contact is absent. Null is a failed read, which decides nothing.
 */
export async function listVerifiedContactEndpoints(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
  }>,
): Promise<readonly VerifiedContactEndpoint[] | null> {
  const rows = await input.db
    .prepare(
      `SELECT verification_id AS verificationId, MAX(revision) AS revision
         FROM contact_endpoint_verification
        WHERE organisation_id = ? AND integration_account_id = ?
        GROUP BY verification_id
        ORDER BY verification_id
        LIMIT ?`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      MAX_VERIFIED_CONTACTS,
    )
    .all<Record<string, unknown>>();
  const contacts: VerifiedContactEndpoint[] = [];
  for (const row of rows.results) {
    if (typeof row.verificationId !== "string" || !revision(row.revision, 1))
      return null;
    const standing = await readContactVerificationStanding({
      db: input.db,
      organisationId: input.organisationId,
      verificationId: row.verificationId,
      expectedRevision: row.revision,
    });
    if (standing.kind === "unreadable") return null;
    // An earlier revision can name this mailbox while the current one names
    // another. Only a contact that is verified for this mailbox now counts.
    if (
      standing.kind === "verified" &&
      standing.endpoint.integrationAccountId === input.integrationAccountId
    )
      contacts.push(standing.endpoint);
  }
  return contacts;
}

export async function resolveVerifiedContactEndpoint(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    verificationId: string;
    expectedRevision: number;
  }>,
): Promise<Result<VerifiedContactEndpoint, VerificationError>> {
  const standing = await readContactVerificationStanding(input);
  return standing.kind === "verified"
    ? { ok: true, value: standing.endpoint }
    : failure("contact_verification_unavailable");
}

export async function readContactVerificationStanding(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    verificationId: string;
    expectedRevision: number;
  }>,
): Promise<ContactVerificationStanding> {
  const row = await readLatest(
    input.db,
    input.organisationId,
    input.verificationId,
  );
  if (
    row === null ||
    row.state !== "verified" ||
    row.revision !== input.expectedRevision
  ) {
    return { kind: "not_current" };
  }
  const { target, endpoint } = row;
  const contact = await resolveOperationalEmailContact({
    db: input.db,
    organisationId: input.organisationId,
    target,
  });
  const account = await resolveActiveProviderAccountContext({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: row.integrationAccountId,
  });
  const merchant =
    await resolveCurrentOrganisationCommerceMerchantBinding(input);
  // A record that cannot be interpreted decides nothing. One that is known
  // to be gone or inactive ends the verification's standing.
  if (
    (!contact.ok &&
      contact.error.code !== "email_operational_contact_not_found" &&
      contact.error.code !== "email_operational_contact_suppressed" &&
      contact.error.code !== "email_operational_contact_inactive") ||
    (!account.ok && account.error.code === "integration_account_corrupt") ||
    (!merchant.ok && merchant.error.code !== "commerce_binding_not_found")
  ) {
    return { kind: "unreadable" };
  }
  if (
    !contact.ok ||
    !account.ok ||
    !merchant.ok ||
    String(merchant.value.merchantId) !== row.merchantId ||
    account.value.account.provider !== endpoint.channel ||
    (endpoint.channel === "gmail" && endpoint.address !== contact.value.address)
  ) {
    return { kind: "not_current" };
  }
  // An endpoint with several current associations has no unique identity.
  const matches = await input.db
    .prepare(
      `SELECT verification_id FROM contact_endpoint_verification AS candidate
    WHERE organisation_id = ? AND integration_account_id = ? AND endpoint_json = ? AND state = 'verified'
      AND revision = (SELECT MAX(revision) FROM contact_endpoint_verification AS latest
        WHERE latest.organisation_id = candidate.organisation_id AND latest.verification_id = candidate.verification_id)
    LIMIT 2`,
    )
    .bind(
      input.organisationId,
      row.integrationAccountId,
      JSON.stringify(endpoint),
    )
    .all();
  if (matches.results.length !== 1) return { kind: "not_current" };
  return {
    kind: "verified",
    endpoint: {
      verificationId: input.verificationId,
      revision: row.revision,
      organisationId: input.organisationId,
      merchantId: row.merchantId,
      integrationAccountId: row.integrationAccountId,
      target,
      endpoint,
    },
  };
}

/**
 * Whether one address is, right now, exactly one verified contact endpoint
 * of this mailbox. An address with no current verification, or with more
 * than one, is a known absence. A record that could not be interpreted
 * decides nothing.
 */
export async function readEndpointVerificationStanding(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    endpoint: ContactEndpoint;
  }>,
): Promise<ContactVerificationStanding> {
  const rows = await input.db
    .prepare(
      `SELECT verification_id AS verificationId, revision
       FROM contact_endpoint_verification AS candidate
       WHERE organisation_id = ? AND integration_account_id = ? AND endpoint_json = ?
         AND state = 'verified'
         AND revision = (
           SELECT MAX(latest.revision)
           FROM contact_endpoint_verification AS latest
           WHERE latest.organisation_id = candidate.organisation_id
             AND latest.verification_id = candidate.verification_id
         )
       ORDER BY verification_id LIMIT 2`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      JSON.stringify(input.endpoint),
    )
    .all<{ readonly verificationId: unknown; readonly revision: unknown }>();
  const row = rows.results[0];
  if (rows.results.length !== 1 || row === undefined)
    return { kind: "not_current" };
  if (!reference(row.verificationId) || !revision(row.revision, 1))
    return { kind: "unreadable" };
  return readContactVerificationStanding({
    db: input.db,
    organisationId: input.organisationId,
    verificationId: row.verificationId,
    expectedRevision: row.revision,
  });
}

export async function resolveVerifiedContactEndpointByEndpoint(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    endpoint: ContactEndpoint;
  }>,
): Promise<Result<VerifiedContactEndpoint, VerificationError>> {
  const rows = await input.db
    .prepare(
      `SELECT verification_id AS verificationId, revision
       FROM contact_endpoint_verification AS candidate
       WHERE organisation_id = ? AND integration_account_id = ? AND endpoint_json = ?
         AND state = 'verified'
         AND revision = (
           SELECT MAX(latest.revision)
           FROM contact_endpoint_verification AS latest
           WHERE latest.organisation_id = candidate.organisation_id
             AND latest.verification_id = candidate.verification_id
         )
       ORDER BY verification_id LIMIT 2`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      JSON.stringify(input.endpoint),
    )
    .all<{ readonly verificationId: string; readonly revision: number }>();
  const row = rows.results[0];
  if (
    rows.results.length !== 1 ||
    row === undefined ||
    !reference(row.verificationId) ||
    !revision(row.revision, 1)
  ) {
    return failure("contact_verification_unavailable");
  }
  return resolveVerifiedContactEndpoint({
    db: input.db,
    organisationId: input.organisationId,
    verificationId: row.verificationId,
    expectedRevision: row.revision,
  });
}

/**
 * The latest revision of one verification, whatever its state, or null when
 * it has none. A record that cannot be interpreted throws.
 */
export async function readLatestContactVerification(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    verificationId: string;
  }>,
): Promise<Readonly<{
  revision: number;
  state: "verified" | "revoked";
  integrationAccountId: IntegrationAccountId;
  target: OperationalEmailTarget;
  endpoint: ContactEndpoint;
}> | null> {
  const latest = await readLatest(
    input.db,
    input.organisationId,
    input.verificationId,
  );
  return latest === null
    ? null
    : {
        revision: latest.revision,
        state: latest.state,
        integrationAccountId: latest.integrationAccountId,
        target: latest.target,
        endpoint: latest.endpoint,
      };
}

/**
 * The verifications whose latest revision verifies this endpoint for this
 * mailbox now, by identity. At most three are named.
 */
export async function listCurrentEndpointVerificationIds(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    endpoint: ContactEndpoint;
  }>,
): Promise<readonly string[]> {
  const rows = await input.db
    .prepare(
      `SELECT verification_id AS verificationId
       FROM contact_endpoint_verification AS candidate
       WHERE organisation_id = ? AND integration_account_id = ? AND endpoint_json = ?
         AND state = 'verified'
         AND revision = (
           SELECT MAX(latest.revision)
           FROM contact_endpoint_verification AS latest
           WHERE latest.organisation_id = candidate.organisation_id
             AND latest.verification_id = candidate.verification_id
         )
       ORDER BY verification_id LIMIT 3`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      JSON.stringify(input.endpoint),
    )
    .all<{ readonly verificationId: unknown }>();
  return rows.results.map((row) => {
    if (!reference(row.verificationId))
      throw new Error("contact_verification_corrupt");
    return row.verificationId;
  });
}

async function readLatest(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  verificationId: string,
): Promise<Verification | null> {
  const row = await db
    .prepare(
      `SELECT revision, request_digest, state, merchant_id, integration_account_id, target_json, endpoint_json
    FROM contact_endpoint_verification WHERE organisation_id = ? AND verification_id = ? ORDER BY revision DESC LIMIT 1`,
    )
    .bind(organisationId, verificationId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const accountId =
    typeof row.integration_account_id === "string"
      ? parseIntegrationAccountId(row.integration_account_id)
      : null;
  const target =
    typeof row.target_json === "string"
      ? parseOperationalEmailTarget(parseJsonOrNull(row.target_json))
      : null;
  const endpoint =
    typeof row.endpoint_json === "string"
      ? parseEndpoint(parseJsonOrNull(row.endpoint_json))
      : null;
  if (
    !revision(row.revision, 1) ||
    typeof row.request_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.request_digest) ||
    (row.state !== "verified" && row.state !== "revoked") ||
    !reference(row.merchant_id) ||
    accountId === null ||
    !accountId.ok ||
    target === null ||
    endpoint === null
  )
    throw new Error("contact_verification_corrupt");
  return {
    revision: row.revision,
    requestDigest: row.request_digest,
    state: row.state,
    merchantId: row.merchant_id,
    integrationAccountId: accountId.value,
    target,
    endpoint,
  };
}

function parseEndpoint(raw: unknown): ContactEndpoint | null {
  if (!isRecord(raw) || Object.keys(raw).length !== 2) return null;
  if (
    raw.channel === "gmail" &&
    typeof raw.address === "string" &&
    raw.address.length <= 320 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(raw.address)
  ) {
    return { channel: "gmail", address: raw.address.toLowerCase() };
  }
  if (
    raw.channel === "whatsapp" &&
    typeof raw.waId === "string" &&
    /^[0-9]{7,20}$/u.test(raw.waId)
  ) {
    return { channel: "whatsapp", waId: raw.waId };
  }
  return null;
}

function reference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9:_.\/-]{0,199}$/u.test(value)
  );
}

function revision(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value < Number.MAX_SAFE_INTEGER
  );
}

function failure(
  code: VerificationError["code"],
): Result<never, VerificationError> {
  return { ok: false, error: { code } };
}
