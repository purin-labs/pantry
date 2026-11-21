import type { CapabilityMode } from "./CapabilityMode";
import type { CapabilityPolicyProvenance } from "./CapabilityPolicyProvenance";
import type { OrganisationId } from "@purin-labs/contract-schema";

export type OrganisationCapabilityPolicy = {
  organisationId: OrganisationId;
  capabilityId: string;
  capabilityVersion: number;
  mode: CapabilityMode;
  provenance: CapabilityPolicyProvenance;
  revision: number;
  changedAt: number;
};
