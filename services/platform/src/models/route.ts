import { readClaudeConnection } from "./claude-connection";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { ModelRoute } from "@seams/contracts";
import type { ChatEffort, ChatModelCapabilities } from "@seams/control-api";

import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import { readOrganisationCodexConnectionAtScope } from "./codex-connection";
import {
  PACKAGED_PI_MODEL,
  PACKAGED_PI_OPENAI_MODEL,
  isPlatformPiModel,
} from "../actors/pi-model-transport";
import {
  resolveCurrentOrganisationAnthropicModelCredential,
  resolveCurrentOrganisationOpenAiModelCredential,
} from "../credential-vault";
import {
  readOrganisationInferenceSelection,
  type OrganisationInferenceSelection,
} from "../data/organisation-inference-selection";
import {
  DEFAULT_ORGANISATION_CODEX_MODEL,
  DEFAULT_ORGANISATION_ANTHROPIC_MODEL,
  parseOrganisationAnthropicModel,
  parseOrganisationCodexModel,
  ORGANISATION_ANTHROPIC_MODEL_OPTIONS,
  ORGANISATION_CODEX_MODEL_OPTIONS,
} from "./catalog";
import type { VariantBy } from "@seams/type-utils";
import { assertNever } from "@seams/std";

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
    | "satyr_platform_credential_unavailable"
    | "satyr_platform_model_unsupported";
};

export type OrganisationOpenAiModelRoute = VariantBy<
  ModelRoute,
  "keySource",
  "organisation_byo"
> & { readonly provider: "openai" };

export type OrganisationAnthropicModelRoute = VariantBy<
  ModelRoute,
  "keySource",
  "organisation_byo"
> & { readonly provider: "anthropic" };

export type OrganisationOpenAiModelRouteError = {
  readonly code: "organisation_openai_api_key_unavailable";
};

export type OrganisationAnthropicModelRouteError = {
  readonly code: "organisation_anthropic_api_key_unavailable";
};

export type OrganisationClaudeOAuthModelRoute = VariantBy<
  ModelRoute,
  "keySource",
  "organisation_oauth"
>;

export type OrganisationModelRoute =
  | OrganisationClaudeOAuthModelRoute
  | OrganisationSubscriptionModelRoute
  | OrganisationOpenAiModelRoute
  | OrganisationAnthropicModelRoute
  | PantryPlatformModelRoute;

export type OrganisationModelRouteError =
  | { readonly code: "claude_connection_unavailable" }
  | OrganisationSubscriptionModelRouteError
  | OrganisationOpenAiModelRouteError
  | OrganisationAnthropicModelRouteError
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
  return [
    {
      id: route.model,
      name: route.model,
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
  env: Pick<Env, "OPENROUTER_API_KEY" | "SATYR_PLATFORM_PI_MODEL">,
): Result<PantryPlatformModelRoute, PantryPlatformModelRouteError> {
  const key = env.OPENROUTER_API_KEY?.trim() ?? "";
  if (key.length === 0) {
    return {
      ok: false,
      error: { code: "satyr_platform_credential_unavailable" },
    };
  }
  const model = env.SATYR_PLATFORM_PI_MODEL?.trim() || PACKAGED_PI_MODEL;
  if (!isPlatformPiModel(model)) {
    return { ok: false, error: { code: "satyr_platform_model_unsupported" } };
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

export async function resolveOrganisationOpenAiModelRoute(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
}): Promise<
  Result<OrganisationOpenAiModelRoute, OrganisationOpenAiModelRouteError>
> {
  if (!(await input.scope.isActive()))
    return {
      ok: false,
      error: { code: "organisation_openai_api_key_unavailable" },
    };
  const credential = await resolveCurrentOrganisationOpenAiModelCredential({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.scope.organisationId,
  });
  if (!credential.ok) {
    return {
      ok: false,
      error: { code: "organisation_openai_api_key_unavailable" },
    };
  }
  return {
    ok: true,
    value: {
      keySource: "organisation_byo",
      provider: "openai",
      model: PACKAGED_PI_OPENAI_MODEL,
      byoKeyRef: credential.value.handle,
    },
  };
}

export async function resolveOrganisationAnthropicModelRoute(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
}): Promise<
  Result<OrganisationAnthropicModelRoute, OrganisationAnthropicModelRouteError>
> {
  if (!(await input.scope.isActive()))
    return {
      ok: false,
      error: { code: "organisation_anthropic_api_key_unavailable" },
    };
  const credential = await resolveCurrentOrganisationAnthropicModelCredential({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.scope.organisationId,
  });
  if (!credential.ok) {
    return {
      ok: false,
      error: { code: "organisation_anthropic_api_key_unavailable" },
    };
  }
  return {
    ok: true,
    value: {
      keySource: "organisation_byo",
      provider: "anthropic",
      model: DEFAULT_ORGANISATION_ANTHROPIC_MODEL,
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
      return resolveOrganisationOpenAiModelRoute(input);
    case "organisation_anthropic_api_key":
      return resolveOrganisationAnthropicModelRoute(input);
    case "satyr_platform":
      return resolvePantryPlatformModelRoute(input.env);
    default:
      return assertNever(input.selection);
  }
}

export async function digestModelRoute(route: ModelRoute): Promise<string> {
  const encoded = new TextEncoder().encode(
    JSON.stringify(modelRouteDigestMaterial(route)),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), byteToHex).join("");
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

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
