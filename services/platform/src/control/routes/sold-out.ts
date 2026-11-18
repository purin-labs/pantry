import { requireActiveOrganisationActor } from "../../actors/actor-router";
import {
  readCafeSoldOutMenu,
  setSoldOutMark,
} from "../../commerce/order-queue-commands";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../data/control-mutation";
import { resolveUser } from "../../data/control-plane";
import type { Env } from "../../env";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { resolveOrderQueueContext } from "./order-queue";

/**
 * "Sold out today" (Plan 40B phase 3). Staff mark a menu item that has no stock
 * count from the order queue page. Commerce ends the mark at the shop's next
 * midnight and refuses the item at checkout; the shop's screens show it now.
 */
export type SoldOutControlRoute =
  | Readonly<{ kind: "soldOutItems"; organisationIdRaw: string }>
  | Readonly<{
      kind: "soldOutItem";
      organisationIdRaw: string;
      variantIdRaw: string;
    }>;

export function matchSoldOutControlRoute(
  pathname: string,
): SoldOutControlRoute | null {
  const items =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/sold-out$/u.exec(
      pathname,
    );
  if (items !== null)
    return { kind: "soldOutItems", organisationIdRaw: items[1] ?? "" };
  const item =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/sold-out\/([^/]+)$/u.exec(
      pathname,
    );
  return item === null
    ? null
    : {
        kind: "soldOutItem",
        organisationIdRaw: item[1] ?? "",
        variantIdRaw: decodeURIComponent(item[2] ?? ""),
      };
}

export function handleSoldOutControlRoute(
  request: Request,
  env: Env,
  route: SoldOutControlRoute,
): Promise<Response> {
  return route.kind === "soldOutItems"
    ? readSoldOutItems(request, env, route.organisationIdRaw)
    : markItem(request, env, route);
}

async function readSoldOutItems(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "operator",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const context = await resolveOrderQueueContext(env, authorized);
  if (context instanceof Response) return context;
  const menu = await readCafeSoldOutMenu(context);
  if (menu === null) return controlError("underclerk_unavailable", 503);
  return controlJson({ ok: true, items: menu.items });
}

async function markItem(
  request: Request,
  env: Env,
  route: Extract<SoldOutControlRoute, { kind: "soldOutItem" }>,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "operator",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("sold_out_request_invalid", 422);
  const { soldOut, timeZone } = body.value;
  if (typeof soldOut !== "boolean" || (soldOut && typeof timeZone !== "string"))
    return controlError("sold_out_request_invalid", 422);
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned")
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/sold-out/${route.variantIdRaw}`,
    operation: soldOut ? "sold_out.mark" : "sold_out.clear",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict")
    return controlError("idempotency_key_conflict", 409);
  if (replay.kind === "replay")
    return controlJson(
      replay.receipt.responseBody,
      replay.receipt.responseStatus,
    );
  const context = await resolveOrderQueueContext(env, authorized);
  if (context instanceof Response) return context;
  const marked = await setSoldOutMark(
    context,
    route.variantIdRaw,
    soldOut && typeof timeZone === "string"
      ? { kind: "today", timeZone }
      : { kind: "cleared" },
    boundary.value.idempotencyKey,
  );
  if (!marked.ok) {
    switch (marked.code) {
      case "underclerk_unavailable":
        return controlError(marked.code, 503);
      case "sold_out_item_not_on_menu":
        return controlError(marked.code, 404);
      default:
        return controlError(marked.code, 409);
    }
  }
  const responseBody = { ok: true, soldOut };
  const receipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody,
    now: Date.now(),
  });
  if (!receipt.ok) return controlError(receipt.error.code, 409);
  // The shop's screens show the mark now.
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  }).catch(() => undefined);
  await organisation
    ?.signalMenuScreens({ organisationId: authorized.organisationId })
    .catch(() => undefined);
  return controlJson(responseBody);
}
