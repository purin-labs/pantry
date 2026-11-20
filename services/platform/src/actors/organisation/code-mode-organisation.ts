import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import type { CodeModeOrganisationActorError } from "./code-mode-types";
import { readOrganisationMetaRow } from "./organisation-record";
import type { OrganisationMetaRow } from "./types";

/** Checks the Organisation record for a Code Mode command. */
export function validateCodeModeOrganisation(
  sql: SqlStorage,
  organisationId: OrganisationId,
  requireActive: boolean,
): Result<OrganisationMetaRow, CodeModeOrganisationActorError> {
  const organisation = readOrganisationMetaRow(sql);
  if (organisation === undefined) {
    return { ok: false, error: { code: "organisation_not_initialized" } };
  }
  if (organisation.organisation_id !== organisationId) {
    return { ok: false, error: { code: "organisation_mismatch" } };
  }
  if (requireActive && organisation.status !== "active") {
    return {
      ok: false,
      error: { code: "organisation_not_active", status: organisation.status },
    };
  }
  return { ok: true, value: organisation };
}
