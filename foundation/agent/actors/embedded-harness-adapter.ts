import type { EmbeddedHarnessAdapter } from "./embedded-harness";
import type { ModelRoute } from "@purin-labs/contracts";
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

export function selectEmbeddedHarnessAdapterForModelRoute(
  route: ModelRoute,
): EmbeddedHarnessAdapter {
  if (
    route.keySource === "organisation_subscription" &&
    route.provider === "openai"
  ) {
    if (!isOrganisationCodexModel(route.model))
      throw new Error("embedded_harness_model_unsupported");
    return PI_CHATGPT_SUBSCRIPTION_EMBEDDED_HARNESS_ADAPTERS[route.model];
  }
  if (
    route.keySource === "platform" &&
    route.provider === "openai-compatible"
  ) {
    if (!isPlatformPiModel(route.model))
      throw new Error("embedded_harness_model_unsupported");
    return PI_PLATFORM_EMBEDDED_HARNESS_ADAPTERS[route.model];
  }
  if (route.keySource === "organisation_byo" && route.provider === "openai") {
    return PI_OPENAI_EMBEDDED_HARNESS_ADAPTER;
  }
  if (
    (route.keySource === "organisation_byo" ||
      route.keySource === "organisation_oauth") &&
    route.provider === "anthropic"
  ) {
    if (!isOrganisationAnthropicModel(route.model))
      throw new Error("embedded_harness_model_unsupported");
    return PI_ANTHROPIC_EMBEDDED_HARNESS_ADAPTERS[route.model];
  }
  if (route.keySource === "organisation_byo" && route.provider === "google") {
    if (!isOrganisationGoogleModel(route.model))
      throw new Error("embedded_harness_model_unsupported");
    return PI_GOOGLE_EMBEDDED_HARNESS_ADAPTERS[route.model];
  }
  throw new Error("embedded_harness_provider_unsupported");
}
