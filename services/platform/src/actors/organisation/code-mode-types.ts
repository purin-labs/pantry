// The error of the Code Mode budget methods of the Organisation actor.
import type { CodeModeBudgetError } from "../code-mode-budget";
import type { OrganisationStatus } from "./types";

export type CodeModeOrganisationActorError =
  | CodeModeBudgetError
  | { readonly code: "organisation_not_initialized" }
  | { readonly code: "organisation_mismatch" }
  | {
      readonly code: "organisation_not_active";
      readonly status: OrganisationStatus;
    };
