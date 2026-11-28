import type { Env } from "@purin-labs/kernel/env";
import type { Result } from "@purin-labs/kernel/result";
import { prepareControlMutationReceipt } from "@purin-labs/tenancy/data/control-mutation";
import {
  API_KEY_SELECTION_PROVIDER,
  parseOrganisationInferenceSelection,
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
  type ApiKeySelectionKind,
  type OrganisationInferenceSelectionError,
} from "../../../data/organisation-inference-selection";
import {
  parseModelApiKey,
  storeOrganisationModelCredential,
  type ModelApiKey,
  type ModelKeyProvider,
} from "@purin-labs/authority/credential-vault/index";
import {
  activationModelRouteError,
  resolveOrganisationModelRouteForSelection,
} from "../../../models/route";
import {
  admitControlMutation,
  controlMutationIdentity,
  resolveMutationUser,
} from "@purin-labs/control/worker/admission/control-mutation";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "@purin-labs/control/worker/http";
import { assertNever, hasExactKeys } from "@purin-labs/std";
import { readOnboardingRow } from "@purin-labs/tenancy/data/organisation-onboarding-row";

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
  const admitted = await admitControlMutation({
    request,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    route: `/v1/control/organisations/${authorized.organisationId}/inference`,
    operation: "organisation.inference.select",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope } = admitted;
  const current = await readOrganisationInferenceSelection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
  });
  if (current === null) return controlError("organisation_not_found", 404);
  if (current.configurationVersion !== boundary.expectedConfigurationVersion) {
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
  if (mutation.value.kind === "api_key") {
    const stored = await storeOrganisationModelCredential({
      db: authorized.executionScope.database,
      keys: env,
      organisationId: authorized.organisationId,
      provider: mutation.value.provider,
      apiKey: mutation.value.apiKey,
      now: Date.now(),
    });
    if (!stored.ok) {
      return controlError(
        `organisation_${mutation.value.provider}_api_key_store_failed`,
        502,
      );
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
  const identity = await resolveMutationUser(
    env,
    authorized.authenticated.session.userId,
  );
  if (identity instanceof Response) return identity;
  const now = Date.now();
  const mutationIdentity = await controlMutationIdentity(
    request,
    identity,
    now,
  );
  const selected = await selectOrganisationInferenceSelection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    selection: mutation.value.selection,
    expectedConfigurationVersion: boundary.expectedConfigurationVersion,
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
      boundary,
      identity: mutationIdentity,
      responseStatus: 200,
      responseBody,
    }),
  ]);
  return controlJson(responseBody);
}

type OrganisationInferenceMutation =
  | {
      readonly kind: "selection_only";
      readonly selection:
        | { readonly kind: "claude_oauth" }
        | { readonly kind: "codex_subscription" }
        | { readonly kind: "pantry_platform" };
      readonly apiKey?: never;
    }
  | {
      readonly kind: "api_key";
      readonly selection: { readonly kind: ApiKeySelectionKind };
      readonly provider: ModelKeyProvider;
      readonly apiKey: ModelApiKey<ModelKeyProvider>;
    };

function parseOrganisationInferenceMutation(
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
    case "pantry_platform":
      return hasExactKeys(body, ["selection"])
        ? {
            ok: true,
            value: { kind: "selection_only", selection: selection.value },
          }
        : { ok: false, error: { code: "inference_selection_invalid" } };
    case "organisation_openai_api_key":
    case "organisation_anthropic_api_key":
    case "organisation_google_api_key": {
      if (!hasExactKeys(body, ["selection", "apiKey"])) {
        return { ok: false, error: { code: "inference_selection_invalid" } };
      }
      const provider = API_KEY_SELECTION_PROVIDER[selection.value.kind];
      const apiKey = parseModelApiKey(provider, body.apiKey);
      return apiKey.ok
        ? {
            ok: true,
            value: {
              kind: "api_key",
              selection: { kind: selection.value.kind },
              provider,
              apiKey: apiKey.value,
            },
          }
        : { ok: false, error: { code: "inference_selection_invalid" } };
    }
    default:
      return assertNever(selection.value);
  }
}

function organisationInferenceSelectionError(
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
