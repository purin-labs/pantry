import type { ApprovalAuthenticationReadiness } from "./ApprovalAuthenticationReadiness";
import type { OnboardingReadinessBlocker } from "./OnboardingReadinessBlocker";

export type OnboardingReadiness =
  | {
      kind: "blocked";
      readiness_version: number;
      readiness_hash: string;
      configuration_version: number;
      blockers: Array<OnboardingReadinessBlocker>;
      approval_authentication: Array<ApprovalAuthenticationReadiness>;
      assessed_at: number;
    }
  | {
      kind: "ready";
      readiness_version: number;
      readiness_hash: string;
      configuration_version: number;
      requirements: Array<string>;
      approval_authentication: Array<ApprovalAuthenticationReadiness>;
      assessed_at: number;
    };
