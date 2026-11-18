import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import { requirePublicOrigin } from "../../public-origin";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError } from "../http";

export type ChatSignalRoute = Readonly<{
  kind: "chatSignals";
  organisationId: OrganisationId;
}>;

export function matchChatSignalRoute(pathname: string): ChatSignalRoute | null {
  const match = /^\/v1\/control\/organisations\/([^/]+)\/chat\/signals$/u.exec(
    pathname,
  );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    return organisationId.ok
      ? { kind: "chatSignals", organisationId: organisationId.value }
      : null;
  } catch {
    return null;
  }
}

/**
 * The chat GET's checks for the page's signal socket: an Organisation admin
 * with a live session. A browser sends the session cookie with any socket,
 * so the socket must also come from the Portal's origin.
 */
export async function authorizeChatSignalRequest(
  request: Request,
  env: Env,
  route: ChatSignalRoute,
): Promise<
  AuthorizedOrganisationRequest | Readonly<{ ok: false; response: Response }>
> {
  if (request.method !== "GET")
    return { ok: false, response: controlError("method_not_allowed", 405) };
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return { ok: false, response: controlError("websocket_required", 426) };
  if (
    request.headers.get("Origin") !==
    requirePublicOrigin(env.SATYR_PUBLIC_ORIGIN)
  )
    return { ok: false, response: controlError("origin_invalid", 403) };
  return authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "admin",
    false,
  );
}
