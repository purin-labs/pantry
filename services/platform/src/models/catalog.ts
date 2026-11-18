import type { Result } from "../result";
import type { ChatModelCapabilities } from "@seams/control-api";

const TEXT_TOOLS_CAPABILITIES: ChatModelCapabilities = {
  input: { text: true, images: true, documents: false },
  tools: true,
  progressSummaries: true,
  citations: false,
  effortOptions: ["low", "medium", "high"],
  contextWindowTokens: 256_000,
};

const CODEX_CAPABILITIES: ChatModelCapabilities = {
  ...TEXT_TOOLS_CAPABILITIES,
  effortOptions: ["high"],
};

export const ORGANISATION_CODEX_MODEL_OPTIONS = [
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    description: "Most capable for complex research and connector design.",
    capabilities: CODEX_CAPABILITIES,
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    description: "Strong reasoning for demanding work.",
    capabilities: CODEX_CAPABILITIES,
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    description: "Balanced intelligence and speed.",
    capabilities: CODEX_CAPABILITIES,
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    description: "Fast for everyday requests.",
    capabilities: CODEX_CAPABILITIES,
  },
] as const;

const CLAUDE_CAPABILITIES: ChatModelCapabilities = {
  input: { text: true, images: true, documents: true },
  tools: true,
  progressSummaries: true,
  citations: true,
  effortOptions: ["low", "medium", "high"],
  contextWindowTokens: 1_000_000,
};

// Sonnet 4.6 stays: chats that began on it keep their model.
export const ORGANISATION_ANTHROPIC_MODEL_OPTIONS = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    description: "Most capable Claude for complex research and planning.",
    capabilities: CLAUDE_CAPABILITIES,
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    description: "Balanced Claude intelligence for everyday work.",
    capabilities: CLAUDE_CAPABILITIES,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    description: "The earlier Sonnet, for chats that began on it.",
    capabilities: CLAUDE_CAPABILITIES,
  },
] as const;

export type OrganisationAnthropicModel =
  (typeof ORGANISATION_ANTHROPIC_MODEL_OPTIONS)[number]["id"];

export const DEFAULT_ORGANISATION_ANTHROPIC_MODEL: OrganisationAnthropicModel =
  "claude-sonnet-5-5";

export type OrganisationCodexModel =
  (typeof ORGANISATION_CODEX_MODEL_OPTIONS)[number]["id"];

export const DEFAULT_ORGANISATION_CODEX_MODEL: OrganisationCodexModel =
  "gpt-5.6-luna";

export function parseOrganisationCodexModel(
  raw: unknown,
): Result<OrganisationCodexModel, { readonly code: "chat_model_invalid" }> {
  for (const option of ORGANISATION_CODEX_MODEL_OPTIONS) {
    if (raw === option.id) return { ok: true, value: option.id };
  }
  return { ok: false, error: { code: "chat_model_invalid" } };
}

export function isOrganisationCodexModel(
  raw: string,
): raw is OrganisationCodexModel {
  return parseOrganisationCodexModel(raw).ok;
}

export function parseOrganisationAnthropicModel(
  raw: unknown,
): Result<OrganisationAnthropicModel, { readonly code: "chat_model_invalid" }> {
  for (const option of ORGANISATION_ANTHROPIC_MODEL_OPTIONS) {
    if (raw === option.id) return { ok: true, value: option.id };
  }
  return { ok: false, error: { code: "chat_model_invalid" } };
}

export function isOrganisationAnthropicModel(
  raw: string,
): raw is OrganisationAnthropicModel {
  return parseOrganisationAnthropicModel(raw).ok;
}
