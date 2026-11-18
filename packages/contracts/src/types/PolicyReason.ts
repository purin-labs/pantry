import type { PolicyLayer } from "./PolicyLayer";

export type PolicyReason = {
  ruleId: string;
  layer: PolicyLayer;
  policyVersion: number;
  subjectDigest: string;
  code: string;
  coachText: string | null;
};
