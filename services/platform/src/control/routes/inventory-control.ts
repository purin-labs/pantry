import {
  resolveUser,
  type ControlRole,
} from "../../data/control-plane";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
  type UnversionedControlMutationBoundary,
  type ControlMutationReceiptScope,
} from "../../data/control-mutation";
import { resolveOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import type { Env } from "../../env";
import { createCommerceOutboxReconcileQueueMessage } from "../../ingress-queue";
import { newRequestId, type IntegrationAccountId } from "../../ids";
import { createCommerceClient } from "../../commerce/outbox-worker";
import { traceWarn } from "../../observability";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError, controlJson } from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { readOrganisationEnvironment } from "../organisation-runtime";
import type { CommerceAdminClient } from "@seams/commerce-client";

export type InventoryControlAccess = Readonly<{
  authorized: AuthorizedOrganisationRequest;
  binding: Readonly<{
    merchantId: string;
    integrationAccountId: IntegrationAccountId;
  }>;
  client: CommerceAdminClient;
}>;
export type InventoryControlMutation = InventoryControlAccess &
  Readonly<{
    identity: NonNullable<Awaited<ReturnType<typeof resolveUser>>>;
    scope: ControlMutationReceiptScope;
    boundary: UnversionedControlMutationBoundary;
  }>;
type AccessResult =
  | Readonly<{ ok: true; value: InventoryControlAccess }>
  | Readonly<{ ok: false; response: Response }>;
type MutationResult =
  | Readonly<{ ok: true; value: InventoryControlMutation }>
  | Readonly<{ ok: false; response: Response }>;

export async function resolveInventoryAccess(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  role: ControlRole,
): Promise<AccessResult> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    role,
    request.method === "POST",
  );
  if (!authorized.ok) return authorized;
  const environment = await readOrganisationEnvironment(authorized.executionScope.database, authorized.organisationId);
  if (environment === null)
    return { ok: false, response: controlError("organisation_not_found", 404) };
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  if (!binding.ok)
    return {
      ok: false,
      response: controlError("underclerk_binding_missing", 503),
    };
  const client = createCommerceClient(env, undefined, {
    kind: "organisation",
    organisationId: String(authorized.organisationId),
    actor: String(authorized.membership.personId),
  });
  if (client === null)
    return { ok: false, response: controlError("underclerk_unavailable", 503) };
  return { ok: true, value: { authorized, binding: binding.value, client } };
}

export async function resolveInventoryMutation(
  request: Request,
  env: Env,
  access: InventoryControlAccess,
  body: Readonly<Record<string, unknown>>,
  operation: string,
): Promise<MutationResult> {
  const boundary = await parseControlMutationBoundary({
    request,
    body,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned")
    return {
      ok: false,
      response: controlError(
        boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
        422,
      ),
    };
  const identity = await resolveUser({
    db: env.DB,
    userId: access.authorized.authenticated.session.userId,
  });
  if (identity === null)
    return {
      ok: false,
      response: controlError("app_user_missing", 401),
    };
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: access.authorized.organisationId,
    route: new URL(request.url).pathname,
    operation,
  };
  const replay = await readControlMutationReplay({
    db: access.authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict")
    return {
      ok: false,
      response: controlError("idempotency_key_conflict", 409),
    };
  if (replay.kind === "replay") {
    await refreshInventoryProjection(env, access);
    return {
      ok: false,
      response: controlJson(
        replay.receipt.responseBody,
        replay.receipt.responseStatus,
      ),
    };
  }
  return {
    ok: true,
    value: {
      authorized: access.authorized,
      binding: access.binding,
      client: access.client,
      identity,
      scope,
      boundary: boundary.value,
    },
  };
}

export async function finishInventoryOperation(
  request: Request,
  env: Env,
  context: InventoryControlMutation,
  responseBody: unknown,
): Promise<Response> {
  const now = Date.now();
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized: context.authorized,
    identity: context.identity,
    scope: context.scope,
    boundary: context.boundary,
    request,
    responseBody,
    now,
  });
  // The native result is already applied: refresh its projection before reporting a receipt conflict.
  await refreshInventoryProjection(env, context);
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function refreshInventoryProjection(
  env: Env,
  context: InventoryControlAccess,
): Promise<void> {
  const message = createCommerceOutboxReconcileQueueMessage({
    requestId: newRequestId(),
    receivedAt: Date.now(),
    organisationId: context.authorized.organisationId,
    integrationAccountId: context.binding.integrationAccountId,
  });
  try {
    await env.EVENT_Q.send(message, { contentType: "json" });
  } catch {
    // Scheduled recovery drains the durable native outbox independently of this request.
    traceWarn("inventory.projection_refresh_pending", {
      requestId: message.requestId,
      organisation_id: context.authorized.organisationId,
      integration_account_id: context.binding.integrationAccountId,
    });
  }
}
