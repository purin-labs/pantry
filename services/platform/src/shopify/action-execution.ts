import {
  OrganisationExecutionScope,
  type OrganisationExecutionScopeError,
} from "../organisation-execution-scope";
import type { CanonicalAction } from "@purin-labs/contracts";

import type { Env } from "@purin-labs/kernel/env";
import {
  resolveActiveProviderAccountContext,
  type ProviderAccountContextError,
} from "../data/integration-account";
import {
  buildGeneratedActionDraft,
  buildGeneratedShopifyRequest,
  type GeneratedActionDraft,
  type GeneratedShopifyActionCall,
  type ShopifyOrderCancelReason,
} from "../generated/action-registry";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  acquireShopifyAdminAccess,
  isShopifyAdminDomain,
  parseShopifyClientCredentials,
  type ShopifyAuthError,
} from "./auth";
import {
  authorizeProviderActionResolution,
  resolveActiveProviderConnectionCredential,
  resolveProviderActionCredential,
  type AuthorizedProviderAction,
  type ProviderActionResolutionError,
  type VaultResolveError,
  type VaultSecret,
} from "../credential-vault";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isRecord, isString } from "@purin-labs/std";

export type ShopifyExecutionReceipt =
  | {
      kind: "confirmed";
      actionKind: "shopify_order_cancel";
      provider: "shopify";
      statusCode: number;
      orderId: string;
      jobId: string;
      jobDone: boolean;
    }
  | {
      kind: "failed";
      provider: "shopify";
      statusCode: number;
      errors: readonly ShopifyExecutionFailure[];
    }
  | {
      kind: "indeterminate";
      provider: "shopify";
      reason: "transport_failure" | "response_invalid";
    };

type ShopifyExecutionFailure = {
  field: string | null;
  code: string | null;
  message: string;
};

type ShopifyExecutionError =
  | OrganisationExecutionScopeError
  | VaultResolveError
  | ProviderActionResolutionError
  | ShopifyAuthError
  | ProviderAccountContextError
  | { code: "shopify_write_credential_invalid" }
  | { code: "shopify_integration_account_invalid" }
  | { code: "shopify_shop_mismatch" }
  | { code: "shopify_action_mismatch" };

export type ShopifyWriteCredential = {
  accessToken: string;
  shopDomain: string;
};

type ShopifyOrderCancellationReconciliation =
  | {
      kind: "cancelled";
      provider: "shopify";
      orderId: string;
      cancelledAt: string;
      cancelReason: ShopifyOrderCancelReason;
    }
  | {
      kind: "not_cancelled";
      provider: "shopify";
      orderId: string;
    }
  | {
      kind: "indeterminate";
      provider: "shopify";
      reason: "transport_failure";
    };

type ShopifyOrderCancellationReconciliationError =
  | { code: "shopify_order_id_invalid" }
  | { code: "shopify_write_credential_invalid" }
  | { code: "shopify_reconciliation_response_invalid" };

const SHOPIFY_ORDER_CANCELLATION_RECONCILIATION_QUERY = `
  query PantryOrderCancellationReconciliation($orderId: ID!) {
    order(id: $orderId) {
      id
      cancelledAt
      cancelReason
    }
  }
`;

export async function reconcileShopifyOrderCancellation(input: {
  readonly credential: ShopifyWriteCredential;
  readonly orderId: string;
  readonly fetcher: typeof fetch;
}): Promise<
  Result<
    ShopifyOrderCancellationReconciliation,
    ShopifyOrderCancellationReconciliationError
  >
