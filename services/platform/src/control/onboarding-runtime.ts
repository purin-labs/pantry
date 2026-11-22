import type { RuntimeAdmissionStatus } from "../data/onboarding";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { resolveOrganisationModelRoute } from "@purin-labs/agent/models/route";
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
