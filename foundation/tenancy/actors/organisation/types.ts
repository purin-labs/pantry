// The base types of the Organisation actor: its record and its state errors.
// The types of each module that the actor hosts are in a file of that module:
// commerce-types.ts, policy-types.ts, activation-types.ts and code-mode-types.ts.
import type { OrganisationId } from "@purin-labs/kernel/ids";

export type OrganisationPing = {
  ok: true;
  kind: "organisation";
};

type OrganisationPlan = "beta";

export type OrganisationStatus = "active" | "suspended" | "deleted" | "purged";

export type OrganisationMetaInput = {
  organisationId: OrganisationId;
  name: string;
  plan: OrganisationPlan;
  status: OrganisationStatus;
  createdAt: number;
};

export type OrganisationMeta = OrganisationMetaInput;

export type OrganisationMetaRequest = {
  requestingOrganisationId: OrganisationId;
};

export type OrganisationStateError =
  | { code: "organisation_not_initialized" }
  | { code: "organisation_mismatch" }
  | { code: "invalid_policy_snapshot" }
  | {
      code: "policy_version_stale";
      activeVersion: number;
      receivedVersion: number;
    }
  | { code: "policy_version_conflict"; version: number };

/** The Organisation Actor is no longer at the placement of the command. */
export type OrganisationPlacementConflict = {
  readonly code: "organisation_placement_conflict";
};

/**
 * What each command of the Organisation Actor can fail with before or after
 * its own work: the check of the Organisation record and the placement
 * admission. A caller's RPC interface joins these with its own errors.
 */
export type OrganisationCommandFailure =
  OrganisationStateError | OrganisationPlacementConflict;

export type OrganisationCutoverCueSettlementInput = {
  readonly organisationId: OrganisationId;
  readonly settledAt: number;
};

export type OrganisationCutoverCueSettlementError = {
  readonly code: "organisation_cutover_cue_mismatch";
};

export type OrganisationMetaRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  name: string;
  plan: OrganisationPlan;
  status: OrganisationStatus;
  created_at: number;
};
