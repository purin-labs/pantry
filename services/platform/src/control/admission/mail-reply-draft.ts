import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import { requirePublicOrigin } from "../../public-origin";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError } from "../http";

/**
 * Plan 40D: the socket of one Inbox reply's shared draft. The room checks the
 * mailbox and the reply review for each participant; saving, reloading and
 * sending are reply actions (`email-replies/:id/draft-save` and others).
 */
export type MailReplyDraftRoute = Readonly<{
  kind: "mailReplyDraft";
  organisationId: OrganisationId;
  proposalId: string;
}>;

export function matchMailReplyDraftRoute(
  pathname: string,
): MailReplyDraftRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/email-replies\/([^/]+)\/draft\/socket$/u.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    const proposalId = decodeURIComponent(match[2] ?? "");
    return organisationId.ok && isMailReplyDraftProposalId(proposalId)
      ? {
          kind: "mailReplyDraft",
          organisationId: organisationId.value,
          proposalId,
        }
      : null;
  } catch {
    return null;
  }
}

export function isMailReplyDraftProposalId(value: string): boolean {
  return /^proposal_[A-Za-z0-9_:.-]{1,500}$/u.test(value);
}

export async function authorizeMailReplyDraftRequest(
  request: Request,
  env: Env,
  route: MailReplyDraftRoute,
): Promise<
  AuthorizedOrganisationRequest | Readonly<{ ok: false; response: Response }>
> {
  if (request.method !== "GET")
    return { ok: false, response: controlError("method_not_allowed", 405) };
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return { ok: false, response: controlError("websocket_required", 426) };
  // Browser WebSockets cannot set the CSRF header. Require the exact configured origin.
  if (
    request.headers.get("Origin") !==
    requirePublicOrigin(env.SATYR_PUBLIC_ORIGIN)
  )
    return { ok: false, response: controlError("origin_invalid", 403) };
  return authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "viewer",
    false,
  );
}
