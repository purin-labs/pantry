import {
  isCommerceApiScope,
  type CommerceAdminClient,
  type CommerceApiScope,
  type CommerceClientError,
} from "@seams/commerce-client";

import type { Env } from "../../env";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../data/control-mutation";
import { createCommerceClient } from "../../commerce/outbox-worker";
import { readOrganisationEnvironment } from "../organisation-runtime";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { resolveUser } from "../../data/control-plane";
import { resolveOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";

/**
 * The API keys of an organisation's merchant (Plan 80 step 3): an owner or
 * an admin lists them, issues a key for the organisation's own systems, and
 * revokes one. Commerce gives a key only scopes that Pantry holds, and never
 * the scopes that record payments or manage keys. A new key's secret is in
 * the first answer only; a replay of the same request answers without it.
 */
export type CommerceApiKeyControlRoute =
  | Readonly<{ kind: "commerceApiKeys"; organisationIdRaw: string }>
  | Readonly<{
      kind: "commerceApiKeyRevocation";
      organisationIdRaw: string;
      credentialIdRaw: string;
    }>;

export type MerchantControlContext = Readonly<{
  merchantId: string;
  client: CommerceAdminClient;
}>;

export function matchCommerceApiKeyControlRoute(
  pathname: string,
): CommerceApiKeyControlRoute | null {
  const revocation =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/api-keys\/([^/]+)\/revocation$/u.exec(
      pathname,
    );
  if (revocation !== null)
    return {
      kind: "commerceApiKeyRevocation",
      organisationIdRaw: decode(revocation[1]),
      credentialIdRaw: decode(revocation[2]),
    };
  const keys =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/api-keys$/u.exec(
      pathname,
    );
  return keys === null
    ? null
    : { kind: "commerceApiKeys", organisationIdRaw: decode(keys[1]) };
}

export async function handleCommerceApiKeyControlRoute(
  request: Request,
  env: Env,
  route: CommerceApiKeyControlRoute,
): Promise<Response> {
  if (route.kind === "commerceApiKeyRevocation")
    return request.method === "POST"
      ? revokeKey(request, env, route)
      : controlError("method_not_allowed", 405);
  if (request.method === "POST")
    return issueKey(request, env, route.organisationIdRaw);
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const listed = await context.client.listApiCredentials(context.merchantId);
  if (!listed.ok) return commerceErrorResponse(listed.error);
  return controlJson({
    ok: true,
    apiKeys: listed.value.credentials.filter(
      (credential) => credential.kind === "api_key",
    ),
  });
}

async function issueKey(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("api_key_request_invalid", 422);
  const key = parseKey(body.value);
  if (key === null) return controlError("api_key_request_invalid", 422);
  return mutate(
    request,
    env,
    authorized,
    body.value,
    "commerce_api_key.issue",
    async (context) => {
      const issued = await context.client.issueApiKey(context.merchantId, key);
      if (!issued.ok)
        return { response: commerceErrorResponse(issued.error) };
      const { key: secret, ...apiKey } = issued.value;
      // The secret is shown once and never kept in Pantry's receipts.
      return {
        body: { ok: true, apiKey },
        firstBody: { ok: true, apiKey, key: secret },
      };
    },
  );
}

async function revokeKey(
  request: Request,
  env: Env,
  route: Extract<
    CommerceApiKeyControlRoute,
    { kind: "commerceApiKeyRevocation" }
  >,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("api_key_request_invalid", 422);
  return mutate(
    request,
    env,
    authorized,
    body.value,
    "commerce_api_key.revoke",
    async (context) => {
      const revoked = await context.client.revokeApiKey(
        context.merchantId,
        route.credentialIdRaw,
      );
      return revoked.ok
        ? { body: { ok: true, apiKey: revoked.value } }
        : { response: commerceErrorResponse(revoked.error) };
    },
  );
}

/** One key change, replayed by its control mutation boundary. */
async function mutate(
  request: Request,
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  body: Readonly<Record<string, unknown>>,
  operation: string,
  change: (
    context: MerchantControlContext,
  ) => Promise<
    | Readonly<{ body: Readonly<Record<string, unknown>>; firstBody?: unknown }>
    | Readonly<{ response: Response }>
  >,
): Promise<Response> {
  const boundary = await parseControlMutationBoundary({
    request,
    body,
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
    route: new URL(request.url).pathname,
    operation,
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
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const result = await change(context);
  if ("response" in result) return result.response;
  const recorded = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary: boundary.value,
    request,
    responseBody: result.body,
    now: Date.now(),
  });
  if (!recorded.ok) return controlError(recorded.error.code, 409);
  return controlJson(result.firstBody ?? result.body);
}

function parseKey(
  body: Readonly<Record<string, unknown>>,
): Readonly<{ label: string; scopes: readonly CommerceApiScope[] }> | null {
  const { label, scopes } = body;
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every(isCommerceApiScope)
  )
    return null;
  return { label: trimmed, scopes: [...new Set(scopes)] };
}

/** The organisation's merchant, reached as the member who asked. */
export async function resolveMerchantControlContext(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<MerchantControlContext | Response> {
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
  return { merchantId: binding.value.merchantId, client };
}

function commerceErrorResponse(error: CommerceClientError): Response {
  if (error.kind === "http" && error.status === 404)
    return controlError("api_key_not_found", 404);
  // Commerce refuses a scope that Pantry does not hold, or one that no key
  // may hold; the owner can choose other scopes.
  if (error.kind === "http" && error.status === 422)
    return controlJson(
      { ok: false, error: "api_key_rejected", detail: error.message },
      422,
    );
  return controlError("underclerk_unavailable", 503);
}

function decode(value: string | undefined): string {
  if (value === undefined) throw new Error("API key route capture is missing");
  return decodeURIComponent(value);
}
