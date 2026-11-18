import { requireActiveOrganisationActor } from "../../actors/actor-router";
import type { Env } from "../../env";
import { controlError } from "../http";
import {
  type MailReplyDraftRoute,
  authorizeMailReplyDraftRequest,
} from "../admission/mail-reply-draft";

export async function handleMailReplyDraftRoute(
  request: Request,
  env: Env,
  route: MailReplyDraftRoute,
): Promise<Response> {
  const authorized = await authorizeMailReplyDraftRequest(request, env, route);
  if (!authorized.ok) return authorized.response;
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    return organisation.fetch(request);
  } catch {
    return controlError("mail_reply_draft_unavailable", 503);
  }
}
