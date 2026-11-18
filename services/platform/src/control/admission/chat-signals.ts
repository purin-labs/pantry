import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import type { AuthorizedOrganisationRequest } from "../authorization";
import { authorizeOrganisationSocket } from "./organisation-socket";

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
  return authorizeOrganisationSocket(
    request,
    env,
    route.organisationId,
    "admin",
  );
}
