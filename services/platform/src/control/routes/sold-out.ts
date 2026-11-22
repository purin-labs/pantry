import { requireActiveOrganisationActor } from "../../actors/actor-router";
import {
  readCafeSoldOutMenu,
  setSoldOutMark,
} from "../../cafe/contract/order-queue-commands";
import type { Env } from "@purin-labs/kernel/env";
import { admitUserMutation } from "../admission/control-mutation";
import {
  authorizeMerchantRead,
  resolveMerchantControlContext,
} from "../../commerce/contract/merchant-control";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import type { Variant } from "@purin-labs/type-utils";

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
  const read = await authorizeMerchantRead(
    request,
    env,
    organisationIdRaw,
    "operator",
  );
  if (read instanceof Response) return read;
  const { context } = read;
  const menu = await readCafeSoldOutMenu(context);
  if (menu === null) return controlError("commerce_unavailable", 503);
  return controlJson({ ok: true, items: menu.items });
}

async function markItem(
  request: Request,
  env: Env,
  route: Variant<SoldOutControlRoute, "soldOutItem">,
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
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/sold-out/${route.variantIdRaw}`,
    operation: soldOut ? "sold_out.mark" : "sold_out.clear",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const marked = await setSoldOutMark(
    context,
    route.variantIdRaw,
    soldOut && typeof timeZone === "string"
      ? { kind: "today", timeZone }
      : { kind: "cleared" },
    boundary.idempotencyKey,
  );
  if (!marked.ok) {
    switch (marked.code) {
      case "commerce_unavailable":
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
    boundary,
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
