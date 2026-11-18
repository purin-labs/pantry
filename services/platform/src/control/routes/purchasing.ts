import { pantryCommerceAccess } from "../../commerce/app-access";
import { CommerceEntityPlaneClient } from "@seams/commerce-client";

import {
  parseSupplierCreation,
  registerSupplier,
  type SupplierRegistrationError,
} from "../../commerce/purchasing/supplier-creation";
import { resolveUser } from "../../data/control-plane";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
  type UnversionedControlMutationBoundary,
  type ControlMutationReceiptScope,
} from "../../data/control-mutation";
import { resolveOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import type { Env } from "../../env";
import { createCommerceOutboxReconcileQueueMessage } from "../../ingress-queue";
import {
  newRequestId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../ids";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { readOrganisationEnvironment } from "../organisation-runtime";

export type PurchasingControlAction =
  "activate" | "reconcile" | "create_supplier";

type PurchasingControlContext = Readonly<{
  authorized: AuthorizedOrganisationRequest;
  identity: Readonly<{
    userId: string;
    issuer: string;
    subject: string;
  }>;
  client: CommerceEntityPlaneClient;
  merchantId: string;
  integrationAccountId: IntegrationAccountId;
  boundary: UnversionedControlMutationBoundary;
  scope: ControlMutationReceiptScope;
}>;

type PurchasingContextResult =
  | Readonly<{ ok: true; value: PurchasingControlContext }>
  | Readonly<{ ok: false; response: Response }>;

export async function handlePurchasingControlRoute(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  action: PurchasingControlAction,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("commerce_purchasing_invalid", 422);
  if (action !== "create_supplier" && Object.keys(body.value).length !== 0) {
    return controlError("commerce_purchasing_invalid", 422);
  }
  const role = action === "activate" ? "admin" : "operator";
  const context = await resolvePurchasingControlContext(
    request,
    env,
    organisationIdRaw,
    role,
    action,
    body.value,
  );
  if (!context.ok) return context.response;
  if (action === "activate")
    return activatePurchasing(request, env, context.value);
  if (action === "reconcile")
    return reconcilePurchasing(request, env, context.value);
  return createPurchasingSupplier(request, env, context.value, body.value);
}

async function activatePurchasing(
  request: Request,
  env: Env,
  context: PurchasingControlContext,
): Promise<Response> {
  const published = await context.client.publishPurchasingPreset({
    organisationId: context.authorized.organisationId,
    merchantId: context.merchantId,
  });
  if (!published.ok) return controlError("underclerk_unavailable", 503);
  if (
    published.value.organisationId !== context.authorized.organisationId ||
    published.value.merchantId !== context.merchantId
  ) {
    return controlError("underclerk_scope_mismatch", 502);
  }
  const reconciled = await context.client.reconcilePurchasing({
    organisationId: context.authorized.organisationId,
    merchantId: context.merchantId,
  });
  if (!reconciled.ok) return controlError("underclerk_unavailable", 503);
  if (!purchasingResponseMatchesContext(context, reconciled.value)) {
    return controlError("underclerk_scope_mismatch", 502);
  }
  const queued = await enqueuePurchasingProjectionRefresh(env, context);
  if (!queued)
    return controlError("underclerk_projection_refresh_unavailable", 503);
  const responseBody = {
    ok: true,
    publication: published.value,
    reconciliation: reconciled.value,
  };
  const recordedMutationReceipt = await recordPurchasingReceipt(
    request,
    context,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function reconcilePurchasing(
  request: Request,
  env: Env,
  context: PurchasingControlContext,
): Promise<Response> {
  const reconciled = await context.client.reconcilePurchasing({
    organisationId: context.authorized.organisationId,
    merchantId: context.merchantId,
  });
  if (!reconciled.ok) return controlError("underclerk_unavailable", 503);
  if (!purchasingResponseMatchesContext(context, reconciled.value)) {
    return controlError("underclerk_scope_mismatch", 502);
  }
  const queued = await enqueuePurchasingProjectionRefresh(env, context);
  if (!queued)
    return controlError("underclerk_projection_refresh_unavailable", 503);
  const responseBody = { ok: true, reconciliation: reconciled.value };
  const recordedMutationReceipt = await recordPurchasingReceipt(
    request,
    context,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function createPurchasingSupplier(
  request: Request,
  env: Env,
  context: PurchasingControlContext,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const parsed = parseSupplierCreation(body);
  if (!parsed.ok) return supplierCreationErrorResponse(parsed.error);
  const now = Date.now();
  const registered = await registerSupplier({
    client: context.client,
    db: context.authorized.executionScope.database,
    queue: env.EVENT_Q,
    organisationId: context.authorized.organisationId,
    merchantId: context.merchantId,
    integrationAccountId: context.integrationAccountId,
    principalId: context.identity.userId,
    idempotencyKey: context.boundary.idempotencyKey,
    supplier: parsed.value,
    now,
  });
  if (!registered.ok) return supplierCreationErrorResponse(registered.error);
  const responseBody = {
    ok: true,
    supplier: registered.value.supplier,
    reconciliation: registered.value.reconciliation,
  };
  const recordedMutationReceipt = await recordPurchasingReceipt(
    request,
    context,
    responseBody,
    now,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function resolvePurchasingControlContext(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  role: "admin" | "operator",
  action: PurchasingControlAction,
  body: Readonly<Record<string, unknown>>,
): Promise<PurchasingContextResult> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    role,
    true,
  );
  if (!authorized.ok) return authorized;
  const boundary = await parseControlMutationBoundary({
    request,
    body,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned") {
    return {
      ok: false,
      response: controlError(
        boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
        422,
      ),
    };
  }
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: purchasingRoute(authorized.organisationId, action),
    operation: purchasingOperation(action),
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict")
    return {
      ok: false,
      response: controlError("idempotency_key_conflict", 409),
    };
  if (replay.kind === "replay") {
    return {
      ok: false,
      response: controlJson(
        replay.receipt.responseBody,
        replay.receipt.responseStatus,
      ),
    };
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null)
    return {
      ok: false,
      response: controlError("app_user_missing", 401),
    };
  const environment = await readOrganisationEnvironment(
    authorized.executionScope.database,
    authorized.organisationId,
  );
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
  const client = createPurchasingClient(env, String(authorized.organisationId));
  if (client === null)
    return { ok: false, response: controlError("underclerk_unavailable", 503) };
  return {
    ok: true,
    value: {
      authorized,
      identity,
      client,
      merchantId: binding.value.merchantId,
      integrationAccountId: binding.value.integrationAccountId,
      boundary: boundary.value,
      scope,
    },
  };
}

function createPurchasingClient(
  env: Env,
  organisationId: string,
): CommerceEntityPlaneClient | null {
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  )
    return null;
  try {
    return new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        organisationId,
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
      ),
    });
  } catch {
    return null;
  }
}

function purchasingResponseMatchesContext(
  context: PurchasingControlContext,
  response: Readonly<{ organisationId: string; merchantId: string }>,
): boolean {
  return (
    response.organisationId === context.authorized.organisationId &&
    response.merchantId === context.merchantId
  );
}

async function enqueuePurchasingProjectionRefresh(
  env: Env,
  context: PurchasingControlContext,
): Promise<boolean> {
  try {
    await env.EVENT_Q.send(
      createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: Date.now(),
        organisationId: context.authorized.organisationId,
        integrationAccountId: context.integrationAccountId,
      }),
      { contentType: "json" },
    );
    return true;
  } catch {
    return false;
  }
}

async function recordPurchasingReceipt(
  request: Request,
  context: PurchasingControlContext,
  responseBody: unknown,
  now = Date.now(),
): ReturnType<typeof recordCommerceMutationReceipt> {
  return recordCommerceMutationReceipt({
    authorized: context.authorized,
    identity: context.identity,
    scope: context.scope,
    boundary: context.boundary,
    request,
    responseBody,
    now,
  });
}

function supplierCreationErrorResponse(
  error: SupplierRegistrationError,
): Response {
  switch (error.code) {
    case "invalid":
      return controlJson(
        { ok: false, error: error.code, detail: error.detail },
        422,
      );
    case "purchasing_inactive":
      return controlError(error.code, 409);
    case "command_rejected":
      return controlJson(
        { ok: false, error: error.code, detail: error.detail },
        409,
      );
    case "unavailable":
      return controlError("underclerk_unavailable", 503);
    case "email_operational_contact_sync_failed":
    case "underclerk_projection_refresh_unavailable":
      return controlError(error.code, 503);
    case "underclerk_scope_mismatch":
      return controlError(error.code, 502);
  }
}

function purchasingRoute(
  organisationId: OrganisationId,
  action: PurchasingControlAction,
): string {
  switch (action) {
    case "activate":
      return `/v1/control/organisations/${organisationId}/commerce/purchasing/activate`;
    case "reconcile":
      return `/v1/control/organisations/${organisationId}/commerce/purchasing/reconcile`;
    case "create_supplier":
      return `/v1/control/organisations/${organisationId}/commerce/suppliers`;
  }
}

function purchasingOperation(action: PurchasingControlAction): string {
  switch (action) {
    case "activate":
      return "commerce.purchasing.activate";
    case "reconcile":
      return "commerce.purchasing.reconcile";
    case "create_supplier":
      return "commerce.supplier.create";
  }
}
