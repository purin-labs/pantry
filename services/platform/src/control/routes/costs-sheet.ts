import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import { controlError } from "../http";
import {
  type CostsSheetRoute,
  authorizeCostsSheetRequest,
} from "../admission/costs-sheet";

export async function handleCostsSheetRoute(
  request: Request,
  env: Env,
  route: CostsSheetRoute,
): Promise<Response> {
  const authorized = await authorizeCostsSheetRequest(request, env, route);
  if (!authorized.ok) {
    return authorized.response;
  }
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: route.organisationId,
      now: Date.now(),
    });
    return organisation.fetch(request);
  } catch {
    return controlError("costs_sheet_unavailable", 503);
  }
}
