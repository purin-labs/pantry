import type { Env } from "../../../env";
import type { Result } from "../../../result";
import { resolveUser } from "../../../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  parseControlMutationBoundary,
  prepareControlMutationReceipt,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import {
  parseOrganisationInferenceSelection,
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
  type OrganisationInferenceSelectionError,
} from "../../../data/organisation-inference-selection";
import {
  parseOpenAiApiKey,
  parseAnthropicApiKey,
  storeOrganisationAnthropicModelCredential,
  storeOrganisationOpenAiModelCredential,
  type AnthropicApiKey,
  type OpenAiApiKey,
} from "../../../credential-vault";
import { resolveOrganisationModelRouteForSelection } from "../../../models/route";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../../http";
import { controlCausationId } from "../../mutation";
import { activationModelRouteError } from "../../onboarding-runtime";
import { assertNever, hasExactKeys } from "@seams/std";
import { readOnboardingRow } from "../../../data/organisation-onboarding-row";

export async function handleOrganisationInference(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method === "GET") {
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const selection = await readOrganisationInferenceSelection({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
    });
    return selection === null
      ? controlError("organisation_not_found", 404)
      : controlJson({
          ok: true,
          selection: selection.selection,
          configurationVersion: selection.configurationVersion,
        });
  }
  if (request.method !== "PUT") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("inference_selection_invalid", 422);
  }
  const mutation = parseOrganisationInferenceMutation(body.value);
  if (!mutation.ok) return controlError(mutation.error.code, 422);
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: true,
  });
  if (!boundary.ok || boundary.value.kind !== "configuration_versioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const scope: ControlMutationReceiptScope = {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/inference`,
    operation: "organisation.inference.select",
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
  const current = await readOrganisationInferenceSelection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  if (current === null) return controlError("organisation_not_found", 404);
  if (
    current.configurationVersion !== boundary.value.expectedConfigurationVersion
  ) {
    return controlError("configuration_version_conflict", 409);
  }
  const lifecycle = await readOnboardingRow(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  if (lifecycle === null) return controlError("organisation_not_found", 404);
  if (
    lifecycle.lifecycle === "activating" ||
    lifecycle.lifecycle === "suspended" ||
    lifecycle.lifecycle === "archived" ||
    lifecycle.lifecycle === "purging" ||
    lifecycle.lifecycle === "purged"
  ) {
    return controlError("organisation_lifecycle_conflict", 409);
  }
  if (mutation.value.kind === "organisation_openai_api_key") {
    const stored = await storeOrganisationOpenAiModelCredential({
      db: authorized.executionScope.database,
      keys: env,
      organisationId: authorized.organisationId,
      apiKey: mutation.value.apiKey,
      now: Date.now(),
    });
    if (!stored.ok) {
      return controlError("organisation_openai_api_key_store_failed", 502);
    }
  }
  if (mutation.value.kind === "organisation_anthropic_api_key") {
    const stored = await storeOrganisationAnthropicModelCredential({
      db: authorized.executionScope.database,
      keys: env,
      organisationId: authorized.organisationId,
      apiKey: mutation.value.apiKey,
      now: Date.now(),
    });
    if (!stored.ok) {
      return controlError("organisation_anthropic_api_key_store_failed", 502);
    }
  }
  if (lifecycle.lifecycle === "active") {
    const requestedRoute = await resolveOrganisationModelRouteForSelection({
      env,
      scope: authorized.executionScope,
      now: Date.now(),
      selection: mutation.value.selection,
    });
    if (!requestedRoute.ok) {
      return controlError(
        activationModelRouteError(requestedRoute.error.code),
        409,
      );
    }
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) return controlError("app_user_missing", 401);
  const now = Date.now();
  const mutationIdentity = newControlMutationIdentity({
    portalSubjectHash: await hashPortalSubject(
      identity.issuer,
      identity.subject,
    ),
    causationId: controlCausationId(request),
    now,
  });
  const selected = await selectOrganisationInferenceSelection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    selection: mutation.value.selection,
    expectedConfigurationVersion: boundary.value.expectedConfigurationVersion,
    selectedByUserId: identity.userId,
    now,
  });
  if (!selected.ok) return organisationInferenceSelectionError(selected.error);
  const responseBody = {
    ok: true,
    selection: selected.value.selection,
    configurationVersion: selected.value.configurationVersion,
    receipt: {
      receipt_id: mutationIdentity.receiptId,
      organisation_id: authorized.organisationId,
    },
  };
  const session =
    authorized.executionScope.database.withSession("first-primary");
  await session.batch([
    prepareControlMutationReceipt(session, {
      scope,
      boundary: boundary.value,
      identity: mutationIdentity,
      responseStatus: 200,
      responseBody,
    }),
  ]);
  return controlJson(responseBody);
}

export type OrganisationInferenceMutation =
  | {
      readonly kind: "selection_only";
      readonly selection:
        | { readonly kind: "claude_oauth" }
        | { readonly kind: "codex_subscription" }
        | { readonly kind: "satyr_platform" };
      readonly apiKey?: never;
    }
  | {
      readonly kind: "organisation_openai_api_key";
      readonly selection: { readonly kind: "organisation_openai_api_key" };
      readonly apiKey: OpenAiApiKey;
    }
  | {
      readonly kind: "organisation_anthropic_api_key";
      readonly selection: { readonly kind: "organisation_anthropic_api_key" };
      readonly apiKey: AnthropicApiKey;
    };

export function parseOrganisationInferenceMutation(
  body: JsonRecord,
): Result<
  OrganisationInferenceMutation,
  { readonly code: "inference_selection_invalid" }
> {
  const selection = parseOrganisationInferenceSelection(body.selection);
  if (!selection.ok) return selection;
  switch (selection.value.kind) {
    case "claude_oauth":
    case "codex_subscription":
    case "satyr_platform":
      return hasExactKeys(body, ["selection"])
        ? {
            ok: true,
            value: { kind: "selection_only", selection: selection.value },
          }
        : { ok: false, error: { code: "inference_selection_invalid" } };
    case "organisation_openai_api_key": {
      if (!hasExactKeys(body, ["selection", "apiKey"])) {
        return { ok: false, error: { code: "inference_selection_invalid" } };
      }
      const apiKey = parseOpenAiApiKey(body.apiKey);
      return apiKey.ok
        ? {
            ok: true,
            value: {
              kind: "organisation_openai_api_key",
              selection: selection.value,
              apiKey: apiKey.value,
            },
          }
        : { ok: false, error: { code: "inference_selection_invalid" } };
    }
    case "organisation_anthropic_api_key": {
      if (!hasExactKeys(body, ["selection", "apiKey"])) {
        return { ok: false, error: { code: "inference_selection_invalid" } };
      }
      const apiKey = parseAnthropicApiKey(body.apiKey);
      return apiKey.ok
        ? {
            ok: true,
            value: {
              kind: "organisation_anthropic_api_key",
              selection: selection.value,
              apiKey: apiKey.value,
            },
          }
        : { ok: false, error: { code: "inference_selection_invalid" } };
    }
    default:
      return assertNever(selection.value);
  }
}

export function organisationInferenceSelectionError(
  error: OrganisationInferenceSelectionError,
): Response {
  switch (error.code) {
    case "organisation_not_found":
      return controlError(error.code, 404);
    case "configuration_version_conflict":
      return controlError(error.code, 409);
    case "organisation_lifecycle_conflict":
      return controlError(error.code, 409);
    default:
      return assertNever(error);
  }
}
