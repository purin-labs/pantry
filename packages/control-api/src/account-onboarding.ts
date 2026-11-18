export {
  readAccountOnboardingRequest,
  readAccountOnboardingOptions,
  readAccountOnboardingResult,
  type AccountOnboardingSelection,
  type AccountOnboardingRequest,
  type AccountOnboardingOrganization,
  type AccountOnboardingOptions,
  type AccountOnboardingResult,
} from "@seams-internal/console-shared/accountPlatform";

/** An incomplete list contains only organisations that passed fresh access checks. */
export type ControlMembershipAvailability = "complete" | "incomplete";

export function parseControlMembershipAvailability(
  value: unknown,
): ControlMembershipAvailability {
  if (value === "complete" || value === "incomplete") return value;
  throw new Error("Invalid membership availability");
}
