import type { FirstOperationalTask } from "./FirstOperationalTask";
import type { OnboardingActivation } from "./OnboardingActivation";
import type { OnboardingMembership } from "./OnboardingMembership";
import type { OnboardingNextAction } from "./OnboardingNextAction";
import type { OnboardingOperatingProfile } from "./OnboardingOperatingProfile";
import type { OnboardingOrganisation } from "./OnboardingOrganisation";
import type { OnboardingProviderAccount } from "./OnboardingProviderAccount";
import type { OnboardingReadiness } from "./OnboardingReadiness";
import type { OnboardingStepProjection } from "./OnboardingStepProjection";
import type { OnboardingSupportReference } from "./OnboardingSupportReference";

export type OnboardingProjectionV1 = {
  schema_version: 1;
  projection_revision: number;
  configuration_version: number;
  organisation: OnboardingOrganisation;
  membership: OnboardingMembership;
  steps: Array<OnboardingStepProjection>;
  provider_accounts: Array<OnboardingProviderAccount>;
  operating_profile: OnboardingOperatingProfile;
  readiness: OnboardingReadiness;
  activation: OnboardingActivation;
  next_action: OnboardingNextAction;
  first_task: FirstOperationalTask | null;
  support_reference: OnboardingSupportReference;
  updated_at: number;
};
