import type {
  Api,
  AssistantMessageEventStream,
  Model,
  Provider,
  ProviderResponse,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { assertNever } from "@seams/std";
import type { Variant } from "@seams/type-utils";
import type { Result } from "../result";
import { runtimeFetch } from "../runtime-fetch";
import {
  isOrganisationAnthropicModel,
  isOrganisationCodexModel,
} from "../models/catalog";
import type {
  EmbeddedHarnessConstructionInput,
  EmbeddedHarnessConstructionError,
} from "./embedded-harness";
import type { GoalModelCallControl, GoalModelStop } from "./goal-model-calls";
import { accountPiGoalStream } from "./pi-goal-stream";

type PiModelRouteInput = Pick<
  EmbeddedHarnessConstructionInput,
  "model" | "modelTokenAllowance" | "modelRouteLease"
>;

export const PACKAGED_PI_MODEL = "moonshotai/kimi-k3";
/**
 * The OpenRouter models that Pantry's paid route runs. Production runs
 * PACKAGED_PI_MODEL; `PANTRY_PLATFORM_PI_MODEL` selects a cheaper one for tests
 * that call OpenRouter.
 */
export const PLATFORM_PI_MODELS = [
  PACKAGED_PI_MODEL,
  "qwen/qwen3.7-flash",
] as const;
export type PlatformPiModel = (typeof PLATFORM_PI_MODELS)[number];

export function isPlatformPiModel(model: string): model is PlatformPiModel {
  return (PLATFORM_PI_MODELS as readonly string[]).includes(model);
}
export const PACKAGED_PI_OPENAI_MODEL = "gpt-5.6-luna";

const PI_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const PI_CONTEXT_WINDOW = 256_000;
const PI_MAX_OUTPUT_TOKENS = 65_536;

type PlatformApiKeyLease = Variant<
  EmbeddedHarnessConstructionInput["modelRouteLease"],
  "platform_api_key"
>;

type OrganisationOpenAiApiKeyLease = Variant<
  EmbeddedHarnessConstructionInput["modelRouteLease"],
  "organisation_openai_api_key"
>;

type OrganisationChatGptSubscriptionLease = Variant<
  EmbeddedHarnessConstructionInput["modelRouteLease"],
  "organisation_chatgpt_subscription"
>;

type OrganisationAnthropicLease = Variant<
  EmbeddedHarnessConstructionInput["modelRouteLease"],
  "organisation_anthropic_api_key" | "organisation_claude_oauth"
>;

/**
 * Each route except OpenRouter calls the provider directly, with the
 * lease's `providerFetch`: through the model exit Worker (Plan 73).
 */
export type PiInferenceRoute =
  | {
      readonly kind: "openrouter";
      readonly model: Model<"openai-completions">;
      readonly provider: Provider<"openai-completions" | "anthropic-messages">;
      resolveModelApiKey(): Promise<string>;
    }
  | {
      readonly kind: "openai";
      readonly model: Model<"openai-responses">;
      readonly provider: Provider<"openai-responses">;
      readonly providerFetch: typeof fetch;
      resolveModelApiKey(): Promise<string>;
    }
  | {
      readonly kind: "anthropic";
      readonly model: Model<"anthropic-messages">;
      readonly provider: Provider<"anthropic-messages">;
      readonly providerFetch: typeof fetch;
      resolveModelApiKey(): Promise<string>;
    }
  | {
      /**
       * The organisation's ChatGPT subscription through pi-ai's legacy
       * Codex provider. Its effort is a thinking level, `high` or `xhigh`.
       */
      readonly kind: "openai-codex";
      readonly model: Model<"openai-codex-responses">;
      readonly provider: Provider<"openai-codex-responses">;
      readonly thinkingLevel: "high" | "xhigh";
      readonly providerFetch: typeof fetch;
      resolveModelApiKey(): Promise<string>;
      observeResponse: OrganisationChatGptSubscriptionLease["observeResponse"];
    }
  | {
      /**
       * The organisation's ChatGPT subscription through "Sign in with
       * ChatGPT" (Plan 74B): pi-ai's OpenAI provider on api.openai.com, with
       * the user access token as the key. pi-ai leaves out the request
       * fields that this route refuses when the key is not an `sk-` key.
       */
      readonly kind: "openai-chatgpt";
      readonly model: Model<"openai-responses">;
      readonly provider: Provider<"openai-responses">;
      readonly thinkingLevel: "high" | "xhigh";
      readonly providerFetch: typeof fetch;
      resolveModelApiKey(): Promise<string>;
      observeResponse: OrganisationChatGptSubscriptionLease["observeResponse"];
    };

export function resolvePiInferenceRoute(
  input: PiModelRouteInput,
): Result<PiInferenceRoute, EmbeddedHarnessConstructionError> {
  if (input.modelTokenAllowance <= 0) {
    return { ok: false, error: { code: "embedded_harness_model_unsupported" } };
  }
  switch (input.modelRouteLease.kind) {
    case "platform_api_key":
      return resolvePiOpenRouterRoute(input, input.modelRouteLease);
    case "organisation_openai_api_key":
      return resolvePiOpenAiRoute(input, input.modelRouteLease);
    case "organisation_claude_oauth":
    case "organisation_anthropic_api_key":
      return resolvePiAnthropicRoute(input, input.modelRouteLease);
    case "organisation_chatgpt_subscription":
      return resolvePiChatGptSubscriptionRoute(input, input.modelRouteLease);
    default:
      return assertNever(input.modelRouteLease);
  }
}

function resolvePiOpenRouterRoute(
  input: PiModelRouteInput,
  lease: PlatformApiKeyLease,
): Result<PiInferenceRoute, EmbeddedHarnessConstructionError> {
  if (!isPlatformPiModel(input.model)) {
    return { ok: false, error: { code: "embedded_harness_model_unsupported" } };
  }
  return {
    ok: true,
    value: {
      kind: "openrouter",
      model: createPiOpenRouterModel(input.model, input.modelTokenAllowance),
      provider: openrouterProvider(),
      resolveModelApiKey: lease.resolveModelApiKey,
    },
  };
}

function resolvePiOpenAiRoute(
  input: PiModelRouteInput,
  lease: OrganisationOpenAiApiKeyLease,
): Result<PiInferenceRoute, EmbeddedHarnessConstructionError> {
  if (input.model !== PACKAGED_PI_OPENAI_MODEL) {
    return { ok: false, error: { code: "embedded_harness_model_unsupported" } };
  }
  const provider = openaiProvider();
  const model = provider.getModels().find(isPackagedPiOpenAiModel);
  if (model === undefined) {
    return { ok: false, error: { code: "embedded_harness_model_unsupported" } };
  }
  return {
    ok: true,
    value: {
      kind: "openai",
      model,
      provider,
      providerFetch: lease.providerFetch,
      resolveModelApiKey: lease.resolveModelApiKey,
    },
  };
}

function resolvePiAnthropicRoute(
  input: PiModelRouteInput,
  lease: OrganisationAnthropicLease,
): Result<PiInferenceRoute, EmbeddedHarnessConstructionError> {
  if (!isOrganisationAnthropicModel(input.model)) {
    return { ok: false, error: { code: "embedded_harness_model_unsupported" } };
  }
  const provider = anthropicProvider();
  const model = provider
    .getModels()
    .find(anthropicModelHasId.bind(null, input.model));
  if (model === undefined) {
    return { ok: false, error: { code: "embedded_harness_model_unsupported" } };
  }
  return {
    ok: true,
    value: {
      kind: "anthropic",
      model,
      provider,
      providerFetch: lease.providerFetch,
      resolveModelApiKey: lease.resolveModelApiKey,
    },
  };
}

function resolvePiChatGptSubscriptionRoute(
  input: PiModelRouteInput,
  lease: OrganisationChatGptSubscriptionLease,
): Result<PiInferenceRoute, EmbeddedHarnessConstructionError> {
  if (!isOrganisationCodexModel(input.model)) {
    return { ok: false, error: { code: "embedded_harness_model_unsupported" } };
  }
  if (lease.api === "openai_responses") {
    const provider = openaiProvider();
    const model = provider
      .getModels()
      .find(openAiModelHasId.bind(null, input.model));
    if (model === undefined) {
      return {
        ok: false,
        error: { code: "embedded_harness_model_unsupported" },
      };
    }
    return {
      ok: true,
      value: {
        kind: "openai-chatgpt",
        model,
        provider,
        thinkingLevel: "high",
        providerFetch: lease.providerFetch,
        resolveModelApiKey: lease.resolveModelApiKey,
        observeResponse: lease.observeResponse,
      },
    };
  }
  const provider = openaiCodexProvider();
  const model = provider.getModels().find(modelHasId.bind(null, input.model));
  if (model === undefined) {
    return { ok: false, error: { code: "embedded_harness_model_unsupported" } };
  }
  return {
    ok: true,
    value: {
      kind: "openai-codex",
      model,
      provider,
      thinkingLevel: "high",
      providerFetch: lease.providerFetch,
      resolveModelApiKey: lease.resolveModelApiKey,
      observeResponse: lease.observeResponse,
    },
  };
}

function modelHasId(
  id: string,
  model: Model<"openai-codex-responses">,
): boolean {
  return model.id === id;
}

function openAiModelHasId(
  id: string,
  model: Model<"openai-responses">,
): boolean {
  return model.id === id;
}

function isPackagedPiOpenAiModel(model: Model<"openai-responses">): boolean {
  return model.id === PACKAGED_PI_OPENAI_MODEL;
}

function anthropicModelHasId(
  id: string,
  model: Model<"anthropic-messages">,
): boolean {
  return model.id === id;
}

function createPiOpenRouterModel(
  modelId: string,
  tokenAllowance: number,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: PI_OPENROUTER_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: PI_CONTEXT_WINDOW,
    maxTokens: Math.min(tokenAllowance, PI_MAX_OUTPUT_TOKENS),
    compat: {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "openrouter",
      openRouterRouting: { sort: "throughput" },
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
      supportsStrictMode: true,
    },
  };
}

