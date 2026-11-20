import type { ControlRole, User } from "../../data/control-plane";
import type {
  UnversionedControlMutationBoundary,
  ControlMutationReceiptScope,
} from "../../data/control-mutation";
import type { Env } from "../../env";
import { createCommerceOutboxReconcileQueueMessage } from "../../commerce/queue-messages";
import { newRequestId, type IntegrationAccountId } from "../../ids";
import { traceWarn } from "../../observability";
import { admitUserMutation } from "../admission/control-mutation";
import { resolveMerchantControlContext } from "../commerce-merchant";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError, controlJson } from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import type { CommerceAdminClient } from "@purin-labs/commerce-client";

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
    identity: User;
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
  const merchant = await resolveMerchantControlContext(env, authorized);
  if (merchant instanceof Response) return { ok: false, response: merchant };
  return {
    ok: true,
    value: { authorized, binding: merchant, client: merchant.client },
  };
}

export async function resolveInventoryMutation(
  request: Request,
  env: Env,
  access: InventoryControlAccess,
  body: Readonly<Record<string, unknown>>,
  operation: string,
): Promise<MutationResult> {
  const admitted = await admitUserMutation({
    request,
    env,
    authorized: access.authorized,
    body,
    boundary: "unversioned",
    user: "before_replay",
    route: new URL(request.url).pathname,
    operation,
    replay: async (receipt) => {
      await refreshInventoryProjection(env, access);
      return controlJson(receipt.responseBody, receipt.responseStatus);
    },
  });
  if (admitted instanceof Response) return { ok: false, response: admitted };
  return {
    ok: true,
    value: {
      authorized: access.authorized,
      binding: access.binding,
      client: access.client,
      identity: admitted.user,
      scope: admitted.scope,
      boundary: admitted.boundary,
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
