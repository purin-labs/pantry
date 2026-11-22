// The types of the policy methods of the Organisation actor.
import type { RequestId, OrganisationId } from "@purin-labs/kernel/ids";
import type {
  OrganisationPolicyPlacement,
  OrganisationPolicySnapshot,
} from "../../policy-snapshot";
import type { OrganisationStateError } from "./types";

export type OrganisationPolicyHead = {
  activeVersion: number;
  restrictionVersion: number;
  digest: string;
  activatedAt: number;
};

export type OrganisationActivatePolicyInput = {
  placement: OrganisationPolicyPlacement;
  requestId: RequestId;
  organisationId: OrganisationId;
  snapshot: OrganisationPolicySnapshot;
  activatedAt: number;
};

export type OrganisationPolicyActivationError =
  OrganisationStateError | { readonly code: "policy_placement_conflict" };

export type OrganisationPolicyActivation = {
  head: OrganisationPolicyHead;
  consumers: number;
  delivered: number;
  pending: number;
};

export type OrganisationPolicyHeadRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  active_version: number;
  restriction_version: number;
  digest: string;
  body: string;
  activated_at: number;
};
