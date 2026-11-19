import type { Env } from "../../../env";
import {
  prepareControlMutationReceipt,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import {
  admitUserMutation,
  controlMutationIdentity,
} from "../../admission/control-mutation";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../../authorization";
import { controlError, controlJson, type JsonRecord } from "../../http";
import type { Variant } from "@purin-labs/type-utils";
import {
  prepareConfigurationVersionAdvance,
  prepareConfigurationVersionFence,
  readOnboardingRow,
} from "../../../data/organisation-onboarding-row";

export type MutationContext = Readonly<{
  authorized: AuthorizedOrganisationRequest;
  boundary: Variant<ControlMutationBoundary, "configuration_versioned">;
  mutationIdentity: ControlMutationIdentity;
  scope: ControlMutationReceiptScope;
}>;

export async function beginMutation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  body: JsonRecord,
  operation: string,
  routeSuffix: string,
): Promise<MutationContext | Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/custom-connectors/${routeSuffix}`,
    operation,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const version = await readOnboardingRow(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  if (version?.configurationVersion !== boundary.expectedConfigurationVersion) {
    return controlError("configuration_version_conflict", 409);
  }
  const now = Date.now();
  return {
    authorized,
    boundary,
    mutationIdentity: await controlMutationIdentity(request, identity, now),
    scope,
  };
}

export async function completeMutation(
  env: Env,
  context: MutationContext,
  storedResult: JsonRecord,
  advanceConfiguration: boolean,
  liveResult?: JsonRecord,
): Promise<Response> {
  const expected = context.boundary.expectedConfigurationVersion;
  const configurationVersion = expected + 1;
  const responseBody = {
    ...storedResult,
    configurationVersion,
    receipt: {
      receiptId: context.mutationIdentity.receiptId,
      operation: context.scope.operation,
    },
  };
  const session =
    context.authorized.executionScope.database.withSession("first-primary");
  try {
    const configurationStatement = advanceConfiguration
      ? prepareConfigurationVersionAdvance(session, {
          organisationId: context.authorized.organisationId,
          expected,
          next: configurationVersion,
          now: context.mutationIdentity.createdAt,
        })
      : prepareConfigurationVersionFence(
          session,
          context.authorized.organisationId,
          configurationVersion,
        );
    const results = await session.batch([
      configurationStatement,
      prepareControlMutationReceipt(session, {
        scope: context.scope,
        boundary: context.boundary,
        identity: context.mutationIdentity,
        responseStatus: 200,
        responseBody,
      }),
    ]);
    if (results[0]?.meta.changes !== 1) {
      return controlError("configuration_version_conflict", 409);
    }
  } catch {
    return controlError("configuration_version_conflict", 409);
  }
  return liveResult === undefined
    ? controlJson(responseBody)
    : controlJson({
        ...liveResult,
        configurationVersion,
        receipt: responseBody.receipt,
      });
}

export function requireAdminRole(
  role: AuthorizedOrganisationRequest["membership"]["role"],
): "owner" | "admin" {
  if (role === "owner" || role === "admin") return role;
  throw new Error("custom connector approval role invariant failed");
}

export function customError(code: string, _detail?: unknown): Response {
  if (code.includes("not_found") || code.includes("not_available")) {
    return controlError(code, 404);
  }
  if (
    code.includes("invalid") ||
    code.includes("validation_failed") ||
    code.includes("mismatch")
  ) {
    return controlError(code, 422);
  }
  if (code.includes("transport") || code.includes("executor")) {
    return controlError(code, 503);
  }
  return controlError(code, 409);
}
