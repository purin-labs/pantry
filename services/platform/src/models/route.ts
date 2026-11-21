import { readClaudeConnection } from "./claude-connection";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { ModelRoute } from "@purin-labs/contracts";
import type { ChatEffort, ChatModelCapabilities } from "@purin-labs/control-api";

import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import { readOrganisationCodexConnectionAtScope } from "./codex-connection";
import {
  PLATFORM_DEFAULT_PI_MODEL,
  PACKAGED_PI_OPENAI_MODEL,
  isPlatformPiModel,
  platformPiModelName,
} from "../actors/pi-model-transport";
import {
  resolveCurrentOrganisationModelCredential,
  type ModelKeyProvider,
} from "../credential-vault";
import {
  readOrganisationInferenceSelection,
  type OrganisationInferenceSelection,
} from "../data/organisation-inference-selection";
import {
  DEFAULT_ORGANISATION_CODEX_MODEL,
  DEFAULT_ORGANISATION_ANTHROPIC_MODEL,
  DEFAULT_ORGANISATION_GOOGLE_MODEL,
  parseOrganisationAnthropicModel,
  parseOrganisationCodexModel,
  parseOrganisationGoogleModel,
  ORGANISATION_ANTHROPIC_MODEL_OPTIONS,
  ORGANISATION_CODEX_MODEL_OPTIONS,
  ORGANISATION_GOOGLE_MODEL_OPTIONS,
} from "./catalog";
import type { VariantBy } from "@purin-labs/type-utils";
import { assertNever, sha256Hex } from "@purin-labs/std";

export const ORGANISATION_CODEX_MODEL = DEFAULT_ORGANISATION_CODEX_MODEL;

export type OrganisationChatModelOption = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: ChatModelCapabilities;
};

export type OrganisationSubscriptionModelRoute = VariantBy<
  ModelRoute,
  "keySource",
  "organisation_subscription"
> & { readonly provider: "openai" };

export type OrganisationSubscriptionModelRouteError = {
  readonly code: "organisation_codex_subscription_unavailable";
};

export type PantryPlatformModelRoute = VariantBy<
  ModelRoute,
  "keySource",
  "platform"
> & { readonly provider: "openai-compatible" };

export type PantryPlatformModelRouteError = {
  readonly code:
    | "pantry_platform_credential_unavailable"
    | "pantry_platform_model_unsupported";
};

/** The route of an Organisation's own API key, for one provider. */
export type OrganisationApiKeyModelRoute = VariantBy<
  ModelRoute,
  "keySource",
  "organisation_byo"
>;

export type OrganisationApiKeyModelRouteError = {
  readonly code: `organisation_${ModelKeyProvider}_api_key_unavailable`;
};

export type OrganisationClaudeOAuthModelRoute = VariantBy<
  ModelRoute,
  "keySource",
  "organisation_oauth"
>;

export type OrganisationModelRoute =
  | OrganisationClaudeOAuthModelRoute
  | OrganisationSubscriptionModelRoute
  | OrganisationApiKeyModelRoute
  | PantryPlatformModelRoute;

export type OrganisationModelRouteError =
  | { readonly code: "claude_connection_unavailable" }
  | OrganisationSubscriptionModelRouteError
  | OrganisationApiKeyModelRouteError
  | PantryPlatformModelRouteError
  | { readonly code: "organisation_inference_selection_unavailable" };

export async function resolveOrganisationSubscriptionModelRoute(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
}): Promise<
  Result<
    OrganisationSubscriptionModelRoute,
    OrganisationSubscriptionModelRouteError
  >
> {
  const connection = await readOrganisationCodexConnectionAtScope({
    env: input.env,
    scope: input.scope,
    now: input.now,
    reconcile: false,
  });
  if (!connection.ok || connection.value.kind !== "connected") {
    return {
      ok: false,
      error: { code: "organisation_codex_subscription_unavailable" },
    };
  }
  return {
    ok: true,
    value: {
      keySource: "organisation_subscription",
      provider: "openai",
      model: ORGANISATION_CODEX_MODEL,
      connectionRevision: connection.value.revision,
      authProfileGeneration: connection.value.authProfileGeneration,
    },
  };
}

export function organisationChatModelOptions(
  route: OrganisationModelRoute,
): readonly OrganisationChatModelOption[] {
  if (route.keySource === "organisation_subscription")
    return ORGANISATION_CODEX_MODEL_OPTIONS;
  if (route.provider === "anthropic")
    return ORGANISATION_ANTHROPIC_MODEL_OPTIONS;
  if (route.provider === "google") return ORGANISATION_GOOGLE_MODEL_OPTIONS;
  return [
    {
      id: route.model,
      name: routeModelName(route),
      description: "The model configured for this workspace inference source.",
      capabilities: {
        input: { text: true, images: true, documents: false },
        tools: true,
        progressSummaries: true,
        citations: false,
        effortOptions: ["low", "medium", "high"],
        contextWindowTokens: 256_000,
      },
    },
  ];
}

function routeModelName(route: OrganisationModelRoute): string {
  return route.keySource === "platform" && isPlatformPiModel(route.model)
    ? platformPiModelName(route.model)
    : route.model;
}

