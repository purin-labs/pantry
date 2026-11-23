import { isNonEmptyString, isRecord } from "@purin-labs/std";

/** An incomplete list contains only organisations that passed fresh access checks. */
export type ControlMembershipAvailability = "complete" | "incomplete";

export function parseControlMembershipAvailability(
  value: unknown,
): ControlMembershipAvailability {
  if (value === "complete" || value === "incomplete") return value;
  throw new Error("Invalid membership availability");
}

/**
 * The body of `POST /v1/control/organisations` (Plan 95 step 2). The
 * operation id is the idempotency key: a repeat with the same id and name
 * returns the same organisation and makes no second one. `purpose: "test"`
 * asks for a test organisation in the development environment (Plan 91
 * phase 4): it takes provider test accounts, and only a person on the
 * deployment's list of test organisation owners may make one.
 */
export type OrganisationCreationRequest = Readonly<{
  operationId: string;
  name: string;
  purpose?: "test";
}>;

/** The shortest organisation name that Pantry takes, after a trim. */
export const ORGANISATION_NAME_MIN = 2;
/** The longest organisation name that Pantry takes, after a trim. */
export const ORGANISATION_NAME_MAX = 120;

/**
 * The trimmed name, or null when it is not a string of
 * `ORGANISATION_NAME_MIN` to `ORGANISATION_NAME_MAX` characters. Creation and
 * a rename take the same names.
 */
export function readOrganisationName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length < ORGANISATION_NAME_MIN ||
    name.length > ORGANISATION_NAME_MAX
    ? null
    : name;
}

const OPERATION_ID = /^[A-Za-z0-9_-]{8,128}$/u;

/**
 * The request, or null when the value is not a valid
 * `{ operationId, name, purpose? }`.
 */
export function readOrganisationCreationRequest(
  value: unknown,
): OrganisationCreationRequest | null {
  if (
    !isRecord(value) ||
    typeof value.operationId !== "string" ||
    !OPERATION_ID.test(value.operationId) ||
    (value.purpose !== undefined && value.purpose !== "test")
  )
    return null;
  const name = readOrganisationName(value.name);
  if (name === null) return null;
  return value.purpose === "test"
    ? { operationId: value.operationId, name, purpose: "test" }
    : { operationId: value.operationId, name };
}

export type CreatedOrganisation = Readonly<{
  organisationId: string;
  organisationHandle: string;
}>;

/** The organisation of an `{ ok: true, organisation }` answer, or null. */
export function parseCreatedOrganisation(
  raw: unknown,
): CreatedOrganisation | null {
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.organisation))
    return null;
  const { organisationId, organisationHandle } = raw.organisation;
  return isNonEmptyString(organisationId) &&
    isNonEmptyString(organisationHandle)
    ? { organisationId, organisationHandle }
    : null;
}
