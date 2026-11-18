import type { OnboardingControlRole } from "./OnboardingControlRole";

export type OnboardingMembership = {
  user_id: string;
  person_id: string;
  role: OnboardingControlRole;
  created_at: number;
};
