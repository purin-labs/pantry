import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import {
  readStringField,
  readOrganisationIdField,
} from "../../boundary";
import {
  configurePersonRole,
  listOrganisationPersonRoles,
  parseApprovalRole,
  parsePersonId,
  parsePersonRoleOperation,
  type PersonRoleAdminError,
} from "../../data/person-authz";
import type { Env } from "../../env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from "../../http";
import {
  newRequestId,
  parseOrganisationId,
} from "../../ids";
import { traceLog } from "../../observability";
import { assertNever } from "@seams/std";
import {
  fieldErrorResponse,
  isAuthorizedOrganisationAdminRequest,
  jsonBodyErrorResponse,
} from "../support";

export async function handleAdministerPersonRoles(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }

  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  return request.method === "GET"
    ? handleListPersonRoles(request, env)
    : handleConfigurePersonRole(request, env);
}

export async function handleListPersonRoles(
  request: Request,
  env: Env,
): Promise<Response> {
  const organisationId = parseOrganisationId(
    new URL(request.url).searchParams.get("organisationId") ?? "",
  );

  if (!organisationId.ok) {
    return errorResponse("invalid_field", "organisationId is invalid.", 422);
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

  const people = await listOrganisationPersonRoles(
    scope.database,
    organisationId.value,
  );

  if (!people.ok) {
    return personRoleAdminErrorResponse(people.error);
  }

  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    people: people.value,
  });
}

export async function handleConfigurePersonRole(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const organisationId = readOrganisationIdField(body.value);
  const personIdField = readStringField(body.value, "personId");
  const operationField = readStringField(body.value, "operation");
  const roleField = readStringField(body.value, "role");

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

  if (!personIdField.ok || !operationField.ok || !roleField.ok) {
    return errorResponse(
      "invalid_field",
      "personId, operation, and role are required.",
      422,
    );
  }

  const personId = parsePersonId(personIdField.value);
  const operation = parsePersonRoleOperation(operationField.value);
  const role = parseApprovalRole(roleField.value);

  if (personId === null || operation === null || role === null) {
    return errorResponse(
      "invalid_field",
      "Person role mutation is invalid.",
      422,
    );
  }

  const requestId = newRequestId();
  const configured = await configurePersonRole(scope.database, {
    organisationId: organisationId.value,
    personId,
    operation,
    role,
    requestId,
    now: Date.now(),
  });

  if (!configured.ok) {
    return personRoleAdminErrorResponse(configured.error);
  }

  traceLog("identity.person_role_configured", {
    requestId,
    organisation_id: organisationId.value,
    person_id: personId,
    operation,
    role,
    audit_id: configured.value.auditId,
  });
  return jsonResponse({ ok: true, result: configured.value });
}

export function personRoleAdminErrorResponse(error: PersonRoleAdminError): Response {
  switch (error.code) {
    case "person_not_found":
      return notFound();
    case "invalid_person_record":
      return errorResponse(
        error.code,
        "Person authorization state is invalid.",
        500,
      );
    default:
      return assertNever(error);
  }
}
