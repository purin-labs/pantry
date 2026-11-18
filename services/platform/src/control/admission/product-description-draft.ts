import { parseOrganisationId, type OrganisationId } from "../../ids";
import type { Env } from "../../env";
import { requirePublicOrigin } from "../../public-origin";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError } from "../http";

export type ProductDescriptionDraftRoute = Readonly<{ kind: "productDescriptionDraft"; organisationId: OrganisationId; productId: string; transport: "socket" | "snapshot" | "shared-thread" }>;

export function matchProductDescriptionDraftRoute(pathname: string): ProductDescriptionDraftRoute | null {
  const match = /^\/v1\/control\/organisations\/([^/]+)\/commerce\/products\/([^/]+)\/description-draft(?:\/(socket|shared-thread))?$/u.exec(pathname);
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(decodeURIComponent(match[1] ?? ""));
    const productId = decodeURIComponent(match[2] ?? "");
    return organisationId.ok && /^[A-Za-z0-9_:-]{1,256}$/u.test(productId)
      ? { kind: "productDescriptionDraft", organisationId: organisationId.value, productId,
          transport: match[3] === "shared-thread" ? "shared-thread" : match[3] === "socket" ? "socket" : "snapshot" } : null;
  } catch { return null; }
}

export async function authorizeProductDescriptionDraftRequest(request: Request, env: Env, route: ProductDescriptionDraftRoute): Promise<AuthorizedOrganisationRequest | { readonly ok: false; readonly response: Response }> {
  if (route.transport === "shared-thread") {
    if (!["GET", "PUT", "DELETE"].includes(request.method)) return { ok: false, response: controlError("method_not_allowed", 405) };
    return authorizeOrganisationRequest(request, env, route.organisationId, "admin", request.method !== "GET");
  }
  if (request.method !== "GET") return { ok: false, response: controlError("method_not_allowed", 405) };
  if (route.transport === "snapshot") return authorizeOrganisationRequest(request, env, route.organisationId, "viewer", false);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return { ok: false, response: controlError("websocket_required", 426) };
  // Browser WebSockets cannot set the CSRF header. Require the exact configured origin.
  if (request.headers.get("Origin") !== requirePublicOrigin(env.SATYR_PUBLIC_ORIGIN)) return { ok: false, response: controlError("origin_invalid", 403) };
  return authorizeOrganisationRequest(request, env, route.organisationId, "viewer", false);
}