/**
 * What the provider answered to one model request. `errorStatus` becomes
 * true when each HTTP answer had an error status (4xx or 5xx). The status
 * comes before any body, so the provider generated no tokens: an error
 * answer counts as zero tokens (Refactor 15). It stays null when no answer
 * arrived, and false when an answer started a stream that failed later.
 */
export type PiModelResponse = { errorStatus: boolean | null };

/**
 * The caller reads the API key first: a failed key read sends no request,
 * so it is no model call.
 */
export async function dispatchPiModel(input: {
  readonly route: PiInferenceRoute;
  readonly apiKey: string;
  readonly context: TranscriptContext;
  readonly sessionId: EmbeddedHarnessConstructionInput["sessionId"];
  readonly tokenAllowance: number;
  readonly goalModelCalls: GoalModelCallControl;
  readonly response: PiModelResponse;
  readonly options?: SimpleStreamOptions;
}): Promise<Result<AssistantMessageEventStream, GoalModelStop>> {
  const { route, context, tokenAllowance, goalModelCalls, options } = input;
  const streamOptions: SimpleStreamOptions = {
    ...options,
    sessionId: input.sessionId,
    apiKey: input.apiKey,
    maxTokens: Math.min(
      options?.maxTokens ?? tokenAllowance,
      tokenAllowance,
      route.model.maxTokens,
    ),
    onResponse: observePiModelResponse.bind(
      null,
      route,
      input.response,
      options?.onResponse,
    ),
  };
  if (goalModelCalls.kind === "untracked")
    return { ok: true, value: streamPiProvider(route, context, streamOptions) };
  const admission = await goalModelCalls.begin();
  if (!admission.ok) return admission;
  const ticket = admission.value;
  let stream: AssistantMessageEventStream;
  try {
    stream = streamPiProvider(route, context, streamOptions);
  } catch (error) {
    await goalModelCalls.settle(ticket, { kind: "unknown" });
    throw error;
  }
  return {
    ok: true,
    value: accountPiGoalStream(
      stream,
      goalModelCalls,
      ticket,
      route.model,
      input.response,
    ),
  };
}

