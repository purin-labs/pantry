import type { ControlRole } from "../../data/control-plane";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { requirePublicOrigin } from "@purin-labs/kernel/public-origin";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError } from "../http";

/**
 * The checks of a socket that an Actor serves: a GET upgrade by a member with
 * `role`. A browser WebSocket cannot set the CSRF header, so the socket must
 * come from the exact configured Portal origin.
 */
export async function authorizeOrganisationSocket(
  request: Request,
  env: Env,
  organisationId: OrganisationId,
  role: ControlRole,
): Promise<
  AuthorizedOrganisationRequest | Readonly<{ ok: false; response: Response }>
> {
  if (request.method !== "GET")
    return { ok: false, response: controlError("method_not_allowed", 405) };
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return { ok: false, response: controlError("websocket_required", 426) };
  if (
    request.headers.get("Origin") !==
    requirePublicOrigin(env.PANTRY_PUBLIC_ORIGIN)
  )
    return { ok: false, response: controlError("origin_invalid", 403) };
  return authorizeOrganisationRequest(
    request,
    env,
    organisationId,
    role,
    false,
  );
}
