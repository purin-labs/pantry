import type { OrganisationActivatePolicyInput } from "@purin-labs/authority/actors/organisation/policy-types";
import type { OrganisationPolicyPlacement } from "@purin-labs/authority/policy-snapshot";

declare const input: OrganisationActivatePolicyInput;

// @ts-expect-error Activation requires the expected placement, even for a valid snapshot.
const missingPlacement: OrganisationActivatePolicyInput = {
  requestId: input.requestId,
  organisationId: input.organisationId,
  snapshot: input.snapshot,
  activatedAt: input.activatedAt,
};
// @ts-expect-error A placement epoch alone cannot authorize publication without its fence.
const missingFence: OrganisationPolicyPlacement = {
  placement: input.placement.placement,
};
