import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import type { OrganisationMetaRow, OrganisationStateError } from "./types";

/** The Organisation record of this actor, or undefined before it is set. */
export function readOrganisationMetaRow(
  sql: SqlStorage,
): OrganisationMetaRow | undefined {
  const rows = sql
    .exec<OrganisationMetaRow>(
      `SELECT organisation_id, name, plan, status, created_at
       FROM organisation_meta
       LIMIT 1`,
    )
    .toArray();

  return rows[0];
}

/** Checks that this actor holds the record of the Organisation of a request. */
export function validateActionOrganisation(
  sql: SqlStorage,
  organisationId: OrganisationId,
): Result<null, OrganisationStateError> {
  const organisation = readOrganisationMetaRow(sql);

  if (organisation === undefined) {
    return { ok: false, error: { code: "organisation_not_initialized" } };
  }

  if (organisation.organisation_id !== organisationId) {
    return { ok: false, error: { code: "organisation_mismatch" } };
  }

  return { ok: true, value: null };
}

/** The answer of a command whose Organisation is not placed here now. */
export function organisationPlacementConflict(): Result<
  never,
  { readonly code: "organisation_placement_conflict" }
> {
  return { ok: false, error: { code: "organisation_placement_conflict" } };
}
