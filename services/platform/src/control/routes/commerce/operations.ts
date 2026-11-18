import { OrganisationExecutionScope } from "../../../organisation-execution-scope";
import type { Env } from "../../../env";
import { admitCommerceCapability } from "../../../data/commerce-capability-activation";
import { resolveUser } from "../../../data/control-plane";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import { resolveOrganisationCommerceMerchantBinding } from "../../../data/commerce-merchant-binding";
import {
  executeCafeOperation,
  parseCafeOperationAction,
  readCafeOperations,
  type CafeOperationError,
} from "../../../commerce/cafe-operations";
import {
  executeShippingOperation,
  readShippingOperations,
  type ShippingOperationError,
  type ShippingOperationRequest,
} from "../../../commerce/shipping-operations";
import { createCommerceOutboxReconcileQueueMessage } from "../../../ingress-queue";
import {
  newRequestId,
  type IntegrationAccountId,
} from "../../../ids";
import { commerceProviderResourceId } from "../../../commerce/provider";
import { createCommerceClient } from "../../../commerce/outbox-worker";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "../../http";
import { recordCommerceMutationReceipt } from "../../mutation-receipt";
import { readOrganisationEnvironment } from "../../organisation-runtime";
import { assertNever } from "@seams/std";

export async function handleCafeOperations(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method === "GET")
    return readCafeOperationsResponse(request, env, organisationIdRaw);
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "operator",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 1) {
    return controlError("cafe_operation_invalid", 422);
  }
  const action = parseCafeOperationAction(body.value.action);
  if (action === null) return controlError("cafe_operation_invalid", 422);
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/cafe-operations`,
    operation: `cafe.operation.${action}`,
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
  const admitted = await admitCommerceCapability({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    capability: "food_service",
    scope: { kind: "organisation" },
  });
  if (!admitted.ok) return controlError("commerce_capability_inactive", 409);
  const context = await resolveCafeOperationsContext(env, authorized.executionScope);
  if (!context.ok) return context.response;
  const executed = await executeCafeOperation({
    client: context.client,
    merchantId: context.merchantId,
    action,
    idempotencyKey: boundary.value.idempotencyKey,
  });
  if (!executed.ok) return cafeOperationErrorResponse(executed.error);
  const now = Date.now();
  const responseBody = {
    ok: true,
    cafeOperations: executed.value.view,
    receipt: executed.value.receipt,
  };
  try {
    await env.EVENT_Q.send(
      createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: now,
        organisationId: authorized.organisationId,
        integrationAccountId: context.integrationAccountId,
      }),
      { contentType: "json" },
    );
  } catch {
    return controlError("underclerk_projection_refresh_unavailable", 503);
  }
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function readCafeOperationsResponse(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const context = await resolveCafeOperationsContext(env, authorized.executionScope);
  if (!context.ok) return context.response;
  const loaded = await readCafeOperations(context.client, context.merchantId);
  return loaded.ok
    ? controlJson({ ok: true, cafeOperations: loaded.value })
    : cafeOperationErrorResponse(loaded.error);
}

async function resolveCafeOperationsContext(
  env: Env,
  execution: OrganisationExecutionScope,
): Promise<
  | Readonly<{
      ok: true;
      client: NonNullable<ReturnType<typeof createCommerceClient>>;
      merchantId: string;
      integrationAccountId: IntegrationAccountId;
    }>
  | Readonly<{ ok: false; response: Response }>
> {
  const organisationId = execution.organisationId;
  const environment = await readOrganisationEnvironment(execution.database, organisationId);
  if (environment === null)
    return { ok: false, response: controlError("organisation_not_found", 404) };
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: execution.database,
    organisationId,
    environment,
  });
  if (!binding.ok)
    return {
      ok: false,
      response: controlError("underclerk_binding_not_found", 409),
    };
  const client = createCommerceClient(env, undefined, {
    kind: "organisation",
    organisationId: String(organisationId),
  });
  if (client === null)
    return { ok: false, response: controlError("underclerk_unavailable", 503) };
  return {
    ok: true,
    client,
    merchantId: binding.value.merchantId,
    integrationAccountId: binding.value.integrationAccountId,
  };
}

function cafeOperationErrorResponse(error: CafeOperationError): Response {
  switch (error.code) {
    case "underclerk_unavailable":
      return controlError("underclerk_unavailable", 503);
    case "cafe_scenario_incomplete":
      return controlJson(
        { ok: false, error: error.code, field: error.field },
        409,
      );
    case "cafe_operation_unavailable":
      return controlJson(
        { ok: false, error: error.code, action: error.action },
        409,
      );
    case "cafe_operation_rejected":
      return controlJson(
        { ok: false, error: error.code, result: error.result },
        409,
      );
    default:
      return assertNever(error);
  }
}

export async function handleShippingOperations(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  shipmentIdRaw: string,
): Promise<Response> {
  const shipmentId = parseShippingOperationShipmentId(shipmentIdRaw);
  if (shipmentId === null)
    return controlError("shipping_operation_invalid", 422);
  if (request.method === "GET") {
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const context = await resolveCafeOperationsContext(
      env,
      authorized.executionScope,
    );
    if (!context.ok) return context.response;
    const providerShipmentId = commerceProviderResourceId(
      context.merchantId,
      shipmentId,
    );
    if (providerShipmentId === null) {
      return controlJson(
        { ok: false, error: "shipment_not_found", shipmentId },
        404,
      );
    }
    const loaded = await readShippingOperations(
      context.client,
      context.merchantId,
      providerShipmentId,
    );
    return loaded.ok
      ? controlJson({ ok: true, shippingOperations: loaded.value })
      : shippingOperationErrorResponse(loaded.error);
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "operator",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("shipping_operation_invalid", 422);
  const operation = parseShippingOperationRequest(body.value);
  if (operation === null)
    return controlError("shipping_operation_invalid", 422);
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/shipping-operations/${shipmentId}`,
    operation: `shipping.operation.${operation.action}`,
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
  const context = await resolveCafeOperationsContext(env, authorized.executionScope);
  if (!context.ok) return context.response;
  const providerShipmentId = commerceProviderResourceId(
    context.merchantId,
    shipmentId,
  );
  if (providerShipmentId === null) {
    return controlJson(
      { ok: false, error: "shipment_not_found", shipmentId },
      404,
    );
  }
  const now = Date.now();
  const executed = await executeShippingOperation({
    client: context.client,
    merchantId: context.merchantId,
    shipmentId: providerShipmentId,
    request: operation,
    idempotencyKey: boundary.value.idempotencyKey,
    requestedAt: new Date(now).toISOString(),
  });
  if (!executed.ok) return shippingOperationErrorResponse(executed.error);
  const responseBody = { ok: true, shippingOperations: executed.value };
  try {
    await env.EVENT_Q.send(
      createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: now,
        organisationId: authorized.organisationId,
        integrationAccountId: context.integrationAccountId,
      }),
      { contentType: "json" },
    );
  } catch {
    return controlError("underclerk_projection_refresh_unavailable", 503);
  }
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

