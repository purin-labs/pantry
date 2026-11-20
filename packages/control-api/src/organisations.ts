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
 * returns the same organisation and makes no second one.
 */
export type OrganisationCreationRequest = Readonly<{
  operationId: string;
  name: string;
}>;

/** The longest organisation name that Pantry takes, after a trim. */
export const ORGANISATION_NAME_MAX = 120;

const OPERATION_ID = /^[A-Za-z0-9_-]{8,128}$/u;

/** The request, or null when the value is not a valid `{ operationId, name }`. */
export function readOrganisationCreationRequest(
  value: unknown,
): OrganisationCreationRequest | null {
  if (
    !isRecord(value) ||
    typeof value.operationId !== "string" ||
    !OPERATION_ID.test(value.operationId) ||
    typeof value.name !== "string"
  )
    return null;
  const name = value.name.trim();
  return name.length === 0 || name.length > ORGANISATION_NAME_MAX
    ? null
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
