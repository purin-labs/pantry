import type {
  CounterRegisterDeps,
  CounterRegisterFailure,
} from "../../contract/counter-sale";
import type {
  ControlMutationReceiptScope,
  UnversionedControlMutationBoundary,
} from "@purin-labs/tenancy/data/control-mutation";
import type { Env } from "@purin-labs/kernel/env";
import { admitUserMutation } from "@purin-labs/control/worker/admission/control-mutation";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import {
  authorizeMerchantRead,
  resolveMerchantControlContext,
  type MerchantControlContext,
} from "@purin-labs/area-commerce-contract/server/merchant-control";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "@purin-labs/control/worker/http";
import { recordCommerceMutationReceipt } from "@purin-labs/control/worker/mutation-receipt";

/**
 * The steps that every café counter route shares (Plan 90): the merchant
 * context, the mutation boundary and its receipt, and the error answers.
 */

type CommerceClientError = Extract<
  CounterRegisterFailure,
  Readonly<{ kind: "commerce" }>
>["error"];

/** The merchant context of a read, after the role check. */
export async function beginRead(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  role: "viewer" | "operator",
): Promise<CounterRegisterDeps | Response> {
  const read = await authorizeMerchantRead(
    request,
    env,
    organisationIdRaw,
    role,
  );
  if (read instanceof Response) return read;
  return makeDeps(env, read.authorized, read.context);
}

export type StartedMutation = Readonly<{
  authorized: AuthorizedOrganisationRequest;
  identity: Readonly<{ issuer: string; subject: string; userId: string }>;
  scope: ControlMutationReceiptScope;
  boundary: UnversionedControlMutationBoundary;
  context: MerchantControlContext;
  deps: CounterRegisterDeps;
  body: JsonRecord;
  now: number;
}>;

function makeDeps(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  context: MerchantControlContext,
): CounterRegisterDeps {
  return {
    env,
    scope: authorized.executionScope,
    organisationId: authorized.organisationId,
    merchantId: context.merchantId,
    client: context.client,
  };
}

export async function beginMutation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  operation: string,
  role: "operator" | "admin",
  routePath = "commerce/counter-sales",
): Promise<StartedMutation | Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    role,
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("counter_sale_request_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/${routePath}`,
    operation,
  });
  if (admitted instanceof Response) return admitted;
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  return {
    authorized,
    identity: admitted.user,
    scope: admitted.scope,
    boundary: admitted.boundary,
    context,
    deps: makeDeps(env, authorized, context),
    body: body.value,
    now: Date.now(),
  };
}

export async function finishMutation(
  request: Request,
  started: StartedMutation,
  responseBody: unknown,
): Promise<Response> {
  const recorded = await recordCommerceMutationReceipt({
    authorized: started.authorized,
    identity: started.identity,
    scope: started.scope,
    boundary: started.boundary,
    request,
    responseBody,
    responseStatus: 200,
    now: started.now,
  });
  return recorded.ok
    ? controlJson(responseBody)
    : controlError(recorded.error.code, 409);
}

export function failureResponse(failure: CounterRegisterFailure): Response {
  if (failure.kind === "commerce") {
    return commerceErrorResponse(failure.error);
  }
  return controlJson(
    { ok: false, error: failure.code, ...(failure.extra ?? {}) },
    failure.status,
  );
}

function commerceErrorResponse(error: CommerceClientError): Response {
  if (error.kind === "rejected") {
    return controlJson(
      { ok: false, error: "counter_sale_rejected", detail: error.error },
      409,
    );
  }
  return error.kind === "http" && error.status >= 400 && error.status < 500
    ? controlJson(
        { ok: false, error: "counter_sale_rejected", detail: error.message },
        409,
      )
    : controlError("commerce_unavailable", 503);
}

export function match(
  pathname: string,
  pattern: RegExp,
): readonly string[] | null {
  const captures = pattern.exec(pathname);
  return captures === null ? null : captures.slice(1);
}

export function decode(value: string | undefined): string {
  if (value === undefined) throw new Error("Counter route capture is missing");
  return decodeURIComponent(value);
}
