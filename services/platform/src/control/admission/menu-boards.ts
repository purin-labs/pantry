import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import type { AuthorizedOrganisationRequest } from "../authorization";
import { authorizeOrganisationSocket } from "./organisation-socket";

export type MenuBoardSocketRoute = Readonly<{
  organisationId: OrganisationId;
  boardId: string;
}>;

/** The board's shared draft socket, which the Organisation Actor serves. */
export function matchMenuBoardSocketRoute(
  pathname: string,
): MenuBoardSocketRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/menu-boards\/([A-Za-z0-9_-]{1,128})\/socket$/u.exec(
      pathname,
    );
  if (match === null) return null;
  const organisationId = parseOrganisationId(
    decodeURIComponent(match[1] ?? ""),
  );
  return organisationId.ok
    ? { organisationId: organisationId.value, boardId: match[2] ?? "" }
    : null;
}

export async function authorizeMenuBoardSocketRequest(
  request: Request,
  env: Env,
  route: MenuBoardSocketRoute,
): Promise<
  AuthorizedOrganisationRequest | Readonly<{ ok: false; response: Response }>
> {
  return authorizeOrganisationSocket(
    request,
    env,
    route.organisationId,
    "viewer",
  );
}