> {
  if (!isShopifyOrderId(input.orderId)) {
    return { ok: false, error: { code: "shopify_order_id_invalid" } };
  }

  if (
    !isShopifyAdminDomain(input.credential.shopDomain) ||
    input.credential.accessToken.length < 10
  ) {
    return { ok: false, error: { code: "shopify_write_credential_invalid" } };
  }

  let response: Response;

  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://${input.credential.shopDomain}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": input.credential.accessToken,
        },
        body: JSON.stringify({
          query: SHOPIFY_ORDER_CANCELLATION_RECONCILIATION_QUERY,
          variables: { orderId: input.orderId },
        }),
      },
    );
  } catch {
    return {
      ok: true,
      value: {
        kind: "indeterminate",
        provider: "shopify",
        reason: "transport_failure",
      },
    };
  }

  const body = await readProviderJson(response);

  if (body === null) {
    return {
      ok: false,
      error: { code: "shopify_reconciliation_response_invalid" },
    };
  }

  return parseShopifyOrderCancellationReconciliation(
    input.orderId,
    response.ok,
    body,
  );
}

export async function resolveShopifyWriteCredential(input: {
  env: Env;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  fetcher: typeof fetch;
  now: number;
}): Promise<Result<ShopifyWriteCredential, ShopifyExecutionError>> {
  const execution = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!execution.ok) return execution;
  const context = await resolveActiveProviderAccountContext({
    db: execution.value.database,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!context.ok) {
    return context;
  }
  if (context.value.account.provider !== "shopify") {
    return {
      ok: false,
      error: { code: "shopify_integration_account_invalid" },
    };
  }
  const shopDomain = context.value.account.providerAccountId;
  if (!isShopifyDomain(shopDomain)) {
    return { ok: false, error: { code: "shopify_write_credential_invalid" } };
  }

  const secret = await resolveActiveProviderConnectionCredential({
    db: execution.value.database,
    keys: input.env,
    context: context.value,
    expectedProvider: "shopify",
  });

  if (!secret.ok) {
    return secret.error.code === "provider_connection_scope_inactive"
      ? { ok: false, error: { code: "provider_connection_inactive" } }
      : { ok: false, error: secret.error };
  }

  return materializeShopifyWriteCredential({
    secret: secret.value,
    shopDomain,
    fetcher: input.fetcher,
    now: input.now,
  });
}

export async function resolveShopifyWriteCredentialForAction(input: {
  readonly env: Env;
  readonly action: AuthorizedProviderAction;
  readonly fetcher: typeof fetch;
  readonly now: number;
}): Promise<Result<ShopifyWriteCredential, ShopifyExecutionError>> {
  const execution = await OrganisationExecutionScope.resolve(
    input.env,
    input.action.action.organisationId,
  );
  if (!execution.ok) return execution;
  const authorization = await authorizeProviderActionResolution({
    db: execution.value.database,
    action: input.action,
    expectedProvider: "shopify",
  });

  if (!authorization.ok) {
    return authorization;
  }

  const shopDomain = authorization.value.providerAccountId;
  if (!isShopifyDomain(shopDomain)) {
    return { ok: false, error: { code: "shopify_write_credential_invalid" } };
  }

  const secret = await resolveProviderActionCredential({
    db: execution.value.database,
    keys: input.env,
    authorization: authorization.value,
  });

  if (!secret.ok) {
    return secret;
  }

  return materializeShopifyWriteCredential({
    secret: secret.value,
    shopDomain,
    fetcher: input.fetcher,
    now: input.now,
  });
}

export async function materializeShopifyWriteCredential(input: {
  readonly secret: VaultSecret;
  readonly shopDomain: string;
  readonly fetcher: typeof fetch;
  readonly now: number;
}): Promise<Result<ShopifyWriteCredential, ShopifyExecutionError>> {
  switch (input.secret.kind) {
    case "bearer":
      return input.secret.value.length >= 10
        ? {
            ok: true,
            value: {
              accessToken: input.secret.value,
              shopDomain: input.shopDomain,
            },
          }
        : { ok: false, error: { code: "shopify_write_credential_invalid" } };
    case "oauth_tokens":
      return { ok: false, error: { code: "shopify_write_credential_invalid" } };
    case "oauth_client_credentials": {
      const credentials = parseShopifyClientCredentials(input.secret);
      if (!credentials.ok) {
        return credentials;
      }
      const access = await acquireShopifyAdminAccess({
        shopDomain: input.shopDomain,
        credentials: credentials.value,
        fetcher: input.fetcher,
        now: input.now,
      });
      return access.ok
        ? {
            ok: true,
            value: {
              accessToken: access.value.accessToken,
              shopDomain: input.shopDomain,
            },
          }
        : access;
    }
    case "header":
    case "expiring_bearer":
    case "opaque_profile":
    case "website_login":
      return { ok: false, error: { code: "shopify_write_credential_invalid" } };
    default:
      return assertNever(input.secret);
  }
}

