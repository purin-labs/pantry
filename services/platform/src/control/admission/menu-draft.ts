import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError } from "../http";
import { authorizeOrganisationSocket } from "./organisation-socket";

type MenuDraftTransport = "snapshot" | "socket" | "review";

export type MenuDraftRoute = Readonly<{
  kind: "menuDraft";
  organisationId: OrganisationId;
  transport: MenuDraftTransport;
}>;

export function matchMenuDraftRoute(pathname: string): MenuDraftRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/collaboration\/menu-draft(?:\/(socket|review))?$/u.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    if (!organisationId.ok) return null;
    return {
      kind: "menuDraft",
      organisationId: organisationId.value,
      transport:
        match[2] === "socket"
          ? "socket"
          : match[2] === "review"
            ? "review"
            : "snapshot",
    };
  } catch {
    return null;
  }
}

export async function authorizeMenuDraftRequest(
  request: Request,
  env: Env,
  route: MenuDraftRoute,
): Promise<
  AuthorizedOrganisationRequest | Readonly<{ ok: false; response: Response }>
> {
  if (route.transport === "review") {
    if (request.method !== "POST")
      return { ok: false, response: controlError("method_not_allowed", 405) };
    return authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "operator",
      true,
    );
  }
  if (request.method !== "GET")
    return { ok: false, response: controlError("method_not_allowed", 405) };
  if (route.transport === "snapshot")
    return authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "viewer",
      false,
    );
  return authorizeOrganisationSocket(
    request,
    env,
    route.organisationId,
    "viewer",
  );
}
