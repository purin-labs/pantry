import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import type { Variant } from "@seams/type-utils";
import type { ApiAccess, CredentialCommandResult } from "../../api-access.ts";
import { isRecord } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import { hasMerchantId, readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";

export async function credentialRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    CommerceRoute,
    | "issue_api_key"
    | "list_api_credentials"
    | "revoke_api_key"
    | "install_app"
    | "read_app_installation"
    | "uninstall_app"
  >,
): Promise<Response> {
  const access = ctx.access;
  if (access === undefined)
    return jsonResponse(409, {
      message: "API credentials are not available",
    });
  let body: unknown;
  if (route.kind === "issue_api_key" || route.kind === "install_app") {
    const read = await readJsonBody(request);
    if (!read.ok) return read.response;
    body = read.value;
  }
  const result = await credentialCommand(ctx, request, route, access, body);
  return result.kind === "ok"
    ? jsonResponse(result.status, result.value)
    : jsonResponse(result.status, { message: result.message });
}

async function credentialCommand(
  ctx: HttpRouteContext,
  request: Request,
  route: Parameters<typeof credentialRoute>[2],
  access: ApiAccess,
  body: unknown,
): Promise<CredentialCommandResult<unknown>> {
  switch (route.kind) {
    case "list_api_credentials":
      return {
        kind: "ok",
        status: 200,
        value: { credentials: access.list(route.merchantId) },
      };
    case "revoke_api_key":
      return access.revokeApiKey(
        route.merchantId,
        route.credentialId,
        revoker(access, request, route.merchantId),
      );
    case "uninstall_app":
      return access.uninstallApp(route.merchantId, route.appId);
    case "read_app_installation":
      return access.readAppInstallation(
        route.merchantId,
        route.appId,
        new URL(request.url).searchParams.get("externalReference"),
      );
    case "issue_api_key":
      return issueApiKey(ctx, request, route.merchantId, body, access);
    case "install_app":
      return access.installApp(route.merchantId, route.appId, body);
  }
}

// Who revokes a key: the operator, or the credential of the caller.
function revoker(
  access: ApiAccess,
  request: Request,
  merchantId: string,
): string {
  const decision = access.identify(request, merchantId);
  return decision.kind === "allowed" && decision.caller.kind !== "operator"
    ? `credential:${decision.caller.credentialId}`
    : "operator";
}

function issueApiKey(
  ctx: HttpRouteContext,
  request: Request,
  merchantId: string,
  body: unknown,
  access: ApiAccess,
): ReturnType<ApiAccess["issueApiKey"]> {
  const decision = access.authorize(request, merchantId, "credentials:write");
  if (decision.kind !== "allowed")
    throw new Error("An admitted request lost its credential");
  return access.issueApiKey(merchantId, body, decision.caller);
}

export async function feedConsumerRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    Exclude<CommerceRoute, BuyerRoute>,
    "read_feed_consumer" | "advance_feed_consumer"
  >,
): Promise<Response> {
  const consumers = ctx.feedConsumers;
  if (consumers === undefined)
    return jsonResponse(409, {
      message: "Feed consumers are not available",
    });
  let result;
  if (route.kind === "read_feed_consumer") {
    result = consumers.read(route.merchantId, route.consumerId);
  } else {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    result = consumers.advance(route.merchantId, route.consumerId, body.value);
  }
  return result.kind === "ok"
    ? jsonResponse(200, result.value)
    : jsonResponse(result.status, { message: result.message });
}

export async function createWebhookSubscriptionRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    Exclude<CommerceRoute, BuyerRoute>,
    "create_webhook_subscription"
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (!hasMerchantId(body.value, route.merchantId))
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  return jsonResponse(200, {
    schemaVersion: "underclerk.webhook-subscription-created.v1",
    ...ctx.authority.createWebhookSubscription(body.value),
  });
}

export async function webhookSubscriptionChangeRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    Exclude<CommerceRoute, BuyerRoute>,
    | "restart_webhook_subscription"
    | "rotate_webhook_secret"
    | "delete_webhook_subscription"
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const schemaVersion =
    route.kind === "restart_webhook_subscription"
      ? "underclerk.restart-webhook-subscription.v1"
      : route.kind === "rotate_webhook_secret"
        ? "underclerk.rotate-webhook-secret.v1"
        : "underclerk.delete-webhook-subscription.v1";
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    body.value.subscriptionId !== route.subscriptionId ||
    body.value.schemaVersion !== schemaVersion
  )
    return jsonResponse(400, {
      message: "The path and the command must name the same change",
    });
  if (route.kind === "rotate_webhook_secret")
    return jsonResponse(200, {
      schemaVersion: "underclerk.webhook-secret-rotated.v1",
      ...ctx.authority.rotateWebhookSecret(body.value),
    });
  return jsonResponse(200, ctx.authority.changeWebhookSubscription(body.value));
}

export async function listWebhookSubscriptionsRoute(
  ctx: HttpRouteContext,
  route: Variant<
    Exclude<CommerceRoute, BuyerRoute>,
    "list_webhook_subscriptions"
  >,
): Promise<Response> {
  return jsonResponse(200, {
    schemaVersion: "underclerk.webhook-subscriptions.v1",
    subscriptions: ctx.authority.listWebhookSubscriptions(route.merchantId),
  });
}
