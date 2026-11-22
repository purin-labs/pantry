import type { CommerceClientError } from "@purin-labs/commerce-client";

import type { Env } from "@purin-labs/kernel/env";
import { admitUserMutation } from "@purin-labs/control/worker/admission/control-mutation";
import { resolveMerchantControlContext } from "../../../../../services/platform/src/commerce/contract/merchant-control";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "@purin-labs/control/worker/http";
import { recordCommerceMutationReceipt } from "@purin-labs/control/worker/mutation-receipt";
import type { Variant } from "@purin-labs/type-utils";

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
      pantryLocationIdRaw: string;
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
      pantryLocationIdRaw: decode(policy[1]),
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
  const context = await resolveMerchantControlContext(env, authorized);
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
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const configuration = await context.client.readPointOfSaleConfiguration(
    context.merchantId,
    route.pantryLocationIdRaw,
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
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/counter-policies`,
    operation: "counter_policy.publish",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const now = Date.now();
  const published = await context.client.publishPointOfSaleConfiguration({
    schemaVersion: "commerce.publish-point-of-sale-configuration.v1",
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
    boundary,
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
  return controlError("commerce_unavailable", 503);
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
