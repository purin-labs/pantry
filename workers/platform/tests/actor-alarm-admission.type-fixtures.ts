import type { ActorRecoveryAdmission } from "@purin-labs/actor-runtime/actors/actor-activation";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

declare const scope: OrganisationExecutionScope;
declare const admitted: Extract<ActorRecoveryAdmission, { kind: "admitted" }>;

// @ts-expect-error An admitted alarm requires captured placement authority.
const missingScope: ActorRecoveryAdmission = { kind: "admitted" };
// @ts-expect-error Deferred alarms cannot carry execution authority.
const deferredScope: ActorRecoveryAdmission = { kind: "deferred", scope };
// @ts-expect-error Spreading an admission cannot turn its scope into a deferred branch.
const mixedAdmission: ActorRecoveryAdmission = {
  ...admitted,
  kind: "deferred",
};
const forgedScope: ActorRecoveryAdmission = {
  kind: "admitted",
  // @ts-expect-error A scope spread loses the private database authority.
  scope: { ...scope },
};
void forgedScope;
