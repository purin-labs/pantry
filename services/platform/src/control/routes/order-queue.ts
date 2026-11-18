import { isOrderQueueAction } from "@seams/control-api";

import { requireActiveOrganisationActor } from "../../actors/actor-router";
import { resolveUser } from "../../data/control-plane";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../data/control-mutation";
import {
  advanceOrderQueueEntry,
  presentOrderQueueEntry,
  type OrderQueueContext,
} from "../../commerce/order-queue-commands";
import { resolveOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import type { Env } from "../../env";
import { createCommerceClient } from "../../commerce/outbox-worker";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { readOrganisationEnvironment } from "../organisation-runtime";

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
  route: Extract<OrderQueueControlRoute, { kind: "orderQueueAdvance" }>,
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
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/order-queue/${route.fulfillmentIdRaw}/advance`,
    operation: `order_queue.${action}`,
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
  const moved = await advanceOrderQueueEntry(
    context,
    route.fulfillmentIdRaw,
    action,
    boundary.value.idempotencyKey,
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
    boundary: boundary.value,
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

export async function resolveOrderQueueContext(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<OrderQueueContext | Response> {
  const environment = await readOrganisationEnvironment(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  if (environment === null) return controlError("organisation_not_found", 404);
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  if (!binding.ok) return controlError("underclerk_binding_missing", 503);
  const client = createCommerceClient(env, undefined, {
    kind: "organisation",
    organisationId: String(authorized.organisationId),
    actor: String(authorized.membership.personId),
  });
  if (client === null) return controlError("underclerk_unavailable", 503);
  return { client, merchantId: binding.value.merchantId };
}

function ignoreFailure(): null {
  return null;
}
