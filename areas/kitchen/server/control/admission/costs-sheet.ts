import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import { controlError } from "@purin-labs/control/worker/http";
import { authorizeOrganisationSocket } from "@purin-labs/control/worker/admission/organisation-socket";

type CostsSheetTransport = "snapshot" | "socket" | "reset";

export type CostsSheetRoute = Readonly<{
  kind: "costsSheet";
  organisationId: OrganisationId;
  transport: CostsSheetTransport;
}>;

export function matchCostsSheetRoute(pathname: string): CostsSheetRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/costs\/sheet(?:\/(socket|reset))?$/u.exec(
      pathname,
    );
  if (match === null) {
    return null;
  }
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    if (!organisationId.ok) {
      return null;
    }
    return {
      kind: "costsSheet",
      organisationId: organisationId.value,
      transport:
        match[2] === "socket"
          ? "socket"
          : match[2] === "reset"
            ? "reset"
            : "snapshot",
    };
  } catch {
    return null;
  }
}

export async function authorizeCostsSheetRequest(
  request: Request,
  env: Env,
  route: CostsSheetRoute,
): Promise<
  AuthorizedOrganisationRequest | Readonly<{ ok: false; response: Response }>
> {
  if (route.transport === "reset") {
    if (request.method !== "POST") {
      return { ok: false, response: controlError("method_not_allowed", 405) };
    }
    return authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "operator",
      true,
    );
  }
  if (request.method !== "GET") {
    return { ok: false, response: controlError("method_not_allowed", 405) };
  }
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
