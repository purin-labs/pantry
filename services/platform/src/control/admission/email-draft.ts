import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError } from "../http";
import { authorizeOrganisationSocket } from "./organisation-socket";

type EmailDraftTransport = "snapshot" | "socket" | "review" | "shared-thread";

export type EmailDraftRoute = Readonly<{
  kind: "emailDraft";
  organisationId: OrganisationId;
  transport: EmailDraftTransport;
}>;

export function matchEmailDraftRoute(pathname: string): EmailDraftRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/collaboration\/email-draft(?:\/(socket|review|shared-thread))?$/u.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    if (!organisationId.ok) return null;
    return {
      kind: "emailDraft",
      organisationId: organisationId.value,
      transport:
        match[2] === "socket"
          ? "socket"
          : match[2] === "review"
            ? "review"
            : match[2] === "shared-thread"
              ? "shared-thread"
              : "snapshot",
    };
  } catch {
    return null;
  }
}

export async function authorizeEmailDraftRequest(
  request: Request,
  env: Env,
  route: EmailDraftRoute,
): Promise<
  AuthorizedOrganisationRequest | Readonly<{ ok: false; response: Response }>
> {
  if (route.transport === "shared-thread") {
    if (!["GET", "PUT", "DELETE"].includes(request.method)) {
      return { ok: false, response: controlError("method_not_allowed", 405) };
    }
    return authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "admin",
      request.method !== "GET",
    );
  }
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
  if (route.transport === "snapshot") {
    return authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "viewer",
      false,
    );
  }
  return authorizeOrganisationSocket(
    request,
    env,
    route.organisationId,
    "viewer",
  );
}
