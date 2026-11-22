import {
  applyVersionedAccessDefaults,
  changeVersionedCapabilityPolicy,
} from "@purin-labs/authority/access-control/capability-mutations";
import {
  prepareReadAndProposeAccessDefaults,
  writeOrganisationCapabilityPolicy,
  type CapabilityPolicyAdmission,
  type CapabilityPolicyWrite,
} from "@purin-labs/authority/data/capability-policy";
import { selectSetupTemplates } from "@purin-labs/area-organisation/server/data/onboarding";
import { publishCommerceExportPreset } from "../src/data/export-preset";
import {
  assignWhatsAppSupportAgent,
  ensureWhatsAppSupportContextGrant,
} from "@purin-labs/area-inbox/server/data/whatsapp";

declare const change: Parameters<typeof changeVersionedCapabilityPolicy>[0];
declare const defaults: Parameters<typeof applyVersionedAccessDefaults>[0];
declare const policy: Parameters<typeof writeOrganisationCapabilityPolicy>[0];
declare const setup: Parameters<typeof selectSetupTemplates>[0];
declare const publication: Parameters<typeof publishCommerceExportPreset>[0];
declare const binding: Parameters<typeof assignWhatsAppSupportAgent>[0];
declare const repair: Parameters<typeof ensureWhatsAppSupportContextGrant>[0];
declare const baseline: Parameters<
  typeof prepareReadAndProposeAccessDefaults
>[0];
declare const creation: Extract<
  CapabilityPolicyAdmission,
  { kind: "organisation_creation" }
>;
declare const accepted: Extract<
  CapabilityPolicyAdmission,
  { kind: "accepted_mutation" }
>;
declare const materialize: Extract<
  CapabilityPolicyWrite,
  { kind: "materialize" }
>;

const { scope, ...unscopedChange } = change;
const { scope: defaultsScope, ...unscopedDefaults } = defaults;
const { scope: policyScope, ...unscopedPolicy } = policy;
const { scope: setupScope, ...unscopedSetup } = setup;
const { scope: publicationScope, ...unscopedPublication } = publication;
const { scope: bindingScope, ...unscopedBinding } = binding;
const { scope: repairScope, ...unscopedRepair } = repair;
const { identity, ...unsettledChange } = change;
const { admission, ...unadmittedBaseline } = baseline;
const { auditEventId, ...unacceptedMutation } = accepted;

// @ts-expect-error Every capability mutation carries captured placement.
changeVersionedCapabilityPolicy(unscopedChange);
// @ts-expect-error Baseline application carries captured placement.
applyVersionedAccessDefaults(unscopedDefaults);
// @ts-expect-error Direct policy changes carry captured placement.
writeOrganisationCapabilityPolicy(unscopedPolicy);
// @ts-expect-error Setup materialization carries captured placement.
selectSetupTemplates(unscopedSetup);
// @ts-expect-error Export materialization carries captured placement.
publishCommerceExportPreset(unscopedPublication);
// @ts-expect-error Support assignment carries captured placement.
assignWhatsAppSupportAgent(unscopedBinding);
// @ts-expect-error Grant repair carries captured placement.
ensureWhatsAppSupportContextGrant(unscopedRepair);
// @ts-expect-error Policy and its receipt must settle together.
changeVersionedCapabilityPolicy(unsettledChange);
// @ts-expect-error A spread loses the private scope authority.
applyVersionedAccessDefaults({ ...defaults, scope: { ...scope } });
writeOrganisationCapabilityPolicy({
  ...policy,
  // @ts-expect-error An independent organisation identity cannot override captured scope.
  organisationId: scope.organisationId,
});
// @ts-expect-error Materialization always requires explicit admission.
prepareReadAndProposeAccessDefaults(unadmittedBaseline);
// @ts-expect-error Creation and execution admission are separate branches.
const mixedCreation: CapabilityPolicyAdmission = { ...creation, scope };
// @ts-expect-error Dependent rows require the accepted transaction marker.
const missingMarker: CapabilityPolicyAdmission = unacceptedMutation;
// @ts-expect-error Execution admission cannot include a mutation marker.
const mixedExecution: CapabilityPolicyAdmission = {
  kind: "organisation_execution",
  scope,
  auditEventId,
  configurationVersion: 2,
};
// @ts-expect-error Materialization has no record revision precondition.
const mixedPolicyWrite: CapabilityPolicyWrite = {
  ...materialize,
  expectedRevision: 1,
};
