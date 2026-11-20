import { isOrderQueueAction } from "@purin-labs/control-api";

import { requireActiveOrganisationActor } from "../../actors/actor-router";
import {
  advanceOrderQueueEntry,
  presentOrderQueueEntry,
} from "../../commerce/order-queue-commands";
import type { Env } from "../../env";
import { admitUserMutation } from "../admission/control-mutation";
import {
  authorizeMerchantRead,
  resolveMerchantControlContext,
} from "../commerce-merchant";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import type { Variant } from "@purin-labs/type-utils";

/** The staff order queue on the page (Plan 40B phase 3). */
export type OrderQueueControlRoute =
  | Readonly<{ kind: "orderQueue"; organisationIdRaw: string }>
  | Readonly<{
      kind: "orderQueueAdvance";
      organisationIdRaw: string;
      fulfillmentIdRaw: string;
    }>;

export function matchOrderQueueControlRoute(
  pathname: string,
): OrderQueueControlRoute | null {
  const queue =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/order-queue$/u.exec(
      pathname,
    );
  if (queue !== null)
    return { kind: "orderQueue", organisationIdRaw: queue[1] ?? "" };
  const advance =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/order-queue\/([^/]+)\/advance$/u.exec(
      pathname,
    );
  return advance === null
    ? null
    : {
        kind: "orderQueueAdvance",
        organisationIdRaw: advance[1] ?? "",
        fulfillmentIdRaw: decodeURIComponent(advance[2] ?? ""),
      };
}

export function handleOrderQueueControlRoute(
  request: Request,
  env: Env,
  route: OrderQueueControlRoute,
): Promise<Response> {
  return route.kind === "orderQueue"
    ? readOrderQueue(request, env, route.organisationIdRaw)
    : advanceOrder(request, env, route);
}

async function readOrderQueue(
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
  const queue = await context.client.readPickupQueue(context.merchantId);
  if (!queue.ok) return controlError("underclerk_unavailable", 503);
  return controlJson({
    ok: true,
    entries: queue.value.entries.map(presentOrderQueueEntry),
  });
}

async function advanceOrder(
  request: Request,
  env: Env,
  route: Variant<OrderQueueControlRoute, "orderQueueAdvance">,
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
  if (!body.ok || !isOrderQueueAction(body.value.action))
    return controlError("order_queue_request_invalid", 422);
  const action = body.value.action;
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/order-queue/${route.fulfillmentIdRaw}/advance`,
    operation: `order_queue.${action}`,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const moved = await advanceOrderQueueEntry(
    context,
    route.fulfillmentIdRaw,
    action,
    boundary.idempotencyKey,
  );
  if (!moved.ok) {
    switch (moved.code) {
      case "underclerk_unavailable":
        return controlError(moved.code, 503);
      case "order_queue_refused":
        return controlJson(
          {
            ok: false,
            error: moved.code,
            step: moved.step,
            detail: moved.detail,
            field: moved.field,
          },
          409,
        );
      default:
        return controlError(moved.code, 409);
    }
  }
  const responseBody = { ok: true, action };
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
  // The pickup board shows the move now; Commerce's event follows.
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  }).catch(ignoreFailure);
  await organisation
    ?.signalMenuScreens({ organisationId: authorized.organisationId })
    .catch(ignoreFailure);
  return controlJson(responseBody);
}

function ignoreFailure(): null {
  return null;
}
