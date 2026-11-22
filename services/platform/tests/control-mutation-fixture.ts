import type { User } from "@purin-labs/tenancy/data/control-plane";
import {
  newControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "@purin-labs/tenancy/data/control-mutation";
import type { OrganisationBootstrapMutation } from "@purin-labs/tenancy/data/control-plane";

export function organisationBootstrapMutation(
  owner: User,
  now: number,
): OrganisationBootstrapMutation {
  const idempotencyKey = `fixture-${crypto.randomUUID()}`;
  const scope: ControlMutationReceiptScope = {
    userId: owner.userId,
    organisationScope: "organisation:create",
    route: "/v1/control/organisations",
    operation: "organisation.create",
  };
  return {
    scope,
    boundary: {
      kind: "unversioned",
      idempotencyKey,
      requestHash: "fixture-request-hash",
    },
    identity: newControlMutationIdentity({
      portalSubjectHash: "fixture-portal-subject-hash",
      causationId: `fixture-${crypto.randomUUID()}`,
      now,
    }),
  };
}
