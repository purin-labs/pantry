import type { EmbeddedHarnessAdapter } from "./embedded-harness";
import {
  ORGANISATION_GOOGLE_MODEL_OPTIONS,
  type OrganisationAnthropicModel,
  type OrganisationCodexModel,
  type OrganisationGoogleModel,
} from "../models/catalog";
import { createPiDurableAdapter } from "./pi-durable-runtime";
import {
  PI_DURABLE_BUILD,
  PI_DURABLE_CHECKPOINT_FORMAT,
} from "./pi-durable-checkpoint";
import {
  PACKAGED_PI_OPENAI_MODEL,
  PLATFORM_PI_MODELS,
  type PlatformPiModel,
} from "./pi-model-transport";

export const PACKAGED_PI_CHECKPOINT_FORMAT = PI_DURABLE_CHECKPOINT_FORMAT;
export const PACKAGED_PI_HARNESS_BUILD = PI_DURABLE_BUILD;
/** Pantry's paid OpenRouter route: one adapter for each model it runs. */
export const PI_PLATFORM_EMBEDDED_HARNESS_ADAPTERS = Object.fromEntries(
  PLATFORM_PI_MODELS.map(platformAdapterEntry),
) as Readonly<Record<PlatformPiModel, EmbeddedHarnessAdapter>>;

function platformAdapterEntry(
  model: PlatformPiModel,
): [PlatformPiModel, EmbeddedHarnessAdapter] {
  return [model, createPiDurableAdapter(model)];
}
export const PI_OPENAI_EMBEDDED_HARNESS_ADAPTER = createPiDurableAdapter(
  PACKAGED_PI_OPENAI_MODEL,
);
/** The Claude routes: one adapter for each model Portal offers. */
export const PI_ANTHROPIC_EMBEDDED_HARNESS_ADAPTERS: Readonly<
  Record<OrganisationAnthropicModel, EmbeddedHarnessAdapter>
> = {
  "claude-opus-5-5": createPiDurableAdapter("claude-opus-5-5"),
  "claude-sonnet-5-5": createPiDurableAdapter("claude-sonnet-5-5"),
  "claude-sonnet-4-6": createPiDurableAdapter("claude-sonnet-4-6"),
};
/** The Gemini key route: one adapter for each model Portal offers. */
export const PI_GOOGLE_EMBEDDED_HARNESS_ADAPTERS = Object.fromEntries(
  ORGANISATION_GOOGLE_MODEL_OPTIONS.map(googleAdapterEntry),
) as Readonly<Record<OrganisationGoogleModel, EmbeddedHarnessAdapter>>;

function googleAdapterEntry(option: {
  readonly id: OrganisationGoogleModel;
}): [OrganisationGoogleModel, EmbeddedHarnessAdapter] {
  return [option.id, createPiDurableAdapter(option.id)];
}
/** The ChatGPT subscription route: one adapter for each model Portal offers. */
export const PI_CHATGPT_SUBSCRIPTION_EMBEDDED_HARNESS_ADAPTERS: Readonly<
  Record<OrganisationCodexModel, EmbeddedHarnessAdapter>
> = {
  "gpt-6-astra": createPiDurableAdapter("gpt-6-astra"),
  "gpt-5.6-sol": createPiDurableAdapter("gpt-5.6-sol"),
  "gpt-5.6-terra": createPiDurableAdapter("gpt-5.6-terra"),
  "gpt-5.6-luna": createPiDurableAdapter("gpt-5.6-luna"),
};
