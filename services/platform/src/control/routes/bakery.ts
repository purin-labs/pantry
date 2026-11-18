import { pantryCommerceAccess } from "../../commerce/app-access";
import { CommerceEntityPlaneClient } from "@seams/commerce-client";
import { createFinancierSample } from "../../commerce/bakery/sample";
import {
  parseOvenAssignmentEdit,
  saveOvenAssignment,
  type OvenAssignmentEdit,
} from "../../commerce/bakery/assignment";
import {
  parseOperationEdit,
  saveOperationDuration,
  type OperationEdit,
} from "../../commerce/bakery/operation";
import { saveScenarioCopy } from "../../commerce/bakery/scenario";
import { saveProductionScenario } from "../../commerce/bakery/production-scenario";
import {
  approveAgentScenarioSave,
  readCompletedAgentScenarioSave,
  settleAgentScenarioSave,
} from "../../commerce/bakery/agent-scenario-save";
import type { AgentScenarioSavePayload } from "@seams/bakery-model/bakery-agent-scenario-save";
import {
  parseProductionScenario,
  type ProductionScenario,
} from "@seams/bakery-model/bakery-production-scenario";
import {
  parseScenarioCopy,
  type ScenarioCopy,
} from "@seams/bakery-model/bakery-scenario";
import { resolveUser } from "../../data/control-plane";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
} from "../../data/control-mutation";
import { resolveOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import type { Env } from "../../env";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { readOrganisationEnvironment } from "../organisation-runtime";
import { assertNever } from "@seams/std";

export type BakeryAction =
  "sample" | "operation" | "scenario" | "production-scenario" | "assignment";
type BakeryMutation =
  | Readonly<{ kind: "sample" }>
  | Readonly<{ kind: "operation"; edit: OperationEdit }>
  | Readonly<{ kind: "assignment"; edit: OvenAssignmentEdit }>
  | Readonly<{ kind: "scenario"; copy: ScenarioCopy }>
  | Readonly<{ kind: "production-scenario"; copy: ProductionScenario }>;

export async function handleBakeryControl(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  action: BakeryAction,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("bakery_request_invalid", 422);
  const { agentEffectId, ...mutationBody } = body.value;
  const mutation = parseBakeryMutation(action, mutationBody);
  if (mutation === null) return controlError("bakery_request_invalid", 422);
  const agentSave = parseAgentScenarioOrigin(agentEffectId, mutation);
  if (agentSave === null) return controlError("bakery_request_invalid", 422);
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned")
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  const scope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/bakery/${action}`,
    operation: `commerce.bakery.${action}`,
  };
  const saveIdentity =
    agentSave.kind === "agent_effect"
      ? {
          db: authorized.executionScope.database,
          organisationId: authorized.organisationId,
          userId: authorized.authenticated.session.userId,
          effectId: agentSave.effectId,
        }
      : null;
  if (
    saveIdentity !== null &&
    agentSave.kind === "agent_effect" &&
    !(await approveAgentScenarioSave(saveIdentity, agentSave.payload))
  )
    return controlError("bakery_agent_save_approval_invalid", 409);
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict")
    return controlError("idempotency_key_conflict", 409);
  if (replay.kind === "replay") {
    if (
      saveIdentity !== null &&
      agentSave.kind === "agent_effect" &&
      replay.receipt.responseStatus === 200 &&
      isSavedScenarioResult(replay.receipt.responseBody, agentSave)
    ) {
      try {
        await settleAgentScenarioSave(
          saveIdentity,
          agentSave.payload,
          replay.receipt.responseBody,
        );
      } catch {
        return controlError("bakery_request_unavailable", 503);
      }
    }
    return controlJson(
      replay.receipt.responseBody,
      replay.receipt.responseStatus,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  if (saveIdentity !== null) {
    const completed = await readCompletedAgentScenarioSave(saveIdentity);
    if (completed !== null) {
      const recordedMutationReceipt = await recordCommerceMutationReceipt({
        authorized,
        identity,
        scope,
        boundary: boundary.value,
        request,
        responseBody: completed,
        now: Date.now(),
      });
      if (!recordedMutationReceipt.ok)
        return controlError(recordedMutationReceipt.error.code, 409);
      return controlJson(completed);
    }
  }
  const environment = await readOrganisationEnvironment(authorized.executionScope.database, authorized.organisationId);
  if (environment === null) return controlError("organisation_not_found", 404);
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  if (!binding.ok) return controlError("underclerk_binding_missing", 503);
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  )
    return controlError("underclerk_unavailable", 503);
  const now = Date.now();
  try {
    const client = new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(authorized.organisationId),
        env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
        String(authorized.membership.personId),
      ),
    });
    const input = {
      client,
      organisationId: authorized.organisationId,
      merchantId: binding.value.merchantId,
      principalId: identity.userId,
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
    };
    let result;
    switch (mutation.kind) {
      case "sample":
        result = await createFinancierSample(input);
        break;
      case "operation":
        result = await saveOperationDuration({
          ...input,
          commandId: boundary.value.idempotencyKey,
          edit: mutation.edit,
        });
        break;
      case "assignment":
        result = await saveOvenAssignment({
          ...input,
          commandId: boundary.value.idempotencyKey,
          edit: mutation.edit,
        });
        break;
      case "production-scenario":
        result = await saveProductionScenario({
          ...input,
          copy: mutation.copy,
        });
        break;
      case "scenario":
        result = await saveScenarioCopy({ ...input, copy: mutation.copy });
        break;
      default:
        return assertNever(mutation);
    }
    if (!result.ok)
      return controlError(
        result.code,
        result.code === "underclerk_unavailable" ? 503 : 409,
      );
    const responseBody = result;
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
    if (
      saveIdentity !== null &&
      agentSave.kind === "agent_effect" &&
      isSavedScenarioResult(result, agentSave)
    )
      await settleAgentScenarioSave(saveIdentity, agentSave.payload, result);
    return controlJson(responseBody);
  } catch {
    return controlError("bakery_request_unavailable", 503);
  }
}

type AgentScenarioOrigin =
  | Readonly<{ kind: "manual" }>
  | Readonly<{
      kind: "agent_effect";
      effectId: string;
      payload: AgentScenarioSavePayload;
    }>;

function parseAgentScenarioOrigin(
  effectId: unknown,
  mutation: BakeryMutation,
): AgentScenarioOrigin | null {
  if (effectId === undefined) return { kind: "manual" };
  if (
    typeof effectId !== "string" ||
    !/^surface_effect_[0-9a-f]{40}$/u.test(effectId)
  )
    return null;
  if (mutation.kind === "scenario")
    return {
      kind: "agent_effect",
      effectId,
      payload: { kind: "scenario", copy: mutation.copy },
    };
  if (mutation.kind === "production-scenario")
    return {
      kind: "agent_effect",
      effectId,
      payload: { kind: "production-scenario", copy: mutation.copy },
    };
  return null;
}

function isSavedScenarioResult(
  result: unknown,
  origin: AgentScenarioOrigin,
): result is Readonly<{ ok: true; scenarioId: string }> {
  return (
    origin.kind === "agent_effect" &&
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === true &&
    "scenarioId" in result &&
    result.scenarioId === origin.payload.copy.id
  );
}

function parseBakeryMutation(
  action: BakeryAction,
  body: Readonly<Record<string, unknown>>,
): BakeryMutation | null {
  switch (action) {
    case "sample":
      return Object.keys(body).length === 0 ? { kind: "sample" } : null;
    case "operation": {
      const edit = parseOperationEdit(body);
      return edit === null ? null : { kind: "operation", edit };
    }
    case "assignment": {
      const edit = parseOvenAssignmentEdit(body);
      return edit === null ? null : { kind: "assignment", edit };
    }
    case "scenario": {
      const copy = parseScenarioCopy(body);
      return copy === null ? null : { kind: "scenario", copy };
    }
    case "production-scenario": {
      const copy = parseProductionScenario(body);
      return copy === null ? null : { kind: "production-scenario", copy };
    }
    default:
      return assertNever(action);
  }
}