export async function executeShopifyAction(input: {
  action: CanonicalAction;
  call: GeneratedShopifyActionCall;
  credential: ShopifyWriteCredential;
  fetcher: typeof fetch;
}): Promise<Result<ShopifyExecutionReceipt, ShopifyExecutionError>> {
  const draft = await buildGeneratedActionDraft(input.call);

  if (!matchesCanonicalAction(draft, input.action)) {
    return { ok: false, error: { code: "shopify_action_mismatch" } };
  }

  if (
    !isShopifyAdminDomain(input.credential.shopDomain) ||
    input.credential.accessToken.length < 10
  ) {
    return { ok: false, error: { code: "shopify_write_credential_invalid" } };
  }

  const providerRequest = buildGeneratedShopifyRequest(input.call);

  if (providerRequest.host !== input.credential.shopDomain) {
    return { ok: false, error: { code: "shopify_shop_mismatch" } };
  }
  let response: Response;

  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://${providerRequest.host}${providerRequest.path}`,
      {
        method: providerRequest.method,
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": input.credential.accessToken,
        },
        body: JSON.stringify(providerRequest.body),
      },
    );
  } catch {
    return {
      ok: true,
      value: {
        kind: "indeterminate",
        provider: "shopify",
        reason: "transport_failure",
      },
    };
  }

  const body = await readProviderJson(response);

  if (body === null) {
    return {
      ok: true,
      value: indeterminateShopifyExecution("response_invalid"),
    };
  }

  return {
    ok: true,
    value: parseShopifyResponse(input.call, response.status, response.ok, body),
  };
}

function parseShopifyOrderCancellationReconciliation(
  expectedOrderId: string,
  responseOk: boolean,
  raw: Record<string, unknown>,
): Result<
  ShopifyOrderCancellationReconciliation,
  ShopifyOrderCancellationReconciliationError
> {
  if (
    !responseOk ||
    (raw.errors !== undefined &&
      (!Array.isArray(raw.errors) || raw.errors.length > 0)) ||
    !isRecord(raw.data) ||
    !isRecord(raw.data.order)
  ) {
    return {
      ok: false,
      error: { code: "shopify_reconciliation_response_invalid" },
    };
  }

  const order = raw.data.order;
  const cancelledAt = order.cancelledAt;
  const cancelReason = order.cancelReason;

  if (
    order.id !== expectedOrderId ||
    (!isShopifyCancellationTimestamp(cancelledAt) && cancelledAt !== null) ||
    (!isShopifyOrderCancelReason(cancelReason) && cancelReason !== null)
  ) {
    return {
      ok: false,
      error: { code: "shopify_reconciliation_response_invalid" },
    };
  }

  if (cancelledAt === null && cancelReason === null) {
    return {
      ok: true,
      value: {
        kind: "not_cancelled",
        provider: "shopify",
        orderId: expectedOrderId,
      },
    };
  }

  if (cancelledAt !== null && cancelReason !== null) {
    return {
      ok: true,
      value: {
        kind: "cancelled",
        provider: "shopify",
        orderId: expectedOrderId,
        cancelledAt,
        cancelReason,
      },
    };
  }

  return {
    ok: false,
    error: { code: "shopify_reconciliation_response_invalid" },
  };
}

