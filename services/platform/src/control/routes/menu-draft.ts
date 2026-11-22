import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import { controlError } from "@purin-labs/control/worker/http";
import {
  type MenuDraftRoute,
  authorizeMenuDraftRequest,
} from "../admission/menu-draft";

export async function handleMenuDraftRoute(request: Request, env: Env, route: MenuDraftRoute): Promise<Response> {
  const authorized = await authorizeMenuDraftRequest(request, env, route);
  if (!authorized.ok) return authorized.response;
  try {
    const organisation = await requireActiveOrganisationActor({ env, organisationId: route.organisationId, now: Date.now() });
    return organisation.fetch(request);
  } catch {
    return controlError("menu_draft_unavailable", 503);
  }
}
