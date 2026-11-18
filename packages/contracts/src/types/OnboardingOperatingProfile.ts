import type { OnboardingCapabilityProfile } from "./OnboardingCapabilityProfile";
import type { OnboardingCueTarget } from "./OnboardingCueTarget";

export type OnboardingOperatingProfile =
  | { kind: "unconfigured" }
  | {
      kind: "configured";
      policy_template_id: string;
      capability_profile: OnboardingCapabilityProfile;
      cue_preset_id: string;
      cue_target: OnboardingCueTarget;
    };