/**
 * The route of a chat that stored `storedModel` (spec FND-04). On Pantry's
 * paid route the stored model follows the route's model: that route offers
 * one model, so the person did not choose the stored one, and a chat from
 * before a change of the default keeps working. A model that a new message
 * names is still checked by selectOrganisationChatModel.
 */
export function selectStoredOrganisationChatModel(
  route: OrganisationModelRoute,
  storedModel: string,
): Result<OrganisationModelRoute, { readonly code: "chat_model_invalid" }> {
  if (route.keySource === "platform") return { ok: true, value: route };
  return selectOrganisationChatModel(route, storedModel);
}

export function selectOrganisationChatModel(
  route: OrganisationModelRoute,
  requestedModel: string,
): Result<OrganisationModelRoute, { readonly code: "chat_model_invalid" }> {
  switch (route.keySource) {
    case "organisation_subscription": {
      const model = parseOrganisationCodexModel(requestedModel);
      return model.ok
        ? { ok: true, value: { ...route, model: model.value } }
        : model;
    }
    case "platform":
    case "organisation_oauth":
    case "organisation_byo": {
      if (route.provider === "anthropic") {
        const model = parseOrganisationAnthropicModel(requestedModel);
        return model.ok
          ? { ok: true, value: { ...route, model: model.value } }
          : model;
      }
      if (route.provider === "google") {
        const model = parseOrganisationGoogleModel(requestedModel);
        return model.ok
          ? { ok: true, value: { ...route, model: model.value } }
          : model;
      }
      // A page loaded before a change of the paid route's default still names
      // the earlier model. The message runs on the route's model.
      if (route.keySource === "platform" && isPlatformPiModel(requestedModel))
        return { ok: true, value: route };
      if (requestedModel !== route.model) {
        return { ok: false, error: { code: "chat_model_invalid" } };
      }
      return { ok: true, value: route };
    }
  }
}

export async function resolveOrganisationModelRoute(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<Result<OrganisationModelRoute, OrganisationModelRouteError>> {
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!scope.ok)
    return {
      ok: false,
      error: { code: "organisation_inference_selection_unavailable" },
    };
  return readOrganisationModelRouteAtScope({
    env: input.env,
    scope: scope.value,
    now: input.now,
  });
}

export async function resolveOrganisationModelRouteAtScope(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
}): Promise<Result<OrganisationModelRoute, OrganisationModelRouteError>> {
  const resolved = await resolveSlackTurnModelRouteAtScope(input);
  return resolved.ok ? { ok: true, value: resolved.value.route } : resolved;
}

/**
 * The route of a Slack turn and the level of its answer. `thinkingLevel` is
 * the level that an owner or admin chose for Slack answers when the route's
 * model offers it. Otherwise it is undefined, and the route keeps its own
 * level.
 */
export type SlackTurnModelRoute = {
  readonly route: OrganisationModelRoute;
  readonly thinkingLevel: ChatEffort | undefined;
};

export async function resolveSlackTurnModelRouteAtScope(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
}): Promise<Result<SlackTurnModelRoute, OrganisationModelRouteError>> {
  // Reading the route decides nothing, so it shares the wait of the fence.
  // The route is given only under an active placement.
  const [active, route] = await Promise.all([
    input.scope.isActive(),
    readSlackTurnModelRouteAtScope(input),
  ]);
  return active
    ? route
    : {
        ok: false,
        error: { code: "organisation_inference_selection_unavailable" },
      };
}

async function readSlackTurnModelRouteAtScope(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
}): Promise<Result<SlackTurnModelRoute, OrganisationModelRouteError>> {
  const selection = await readOrganisationInferenceSelection({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
  });
  if (selection === null) {
    return {
      ok: false,
      error: { code: "organisation_inference_selection_unavailable" },
    };
  }
  const route = await resolveOrganisationModelRouteForSelection({
    env: input.env,
    scope: input.scope,
    now: input.now,
    selection: selection.selection,
  });
  if (!route.ok) return route;
  const effort = selection.slackReasoningEffort;
  return {
    ok: true,
    value: {
      route: route.value,
      thinkingLevel:
        effort !== null && routeModelOffersEffort(route.value, effort)
          ? effort
          : undefined,
    },
  };
}

async function readOrganisationModelRouteAtScope(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
}): Promise<Result<OrganisationModelRoute, OrganisationModelRouteError>> {
  const resolved = await readSlackTurnModelRouteAtScope(input);
  return resolved.ok ? { ok: true, value: resolved.value.route } : resolved;
}

function routeModelOffersEffort(
  route: OrganisationModelRoute,
  effort: ChatEffort,
): boolean {
  return (
    organisationChatModelOptions(route)
      .find(chatModelOptionHasId.bind(null, route.model))
      ?.capabilities.effortOptions.includes(effort) ?? false
  );
}

function chatModelOptionHasId(
  id: string,
  option: OrganisationChatModelOption,
): boolean {
  return option.id === id;
}

