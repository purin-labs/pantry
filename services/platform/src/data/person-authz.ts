import type { OrganisationDatabase } from "../database-handles";
import {
  parsePersonId as parseCanonicalPersonId,
  type PersonId,
  type RequestId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";

export type { PersonId } from "../ids";

export type ApprovalRole = "approve";
export type PersonRoleOperation = "grant" | "revoke";

declare const personRoleAuditIdBrand: unique symbol;

export type PersonRoleAuditId = string & {
  readonly [personRoleAuditIdBrand]: "PersonRoleAuditId";
};

export type PersonRoleRecord = {
  organisationId: OrganisationId;
  personId: PersonId;
  displayName: string;
  roles: readonly ApprovalRole[];
};

export type ConfigurePersonRoleInput = {
  organisationId: OrganisationId;
  personId: PersonId;
  operation: PersonRoleOperation;
  role: ApprovalRole;
  requestId: RequestId;
  now: number;
};

export type ConfigurePersonRoleResult = {
  kind: "configured";
  organisationId: OrganisationId;
  personId: PersonId;
  operation: PersonRoleOperation;
  role: ApprovalRole;
  auditId: PersonRoleAuditId;
};

export type PersonRoleAdminError =
  { code: "person_not_found" } | { code: "invalid_person_record" };

export type PersonAdminRow = {
  personId: unknown;
  displayName: unknown;
};

export type PersonRoleRow = {
  personId: unknown;
  role: unknown;
};

type PersonExistenceRow = {
  personId: unknown;
};

const PERSON_ID_PATTERN = /^person_[A-Za-z0-9-]+$/u;
const MAX_DISPLAY_NAME_CHARS = 160;

export async function listOrganisationPersonRoles(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<readonly PersonRoleRecord[], PersonRoleAdminError>> {
  const session = db.withSession("first-primary");
  const people = await session
    .prepare(
      `SELECT person_id AS personId, display_name AS displayName
       FROM person
       WHERE organisation_id = ?
       ORDER BY display_name, person_id`,
    )
    .bind(organisationId)
    .all<PersonAdminRow>();
  const roles = await session
    .prepare(
      `SELECT person_id AS personId, role AS role
       FROM person_authz_role
       WHERE organisation_id = ? AND role = 'approve'
       ORDER BY person_id, role`,
    )
    .bind(organisationId)
    .all<PersonRoleRow>();

  return parsePersonRoleRecords(organisationId, people.results, roles.results);
}

export async function configurePersonRole(
  db: OrganisationDatabase,
  input: ConfigurePersonRoleInput,
): Promise<Result<ConfigurePersonRoleResult, PersonRoleAdminError>> {
  const session = db.withSession("first-primary");
  const person = await session
    .prepare(
      `SELECT person_id AS personId
       FROM person
       WHERE organisation_id = ? AND person_id = ?`,
    )
    .bind(input.organisationId, input.personId)
    .first<PersonExistenceRow>();

  if (person === null) {
    return { ok: false, error: { code: "person_not_found" } };
  }

  if (parsePersonId(person.personId) === null) {
    return { ok: false, error: { code: "invalid_person_record" } };
  }

  const auditId = newPersonRoleAuditId();
  const roleMutation =
    input.operation === "grant"
      ? session
          .prepare(
            `INSERT OR IGNORE INTO person_authz_role (
             organisation_id, person_id, role, granted_at
           ) VALUES (?, ?, ?, ?)`,
          )
          .bind(input.organisationId, input.personId, input.role, input.now)
      : session
          .prepare(
            `DELETE FROM person_authz_role
           WHERE organisation_id = ? AND person_id = ? AND role = ?`,
          )
          .bind(input.organisationId, input.personId, input.role);
  const audit = session
    .prepare(
      `INSERT INTO person_authz_audit (
         organisation_id, audit_id, person_id, operation, role, actor_kind,
         request_id, recorded_at
       ) VALUES (?, ?, ?, ?, ?, 'organisation_admin_token', ?, ?)`,
    )
    .bind(
      input.organisationId,
      auditId,
      input.personId,
      input.operation,
      input.role,
      input.requestId,
      input.now,
    );

  await session.batch([roleMutation, audit]);

  return {
    ok: true,
    value: {
      kind: "configured",
      organisationId: input.organisationId,
      personId: input.personId,
      operation: input.operation,
      role: input.role,
      auditId,
    },
  };
}

export function parsePersonRoleRecords(
  organisationId: OrganisationId,
  people: readonly PersonAdminRow[],
  roles: readonly PersonRoleRow[],
): Result<readonly PersonRoleRecord[], PersonRoleAdminError> {
  const records = new Map<PersonId, PersonRoleRecord>();

  for (const row of people) {
    const personId = parsePersonId(row.personId);
    const displayName = parseDisplayName(row.displayName);

    if (personId === null || displayName === null || records.has(personId)) {
      return { ok: false, error: { code: "invalid_person_record" } };
    }

    records.set(personId, {
      organisationId,
      personId,
      displayName,
      roles: [],
    });
  }

  for (const row of roles) {
    const personId = parsePersonId(row.personId);
    const role = parseApprovalRole(row.role);
    const record = personId === null ? undefined : records.get(personId);

    if (
      personId === null ||
      record === undefined ||
      role === null ||
      record.roles.includes(role)
    ) {
      return { ok: false, error: { code: "invalid_person_record" } };
    }

    records.set(personId, personRecordWithRole(record, role));
  }

  return { ok: true, value: Array.from(records.values()) };
}

export function parsePersonId(raw: unknown): PersonId | null {
  if (typeof raw !== "string" || !PERSON_ID_PATTERN.test(raw)) {
    return null;
  }
  const parsed = parseCanonicalPersonId(raw);
  return parsed.ok ? parsed.value : null;
}

export function parseApprovalRole(raw: unknown): ApprovalRole | null {
  return raw === "approve" ? raw : null;
}

export function parsePersonRoleOperation(
  raw: unknown,
): PersonRoleOperation | null {
  return raw === "grant" || raw === "revoke" ? raw : null;
}

function parseDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const value = raw.trim();
  return value.length > 0 && value.length <= MAX_DISPLAY_NAME_CHARS
    ? value
    : null;
}

function personRecordWithRole(
  record: PersonRoleRecord,
  role: ApprovalRole,
): PersonRoleRecord {
  return {
    organisationId: record.organisationId,
    personId: record.personId,
    displayName: record.displayName,
    roles: [...record.roles, role],
  };
}

function newPersonRoleAuditId(): PersonRoleAuditId {
  return `roleaudit_${crypto.randomUUID()}` as PersonRoleAuditId;
}
