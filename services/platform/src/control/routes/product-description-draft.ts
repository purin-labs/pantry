import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import { controlError } from "../http";
import {
  type ProductDescriptionDraftRoute,
  authorizeProductDescriptionDraftRequest,
} from "../admission/product-description-draft";

export async function handleProductDescriptionDraftRoute(request: Request, env: Env, route: ProductDescriptionDraftRoute): Promise<Response> {
  const authorized = await authorizeProductDescriptionDraftRequest(request, env, route);
  if (!authorized.ok) return authorized.response;
  try {
    const organisation = await requireActiveOrganisationActor({ env, organisationId: authorized.organisationId, now: Date.now() });
    return organisation.fetch(request);
  } catch { return controlError("description_draft_unavailable", 503); }
}