function parseShippingOperationShipmentId(value: string): string | null {
  return value.length > 0 &&
    value === value.trim() &&
    /^[A-Za-z0-9_:-]+$/u.test(value)
    ? value
    : null;
}

function parseShippingOperationRequest(
  body: Readonly<Record<string, unknown>>,
): ShippingOperationRequest | null {
  if (body.action === "quote_label_rate" && Object.keys(body).length === 1) {
    return { action: "quote_label_rate" };
  }
  if (
    body.action !== "purchase_label" ||
    Object.keys(body).length !== 3 ||
    typeof body.labelRateId !== "string" ||
    body.labelRateId.length === 0 ||
    body.labelRateId !== body.labelRateId.trim() ||
    !Number.isSafeInteger(body.shipmentRevision) ||
    Number(body.shipmentRevision) < 1
  ) {
    return null;
  }
  return {
    action: "purchase_label",
    labelRateId: body.labelRateId,
    shipmentRevision: Number(body.shipmentRevision),
  };
}

function shippingOperationErrorResponse(
  error: ShippingOperationError,
): Response {
  switch (error.code) {
    case "underclerk_unavailable":
      return controlError("underclerk_unavailable", 503);
    case "shipment_not_found":
      return controlJson(
        { ok: false, error: error.code, shipmentId: error.shipmentId },
        404,
      );
    case "shipping_operation_unavailable":
      return controlJson(
        { ok: false, error: error.code, action: error.action },
        409,
      );
    case "shipping_operation_rejected":
      return controlJson(
        { ok: false, error: error.code, result: error.result },
        409,
      );
    default:
      return assertNever(error);
  }
}
