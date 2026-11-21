import { pantryCommerceAccess } from "../../commerce/contract/client";
import { CommerceEntityPlaneClient } from "@purin-labs/commerce-client";
import { createFinancierSample } from "../../commerce/bakery/sample";
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
import type { AgentScenarioSavePayload } from "@purin-labs/bakery-model/bakery-agent-scenario-save";
import {
  parseProductionScenario,
  type ProductionScenario,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import {
  parseScenarioCopy,
  type ScenarioCopy,
} from "@purin-labs/bakery-model/bakery-scenario";
import type { Env } from "../../env";
import {
  controlMutationScope,
  parseMutationBoundary,
  replayControlMutation,
  resolveMutationUser,
} from "../admission/control-mutation";
import { resolveMerchantBinding } from "../../commerce/contract/merchant-control";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { assertNever } from "@purin-labs/std";

export type BakeryAction =
  "sample" | "operation" | "scenario" | "production-scenario";
type BakeryMutation =
  | Readonly<{ kind: "sample" }>
  | Readonly<{ kind: "operation"; edit: OperationEdit }>
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
  const boundary = await parseMutationBoundary(
    request,
    body.value,
    "unversioned",
  );
  if (boundary instanceof Response) return boundary;
  const scope = controlMutationScope(
    authorized,
    `/v1/control/organisations/${authorized.organisationId}/commerce/bakery/${action}`,
    `commerce.bakery.${action}`,
  );
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
  const replayed = await replayControlMutation({
    db: authorized.executionScope.database,
    scope,
    boundary,
    replay: async (receipt) => {
      if (
        saveIdentity !== null &&
        agentSave.kind === "agent_effect" &&
        receipt.responseStatus === 200 &&
        isSavedScenarioResult(receipt.responseBody, agentSave)
      ) {
        try {
          await settleAgentScenarioSave(
            saveIdentity,
            agentSave.payload,
            receipt.responseBody,
          );
        } catch {
          return controlError("bakery_request_unavailable", 503);
        }
      }
      return controlJson(receipt.responseBody, receipt.responseStatus);
    },
  });
  if (replayed !== null) return replayed;
  const identity = await resolveMutationUser(
    env,
    authorized.authenticated.session.userId,
  );
  if (identity instanceof Response) return identity;
  if (saveIdentity !== null) {
    const completed = await readCompletedAgentScenarioSave(saveIdentity);
    if (completed !== null) {
      const recordedMutationReceipt = await recordCommerceMutationReceipt({
        authorized,
        identity,
        scope,
        boundary,
        request,
        responseBody: completed,
        now: Date.now(),
      });
      if (!recordedMutationReceipt.ok)
        return controlError(recordedMutationReceipt.error.code, 409);
      return controlJson(completed);
    }
  }
  const binding = await resolveMerchantBinding(authorized);
  if (binding instanceof Response) return binding;
  if (
    env.COMMERCE_BASE_URL === undefined ||
    env.COMMERCE_SERVICE_TOKEN === undefined
  )
    return controlError("commerce_unavailable", 503);
  const now = Date.now();
  try {
    const client = new CommerceEntityPlaneClient({
      baseUrl: env.COMMERCE_BASE_URL,
      ...pantryCommerceAccess(
        env.COMMERCE_SERVICE_TOKEN,
        String(authorized.organisationId),
        env.COMMERCE.fetch.bind(env.COMMERCE),
        String(authorized.membership.personId),
      ),
    });
    const input = {
      client,
      organisationId: authorized.organisationId,
      merchantId: binding.merchantId,
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
          commandId: boundary.idempotencyKey,
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
        result.code === "commerce_unavailable" ? 503 : 409,
      );
    const responseBody = result;
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
