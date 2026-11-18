import type { OnboardingCapabilityProfile } from "./OnboardingCapabilityProfile";
import type { OrganisationOnboardingLifecycle } from "./OrganisationOnboardingLifecycle";

export type OnboardingOrganisation = {
  organisation_id: string;
  name: string;
  plan: string;
  lifecycle: OrganisationOnboardingLifecycle;
  capability_profile: OnboardingCapabilityProfile;
  created_at: number;
};
