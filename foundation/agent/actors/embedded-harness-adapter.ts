import type { EmbeddedHarnessAdapter } from "./embedded-harness";
import type { ModelRoute } from "@purin-labs/contracts";
import type { Result } from "@purin-labs/kernel/result";
import {
  isOrganisationAnthropicModel,
  isOrganisationCodexModel,
  isOrganisationGoogleModel,
} from "../models/catalog";
import {
  PI_CHATGPT_SUBSCRIPTION_EMBEDDED_HARNESS_ADAPTERS,
  PI_ANTHROPIC_EMBEDDED_HARNESS_ADAPTERS,
  PI_GOOGLE_EMBEDDED_HARNESS_ADAPTERS,
  PI_OPENAI_EMBEDDED_HARNESS_ADAPTER,
  PI_PLATFORM_EMBEDDED_HARNESS_ADAPTERS,
} from "./pi-embedded-adapter";
import { isPlatformPiModel } from "./pi-model-transport";

/**
 * Why a route has no adapter. A Session keeps the route that it started
 * with, so a stored route can name a model that left its list: that is data,
 * not a programmer error.
 */
export type EmbeddedHarnessAdapterError =
  | { readonly code: "embedded_harness_model_unsupported" }
  | { readonly code: "embedded_harness_provider_unsupported" };

export function selectEmbeddedHarnessAdapterForModelRoute(
  route: ModelRoute,
): Result<EmbeddedHarnessAdapter, EmbeddedHarnessAdapterError> {
  if (
    route.keySource === "organisation_subscription" &&
    route.provider === "openai"
  ) {
    return isOrganisationCodexModel(route.model)
      ? present(PI_CHATGPT_SUBSCRIPTION_EMBEDDED_HARNESS_ADAPTERS[route.model])
      : MODEL_UNSUPPORTED;
  }
  if (
    route.keySource === "platform" &&
    route.provider === "openai-compatible"
  ) {
    return isPlatformPiModel(route.model)
      ? present(PI_PLATFORM_EMBEDDED_HARNESS_ADAPTERS[route.model])
      : MODEL_UNSUPPORTED;
  }
  if (route.keySource === "organisation_byo" && route.provider === "openai") {
    return { ok: true, value: PI_OPENAI_EMBEDDED_HARNESS_ADAPTER };
  }
  if (
    (route.keySource === "organisation_byo" ||
      route.keySource === "organisation_oauth") &&
    route.provider === "anthropic"
  ) {
    return isOrganisationAnthropicModel(route.model)
      ? present(PI_ANTHROPIC_EMBEDDED_HARNESS_ADAPTERS[route.model])
      : MODEL_UNSUPPORTED;
  }
  if (route.keySource === "organisation_byo" && route.provider === "google") {
    return isOrganisationGoogleModel(route.model)
      ? present(PI_GOOGLE_EMBEDDED_HARNESS_ADAPTERS[route.model])
      : MODEL_UNSUPPORTED;
  }
  return {
    ok: false,
    error: { code: "embedded_harness_provider_unsupported" },
  };
}

const MODEL_UNSUPPORTED = {
  ok: false,
  error: { code: "embedded_harness_model_unsupported" },
} as const;

/** A model in a list whose adapter is gone has no adapter either. */
function present(
  adapter: EmbeddedHarnessAdapter | undefined,
): Result<EmbeddedHarnessAdapter, EmbeddedHarnessAdapterError> {
  return adapter === undefined
    ? MODEL_UNSUPPORTED
    : { ok: true, value: adapter };
}
