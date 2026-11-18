import type { OnboardingEnvironment } from "./OnboardingEnvironment";

export type OrganisationOnboardingLifecycle =
  | {
      kind: "configuring";
      organisation_id: string;
      configuration_version: number;
      environment: OnboardingEnvironment;
    }
  | {
      kind: "activating";
      organisation_id: string;
      activation_attempt_id: string;
      readiness_version: number;
      environment: OnboardingEnvironment;
    }
  | {
      kind: "active";
      organisation_id: string;
      activation_receipt_id: string;
      activated_at: number;
      environment: OnboardingEnvironment;
    }
  | {
      kind: "archived";
      organisation_id: string;
      archived_at: number;
      purge_after: number;
      environment: OnboardingEnvironment;
    };