function streamPiProvider(
  inferenceRoute: PiInferenceRoute,
  context: TranscriptContext,
  streamOptions: SimpleStreamOptions,
): AssistantMessageEventStream {
  switch (inferenceRoute.kind) {
    case "openrouter":
      // OpenRouter is reached from the Worker itself, not the model exit.
      return inferenceRoute.provider.streamSimple(
        inferenceRoute.model,
        context,
        reportingStreamOptions(
          streamOptions,
          runtimeFetch,
          inferenceRoute.model,
        ),
      );
    case "openai":
    case "openai-chatgpt":
      return inferenceRoute.provider.streamSimple(
        inferenceRoute.model,
        context,
        reportingStreamOptions(
          streamOptions,
          inferenceRoute.providerFetch,
          inferenceRoute.model,
        ),
      );
    case "anthropic":
      return inferenceRoute.provider.streamSimple(
        inferenceRoute.model,
        context,
        reportingStreamOptions(
          streamOptions,
          inferenceRoute.providerFetch,
          inferenceRoute.model,
        ),
      );
    case "openai-codex":
      // The Session id is the prompt cache key. SSE: the Session holds no
      // socket between model requests, and pi-ai's WebSocket transport
      // would not use the exit Worker's fetch.
      return inferenceRoute.provider.streamSimple(
        inferenceRoute.model,
        context,
        {
          ...streamOptions,
          transport: "sse",
          fetch: inferenceRoute.providerFetch,
        },
      );
    default:
      return assertNever(inferenceRoute);
  }
}

/**
 * pi-ai reports only a 2xx answer to `onResponse`: the OpenAI and Anthropic
 * SDKs throw on a refusal first. This fetch reports every answer, so a
 * request with an error status counts as zero tokens, and the ChatGPT
 * sign-in sees a rejected token.
 */
function reportingStreamOptions(
  streamOptions: SimpleStreamOptions,
  providerFetch: typeof fetch,
  model: Model<Api>,
): SimpleStreamOptions {
  return {
    ...streamOptions,
    onResponse: undefined,
    fetch: reportingFetch.bind(
      null,
      providerFetch,
      streamOptions.onResponse,
      model,
    ),
  };
}

async function reportingFetch(
  providerFetch: typeof fetch,
  onResponse: SimpleStreamOptions["onResponse"],
  model: Model<Api>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await providerFetch(input, init);
  await onResponse?.(
    {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    },
    model,
  );
  return response;
}

async function observePiModelResponse(
  route: PiInferenceRoute,
  observed: PiModelResponse,
  next: SimpleStreamOptions["onResponse"],
  response: ProviderResponse,
  model: Model<Api>,
): Promise<void> {
  observed.errorStatus =
    (observed.errorStatus ?? true) &&
    response.status >= 400 &&
    response.status < 600;
  if (route.kind === "openai-codex" || route.kind === "openai-chatgpt")
    route.observeResponse(response);
  await next?.(response, model);
}
