import type {
  CommerceAdminClient,
  CommerceClientError,
} from "@seams/commerce-client";

import type { Env } from "../../env";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../http";
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
import type { Variant } from "@seams/type-utils";

/**
 * The policy a counter sells under.
 *
 * This is the merchant-configurable half of a card-present sale: what may be
 * rung up, at what tax, in what currency, and how long a quote stands. It is
 * deliberately separate from a checkout profile — a counter has no storefront
 * to activate against, and requiring one would make an in-person sale depend on
 * an online configuration it makes no use of.
 */
export type CounterPolicyControlRoute =
  | Readonly<{ kind: "counterPolicies"; organisationIdRaw: string }>
  | Readonly<{
      kind: "counterPolicy";
      organisationIdRaw: string;
      satyrLocationIdRaw: string;
    }>;

type CounterPolicyContext = Readonly<{
  merchantId: string;
  client: CommerceAdminClient;
}>;

export function matchCounterPolicyControlRoute(
  pathname: string,
): CounterPolicyControlRoute | null {
  const policy = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-policies\/([^/]+)$/u,
  );
  if (policy !== null) {
    return {
      kind: "counterPolicy",
      organisationIdRaw: decode(policy[0]),
      satyrLocationIdRaw: decode(policy[1]),
    };
  }
  const policies = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-policies$/u,
  );
  return policies === null
    ? null
    : { kind: "counterPolicies", organisationIdRaw: decode(policies[0]) };
}

export function handleCounterPolicyControlRoute(
  request: Request,
  env: Env,
  route: CounterPolicyControlRoute,
): Promise<Response> {
  return route.kind === "counterPolicies"
    ? handleCounterPolicies(request, env, route.organisationIdRaw)
    : handleCounterPolicy(request, env, route);
}

async function handleCounterPolicies(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method === "POST")
    return publishCounterPolicy(request, env, organisationIdRaw);
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const context = await resolveCounterPolicyContext(env, authorized);
  if (context instanceof Response) return context;
  const configurations = await context.client.listPointOfSaleConfigurations(
    context.merchantId,
  );
  return configurations.ok
    ? controlJson({ ok: true, counterPolicies: configurations.value })
    : commerceErrorResponse(configurations.error);
}

async function handleCounterPolicy(
  request: Request,
  env: Env,
  route: Variant<CounterPolicyControlRoute, "counterPolicy">,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const context = await resolveCounterPolicyContext(env, authorized);
  if (context instanceof Response) return context;
  const configuration = await context.client.readPointOfSaleConfiguration(
    context.merchantId,
    route.satyrLocationIdRaw,
  );
  return configuration.ok
    ? controlJson({ ok: true, counterPolicy: configuration.value })
    : commerceErrorResponse(configuration.error);
}

/**
 * Publish a counter's policy.
 *
 * `expectedRevision` is the caller's evidence that they have seen what is
 * currently in force. Commerce assigns the new revision, so this cannot
 * publish underneath a sale that has already pinned one.
 */
async function publishCounterPolicy(
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
  if (!body.ok) return controlError("counter_policy_request_invalid", 422);
  const publication = parsePublication(body.value);
  if (publication === null)
    return controlError("counter_policy_request_invalid", 422);
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
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/counter-policies`,
    operation: "counter_policy.publish",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict")
    return controlError("idempotency_key_conflict", 409);
  if (replay.kind === "replay") {
    return controlJson(
      replay.receipt.responseBody,
      replay.receipt.responseStatus,
    );
  }
  const context = await resolveCounterPolicyContext(env, authorized);
  if (context instanceof Response) return context;
  const now = Date.now();
  const published = await context.client.publishPointOfSaleConfiguration({
    schemaVersion: "underclerk.publish-point-of-sale-configuration.v1",
    merchantId: context.merchantId,
    expectedRevision: publication.expectedRevision,
    publishedAt: new Date(now).toISOString(),
    // The operator who published is recorded on the policy itself, so a change
    // to what a counter charges is attributable without a separate audit read.
    publishedBy: identity.userId,
    configuration: {
      ...publication.configuration,
      organisationId: authorized.organisationId,
      merchantId: context.merchantId,
    },
  });
  if (!published.ok) return commerceErrorResponse(published.error);
  const responseBody = { ok: true, counterPolicy: published.value };
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

function parsePublication(body: JsonRecord): Readonly<{
  expectedRevision: number | null;
  configuration: JsonRecord;
}> | null {
  const { expectedRevision, configuration } = body;
  if (
    typeof configuration !== "object" ||
    configuration === null ||
    Array.isArray(configuration)
  ) {
    return null;
  }
  if (expectedRevision === null || expectedRevision === undefined) {
    return {
      expectedRevision: null,
      configuration: configuration as JsonRecord,
    };
  }
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) <= 0)
    return null;
  return {
    expectedRevision: Number(expectedRevision),
    configuration: configuration as JsonRecord,
  };
}

async function resolveCounterPolicyContext(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<CounterPolicyContext | Response> {
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
  // A rejected publication is a conflict the operator can act on — a stale
  // revision, or a policy that does not describe a sellable counter — not a
  // Pantry fault, so it is not reported as one.
  if (error.kind === "rejected") {
    return controlJson(
      { ok: false, error: "counter_policy_rejected", detail: error.error },
      409,
    );
  }
  if (error.kind === "http" && error.status === 404) {
    return controlError("counter_policy_not_found", 404);
  }
  if (error.kind === "http" && error.status >= 400 && error.status < 500) {
    return controlJson(
      { ok: false, error: "counter_policy_rejected", detail: error.message },
      409,
    );
  }
  return controlError("underclerk_unavailable", 503);
}

function match(pathname: string, pattern: RegExp): readonly string[] | null {
  const captures = pattern.exec(pathname);
  return captures === null ? null : captures.slice(1);
}

function decode(value: string | undefined): string {
  if (value === undefined)
    throw new Error("Counter policy route capture is missing");
  return decodeURIComponent(value);
}
