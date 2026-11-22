import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import { controlError } from "../http";
import {
  type EmailDraftRoute,
  authorizeEmailDraftRequest,
} from "../admission/email-draft";

export async function handleEmailDraftRoute(
  request: Request,
  env: Env,
  route: EmailDraftRoute,
): Promise<Response> {
  const authorized = await authorizeEmailDraftRequest(request, env, route);
  if (!authorized.ok) return authorized.response;
  try {
    const organisation = await requireActiveOrganisationActor({ env, organisationId: route.organisationId, now: Date.now() });
    return organisation.fetch(request);
  } catch {
    return controlError("email_draft_unavailable", 503);
  }
}
