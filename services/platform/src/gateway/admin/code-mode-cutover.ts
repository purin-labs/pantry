import {
  readStringField,
  readOrganisationIdField,
} from "../../boundary";
import { codeModeExecutionReceiptId } from "../../actors/agent-session-code-mode-settlement";
import type {
  CodeModePlatformAdmissionControlInput,
  CodeModePlatformGovernorError,
} from "../../actors/code-mode-platform-governor";
import { codeModePlatformGovernor } from "../../actors/code-mode-platform-governor-stub";
import type { Env } from "../../env";
import { resolveActiveOrganisationActor } from "../../actors/actor-router";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from "../../http";
import { newRequestId } from "../../ids";
import {
  actorResolutionErrorResponse,
  isAuthorizedOrganisationAdminRequest,
  jsonBodyErrorResponse,
} from "../support";

export async function handleAdministerCodeModePlatformCutover(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }
  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  const governor = codeModePlatformGovernor(env);
  if (request.method === "GET") {
    const [inspected, governorLocation] = await Promise.all([
      governor.inspectCutoverQuiescence({ now: Date.now() }),
      governor.location(),
    ]);
    return inspected.ok
      ? jsonResponse({ ok: true, cutover: inspected.value, governorLocation })
      : codeModePlatformGovernorErrorResponse(inspected.error);
  }

  const body = await readJsonObject(request);
  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }
  const command = readStringField(body.value, "command");

  if (!command.ok) {
    return errorResponse(
      "invalid_field",
      "Code Mode cutover request is invalid.",
      422,
    );
  }

  if (command.value === "reconcile_execution") {
    const organisationId = readOrganisationIdField(body.value);
    const executionId = readStringField(body.value, "executionId");
    const providerCostMicros = body.value.providerCostMicros;
    if (
      !organisationId.ok ||
      !executionId.ok ||
      typeof providerCostMicros !== "number" ||
      !Number.isSafeInteger(providerCostMicros) ||
      providerCostMicros < 0
    ) {
      return errorResponse(
        "invalid_field",
        "Code Mode reconciliation input is invalid.",
        422,
      );
    }

    const now = Date.now();
    const organisation = await resolveActiveOrganisationActor({
      env: env,
      namespace: env.ORGANISATION,
      organisationId: organisationId.value,
      now,
    });
    if (!organisation.ok) {
      return actorResolutionErrorResponse(organisation.error);
    }

    const input = {
      requestId: newRequestId(),
      organisationId: organisationId.value,
      executionId: executionId.value,
      receiptId: codeModeExecutionReceiptId(executionId.value),
      providerCostMicros,
      now,
    };
    const organisationReconciled =
      await organisation.value.reconcileCodeModeBudget(input);
    if (!organisationReconciled.ok) {
      return errorResponse(
        organisationReconciled.error.code,
        "Organisation Code Mode usage could not be reconciled.",
        409,
      );
    }
    const platformReconciled = await governor.reconcile(input);
    return platformReconciled.ok
      ? jsonResponse({
          ok: true,
          organisation: organisationReconciled.value,
          platform: platformReconciled.value,
        })
      : codeModePlatformGovernorErrorResponse(platformReconciled.error);
  }

  const idempotencyKey = readStringField(body.value, "idempotencyKey");
  const reason = readStringField(body.value, "reason");
  if (
    !idempotencyKey.ok ||
    !reason.ok ||
    (command.value !== "freeze_admission" && command.value !== "open_admission")
  ) {
    return errorResponse(
      "invalid_field",
      "Code Mode cutover request is invalid.",
      422,
    );
  }
  const controlled = await governor.controlAdmission(
    buildCodeModePlatformControlInput({
      command: command.value,
      idempotencyKey: idempotencyKey.value,
      reason: reason.value,
      now: Date.now(),
    }),
  );
  return controlled.ok
    ? jsonResponse({ ok: true, admission: controlled.value })
    : codeModePlatformGovernorErrorResponse(controlled.error);
}

function buildCodeModePlatformControlInput(input: {
  readonly command: CodeModePlatformAdmissionControlInput["command"];
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly now: number;
}): CodeModePlatformAdmissionControlInput {
  const identity = {
    requestId: newRequestId(),
    idempotencyKey: input.idempotencyKey,
    requestedBy: "organisation-admin-token",
    reason: input.reason,
    now: input.now,
  };
  return input.command === "freeze_admission"
    ? { ...identity, command: "freeze_admission" }
    : { ...identity, command: "open_admission" };
}

function codeModePlatformGovernorErrorResponse(
  error: CodeModePlatformGovernorError,
): Response {
  if (error.code === "invalid_code_mode_budget_input") {
    return errorResponse(
      error.code,
      "Code Mode cutover input is invalid.",
      422,
    );
  }
  if (error.code === "code_mode_platform_state_invalid") {
    return errorResponse(
      error.code,
      "Code Mode platform state is invalid.",
      500,
    );
  }
  return errorResponse(
    error.code,
    "Code Mode platform control conflicted.",
    409,
  );
}
