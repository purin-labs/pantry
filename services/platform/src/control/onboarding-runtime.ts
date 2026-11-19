import type { RuntimeAdmissionStatus } from "../data/onboarding";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import { resolveOrganisationModelRoute } from "../models/route";
import type { OrganisationModelRouteError } from "../models/route";
import { assertNever } from "@purin-labs/std";
export async function runtimeAdmissionStatus(
  env: Env,
  organisationId: OrganisationId,
  now: number,
): Promise<RuntimeAdmissionStatus> {
  const route = await resolveOrganisationModelRoute({
    env,
    organisationId,
    now,
  });
  return route.ok ? "available" : "unavailable";
}

export function activationErrorStatus(code: string): number {
  return code === "activation_readiness_stale" ||
    code === "activation_attempt_in_progress"
    ? 409
    : 500;
}

export function activationModelRouteError(
  code: OrganisationModelRouteError["code"],
): string {
  switch (code) {
    case "claude_connection_unavailable":
      return "claude_connection_required";
    case "organisation_codex_subscription_unavailable":
      return "codex_subscription_required";
    case "satyr_platform_credential_unavailable":
      return "satyr_platform_credential_required";
    case "satyr_platform_model_unsupported":
      return "satyr_platform_model_unsupported";
    case "organisation_openai_api_key_unavailable":
      return "organisation_openai_api_key_required";
    case "organisation_anthropic_api_key_unavailable":
      return "organisation_anthropic_api_key_required";
    case "organisation_inference_selection_unavailable":
      return "inference_selection_unavailable";
    default:
      return assertNever(code);
  }
}