export function resolvePantryPlatformModelRoute(
  env: Pick<Env, "OPENROUTER_API_KEY" | "PANTRY_PLATFORM_PI_MODEL">,
): Result<PantryPlatformModelRoute, PantryPlatformModelRouteError> {
  const key = env.OPENROUTER_API_KEY?.trim() ?? "";
  if (key.length === 0) {
    return {
      ok: false,
      error: { code: "pantry_platform_credential_unavailable" },
    };
  }
  const model =
    env.PANTRY_PLATFORM_PI_MODEL?.trim() || PLATFORM_DEFAULT_PI_MODEL;
  if (!isPlatformPiModel(model)) {
    return { ok: false, error: { code: "pantry_platform_model_unsupported" } };
  }
  return {
    ok: true,
    value: {
      keySource: "platform",
      provider: "openai-compatible",
      model,
    },
  };
}

/** The default model of each provider whose key an Organisation stores. */
const API_KEY_DEFAULT_MODEL: Readonly<Record<ModelKeyProvider, string>> = {
  openai: PACKAGED_PI_OPENAI_MODEL,
  anthropic: DEFAULT_ORGANISATION_ANTHROPIC_MODEL,
  google: DEFAULT_ORGANISATION_GOOGLE_MODEL,
};

export async function resolveOrganisationApiKeyModelRoute(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly provider: ModelKeyProvider;
}): Promise<
  Result<OrganisationApiKeyModelRoute, OrganisationApiKeyModelRouteError>
> {
  const unavailable = {
    ok: false as const,
    error: {
      code: `organisation_${input.provider}_api_key_unavailable` as const,
    },
  };
  if (!(await input.scope.isActive())) return unavailable;
  const credential = await resolveCurrentOrganisationModelCredential({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.scope.organisationId,
    provider: input.provider,
  });
  if (!credential.ok) return unavailable;
  return {
    ok: true,
    value: {
      keySource: "organisation_byo",
      provider: input.provider,
      model: API_KEY_DEFAULT_MODEL[input.provider],
      byoKeyRef: credential.value.handle,
    },
  };
}

export async function resolveOrganisationModelRouteForSelection(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
  readonly selection: OrganisationInferenceSelection;
}): Promise<Result<OrganisationModelRoute, OrganisationModelRouteError>> {
  switch (input.selection.kind) {
    case "claude_oauth": {
      const connection = await readClaudeConnection({
        scope: input.scope,
        keys: input.env,
      });
      if (connection.kind !== "connected")
        return { ok: false, error: { code: "claude_connection_unavailable" } };
      return {
        ok: true,
        value: {
          keySource: "organisation_oauth",
          provider: "anthropic",
          model: DEFAULT_ORGANISATION_ANTHROPIC_MODEL,
          connectionId: connection.connectionId,
        },
      };
    }
    case "codex_subscription":
      return resolveOrganisationSubscriptionModelRoute(input);
    case "organisation_openai_api_key":
      return resolveOrganisationApiKeyModelRoute({ ...input, provider: "openai" });
    case "organisation_anthropic_api_key":
      return resolveOrganisationApiKeyModelRoute({
        ...input,
        provider: "anthropic",
      });
    case "organisation_google_api_key":
      return resolveOrganisationApiKeyModelRoute({ ...input, provider: "google" });
    case "pantry_platform":
      return resolvePantryPlatformModelRoute(input.env);
    default:
      return assertNever(input.selection);
  }
}

export async function digestModelRoute(route: ModelRoute): Promise<string> {
  return sha256Hex(JSON.stringify(modelRouteDigestMaterial(route)));
}

function modelRouteDigestMaterial(route: ModelRoute): ModelRoute {
  switch (route.keySource) {
    case "platform":
      return {
        keySource: route.keySource,
        provider: route.provider,
        model: route.model,
      };
    case "organisation_byo":
      return {
        keySource: route.keySource,
        provider: route.provider,
        model: route.model,
        byoKeyRef: route.byoKeyRef,
      };
    case "organisation_oauth":
      return {
        keySource: route.keySource,
        provider: route.provider,
        model: route.model,
        connectionId: route.connectionId,
      };
    case "organisation_subscription":
      return {
        keySource: route.keySource,
        provider: route.provider,
        model: route.model,
        connectionRevision: route.connectionRevision,
        authProfileGeneration: route.authProfileGeneration,
      };
  }
}

/** The public error code of a model route that an Organisation cannot use. */
export function activationModelRouteError(
  code: OrganisationModelRouteError["code"],
): string {
  switch (code) {
    case "claude_connection_unavailable":
      return "claude_connection_required";
    case "organisation_codex_subscription_unavailable":
      return "codex_subscription_required";
    case "pantry_platform_credential_unavailable":
      return "pantry_platform_credential_required";
    case "pantry_platform_model_unsupported":
      return "pantry_platform_model_unsupported";
    case "organisation_openai_api_key_unavailable":
      return "organisation_openai_api_key_required";
    case "organisation_anthropic_api_key_unavailable":
      return "organisation_anthropic_api_key_required";
    case "organisation_google_api_key_unavailable":
      return "organisation_google_api_key_required";
    case "organisation_inference_selection_unavailable":
      return "inference_selection_unavailable";
    default:
      return assertNever(code);
  }
}