function matchesCanonicalAction(
  draft: GeneratedActionDraft,
  action: CanonicalAction,
): boolean {
  return (
    action.host === draft.host &&
    action.verb === draft.verb &&
    action.path === draft.path &&
    action.argsHash === draft.argsHash &&
    action.resourceKey === draft.resourceKey &&
    JSON.stringify(action.amount) === JSON.stringify(draft.amount)
  );
}

async function readProviderJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseShopifyResponse(
  call: GeneratedShopifyActionCall,
  statusCode: number,
  responseOk: boolean,
  raw: Record<string, unknown>,
): ShopifyExecutionReceipt {
  const topLevelErrors = parseGraphqlErrors(raw.errors);

  if (!responseOk || topLevelErrors.length > 0) {
    return topLevelErrors.length > 0
      ? {
          kind: "failed",
          provider: "shopify",
          statusCode,
          errors: topLevelErrors,
        }
      : indeterminateShopifyExecution("response_invalid");
  }

  if (!isRecord(raw.data) || !isRecord(raw.data.orderCancel)) {
    return indeterminateShopifyExecution("response_invalid");
  }

  const payload = raw.data.orderCancel;
  const userErrors = parseOrderCancelUserErrors(payload.orderCancelUserErrors);

  if (userErrors === null) {
    return indeterminateShopifyExecution("response_invalid");
  }

  if (userErrors.length > 0) {
    return {
      kind: "failed",
      provider: "shopify",
      statusCode,
      errors: userErrors,
    };
  }

  if (
    !isRecord(payload.job) ||
    typeof payload.job.id !== "string" ||
    typeof payload.job.done !== "boolean"
  ) {
    return indeterminateShopifyExecution("response_invalid");
  }

  return {
    kind: "confirmed",
    actionKind: "shopify_order_cancel",
    provider: "shopify",
    statusCode,
    orderId: call.args.orderId,
    jobId: payload.job.id,
    jobDone: payload.job.done,
  };
}

function indeterminateShopifyExecution(
  reason: Variant<ShopifyExecutionReceipt, "indeterminate">["reason"],
): Variant<ShopifyExecutionReceipt, "indeterminate"> {
  return { kind: "indeterminate", provider: "shopify", reason };
}

function parseGraphqlErrors(raw: unknown): readonly ShopifyExecutionFailure[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const errors: ShopifyExecutionFailure[] = [];

  for (const item of raw.slice(0, 10)) {
    if (isRecord(item) && typeof item.message === "string") {
      errors.push({
        field: null,
        code: null,
        message: item.message.slice(0, 500),
      });
    }
  }

  return errors;
}

function parseOrderCancelUserErrors(
  raw: unknown,
): readonly ShopifyExecutionFailure[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const errors: ShopifyExecutionFailure[] = [];

  for (const item of raw.slice(0, 10)) {
    if (!isRecord(item) || typeof item.message !== "string") {
      return null;
    }

    errors.push({
      field:
        Array.isArray(item.field) && item.field.every(isString)
          ? item.field.join(".").slice(0, 255)
          : null,
      code: typeof item.code === "string" ? item.code.slice(0, 100) : null,
      message: item.message.slice(0, 500),
    });
  }

  return errors;
}

function isShopifyDomain(raw: unknown): raw is string {
  return typeof raw === "string" && isShopifyAdminDomain(raw);
}

function isShopifyOrderId(raw: unknown): raw is string {
  const prefix = "gid://shopify/Order/";
  return (
    typeof raw === "string" &&
    raw.length <= 255 &&
    raw.startsWith(prefix) &&
    /^[0-9]+$/u.test(raw.slice(prefix.length))
  );
}

function isShopifyOrderCancelReason(
  raw: unknown,
): raw is ShopifyOrderCancelReason {
  return (
    raw === "CUSTOMER" ||
    raw === "DECLINED" ||
    raw === "FRAUD" ||
    raw === "INVENTORY" ||
    raw === "OTHER" ||
    raw === "STAFF"
  );
}

function isShopifyCancellationTimestamp(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= 64 &&
    !Number.isNaN(Date.parse(raw))
  );
}
