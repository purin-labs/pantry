import type { CommerceMutationActorV1 } from "@seams/commerce-client";
import type { BuyerRoute, CommerceRoute } from "../http-routes.ts";
import { adminRouteAccess, sameSecret } from "../api-access.ts";
import { CLOSED_MERCHANT_REFUSED_ROUTES } from "../merchant-closure.ts";
import { isRecord } from "@seams/std";
import type { HttpRouteContext } from "./context.ts";
import {
  SERVER_COMMAND_FIELDS,
  bearerToken,
  readJsonBody,
} from "./request-body.ts";
import { actorRefused, jsonResponse } from "./responses.ts";

/** The commands of the food service plugin (src/plugins/food-service/). */
export const FOOD_SERVICE_ROUTES: ReadonlySet<CommerceRoute["kind"]> =
  new Set([
    "create_preparation_station",
    "create_modifier_group_revision",
    "create_recipe_revision",
    "configure_stock_policy",
    "publish_menu",
    "mark_sold_out",
    "manage_preparation_ticket",
    "complete_production_batch",
  ]);

/** The route of each command that a merchant plugin can submit (Plan 77). */
export const PLUGIN_COMMAND_ROUTES: Readonly<
  Record<string, Exclude<CommerceRoute, BuyerRoute>["kind"]>
> = {
  create_discount: "create_discount",
  set_plugin_field_values: "set_plugin_field_values",
};

/**
 * A write body carries only its command's own fields (Plan 80 step 1).
 * The path names the merchant and the other resources, the
 * `Idempotency-Key` header names the attempt, and this merchant's clock
 * gives the time. The handlers then read the whole command.
 */
export async function commandRequest(
  ctx: HttpRouteContext,
  request: Request,
  route: Exclude<CommerceRoute, BuyerRoute>,
  schemaVersion: string,
): Promise<Request | Response> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (
    idempotencyKey === undefined ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 255
  )
    return jsonResponse(400, {
      message: "A write needs an Idempotency-Key header of 1 to 255 characters",
      field: "Idempotency-Key",
    });
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const fields = body.value;
  if (!isRecord(fields))
    return jsonResponse(400, { message: "The body must be a JSON object" });
  const pathFields = Object.fromEntries(
    Object.entries(route).filter(([name]) => name !== "kind"),
  );
  const given = [...SERVER_COMMAND_FIELDS, ...Object.keys(pathFields)].find(
    (name) => name in fields,
  );
  if (given !== undefined)
    return jsonResponse(400, {
      message: `The body must not name ${given}: the path, the Idempotency-Key header or the server gives it`,
      field: given,
    });
  const context = ctx.authority.commandContext();
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify({
      ...fields,
      ...pathFields,
      schemaVersion,
      idempotencyKey,
      requestedAt: context.requestedAt,
    }),
  });
}

// A paused plugin's routes answer 404, as if the feature were not there.
export function pausedPlugin(
  ctx: HttpRouteContext,
  route: CommerceRoute,
): Response | undefined {
  if (!("merchantId" in route)) return undefined;
  const plugin = ctx.authority.inactivePluginOfRoute(
    route.merchantId,
    route.kind,
  );
  return plugin === undefined
    ? undefined
    : jsonResponse(404, {
        message: `The ${plugin.title} plugin is paused`,
        code: "plugin_paused",
      });
}

// Plan 76 phase 2: the operator token opens every admin route; an API key
// or an app installation opens the routes of its scopes on this merchant.
// Plan 80 step 3: the answer is the actor that receipts name; only an app
// may name the person it acts for, in `Commerce-Actor`.
export function admitAdminRequest(
  ctx: HttpRouteContext,
  request: Request,
  route: Exclude<CommerceRoute, BuyerRoute>,
): CommerceMutationActorV1 | Response {
  const person = request.headers.get("underclerk-actor") ?? undefined;
  if (ctx.access === undefined) {
    const token = bearerToken(request);
    if (token === undefined || !sameSecret(token, ctx.serviceToken))
      return jsonResponse(401, { message: "Unauthorized" });
    return person === undefined
      ? { kind: "operator" }
      : actorRefused(
          "Only an app installation may name the person it acts for",
        );
  }
  const decision = ctx.access.authorize(
    request,
    route.merchantId,
    adminRouteAccess(route.kind),
  );
  // A merchant whose Organisation ended takes no new credential,
  // subscription or provider link (Refactor 15, refactor 11).
  if (
    decision.kind === "allowed" &&
    CLOSED_MERCHANT_REFUSED_ROUTES.has(route.kind) &&
    ctx.access.isClosed(route.merchantId)
  )
    return jsonResponse(409, {
      message: "The merchant is closed",
      code: "merchant_closed",
    });
  if (decision.kind === "allowed") {
    const { caller } = decision;
    if (caller.kind === "app_installation" && caller.appId !== null) {
      if (person === undefined) return { kind: "app", appId: caller.appId };
      const trimmed = person.trim();
      return trimmed.length === 0 || trimmed.length > 200
        ? actorRefused("Underclerk-Actor has 1 to 200 characters")
        : { kind: "app", appId: caller.appId, person: trimmed };
    }
    if (person !== undefined)
      return actorRefused(
        "Only an app installation may name the person it acts for",
      );
    return caller.kind === "operator"
      ? { kind: "operator" }
      : { kind: "api_key", credentialId: caller.credentialId };
  }
  return jsonResponse(decision.status, {
    message:
      decision.code === "missing_scope"
        ? "This credential does not allow this route"
        : "Unauthorized",
    code: decision.code,
  });
}

// A merchant plugin submits commands with the authority of whoever
// installs it or runs its action, so they need each command's scope too.
export function refuseCommandScopes(
  ctx: HttpRouteContext,
  request: Request,
  merchantId: string,
  commands: readonly unknown[],
): Response | undefined {
  if (ctx.access === undefined) return undefined;
  for (const command of commands) {
    const route = PLUGIN_COMMAND_ROUTES[String(command)];
    if (route === undefined) continue;
    const decision = ctx.access.authorize(
      request,
      merchantId,
      adminRouteAccess(route),
    );
    if (decision.kind === "refused")
      return jsonResponse(decision.status, {
        message:
          decision.code === "missing_scope"
            ? "This credential does not allow the commands of this plugin"
            : "Unauthorized",
        code: decision.code,
      });
  }
  return undefined;
}
