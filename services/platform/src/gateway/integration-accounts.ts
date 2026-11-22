import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { readOrganisationIdField } from "../boundary";
import { listIntegrationAccounts } from "../data/integration-account";
import type { Env } from "@purin-labs/kernel/env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from "@purin-labs/kernel/http";
import {
  fieldErrorResponse,
  isAuthorizedOrganisationAdminRequest,
  isLocalDebugRequest,
  jsonBodyErrorResponse,
} from "./request-helpers";

export async function handleListIntegrationAccounts(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (
    !isLocalDebugRequest(request) &&
    !isAuthorizedOrganisationAdminRequest(request, env)
  ) {
    return notFound();
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const organisationId = readOrganisationIdField(body.value);

  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const scope = execution.value;

  const accounts = await listIntegrationAccounts({
    db: scope.database,
    organisationId: organisationId.value,
  });
  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    accounts,
  });
}
