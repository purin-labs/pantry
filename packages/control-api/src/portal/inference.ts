import { assertNever } from "@seams/std";
import type {
  OrganisationInferenceSelection,
  SelectInferenceCommand,
} from "./settings.ts";

type InferenceSelectionCommandParseResult =
  | { readonly kind: "valid"; readonly command: SelectInferenceCommand }
  | { readonly kind: "invalid"; readonly message: string };

export function parseInferenceSelectionCommand(
  formData: FormData,
): InferenceSelectionCommandParseResult {
  const selection = parseInferenceSelection(formData.get("inferenceSelection"));
  if (selection === null) {
    return { kind: "invalid", message: "Choose an inference source." };
  }
  switch (selection.kind) {
    case "claude_oauth":
    case "codex_subscription":
    case "satyr_platform":
      return {
        kind: "valid",
        command: { kind: "select_inference", selection },
      };
    case "organisation_openai_api_key": {
      const rawApiKey = formData.get("openAiApiKey");
      if (typeof rawApiKey !== "string" || rawApiKey.trim().length === 0) {
        return { kind: "invalid", message: "Enter an OpenAI API key." };
      }
      return {
        kind: "valid",
        command: {
          kind: "select_inference",
          selection,
          apiKey: rawApiKey.trim(),
        },
      };
    }
    case "organisation_anthropic_api_key": {
      const rawApiKey = formData.get("anthropicApiKey");
      if (typeof rawApiKey !== "string" || rawApiKey.trim().length === 0) {
        return { kind: "invalid", message: "Enter an Anthropic API key." };
      }
      return {
        kind: "valid",
        command: {
          kind: "select_inference",
          selection,
          apiKey: rawApiKey.trim(),
        },
      };
    }
    default:
      return assertNever(selection, "Unexpected settings state");
  }
}

export function parseInferenceSelection(
  value: FormDataEntryValue | null,
): OrganisationInferenceSelection | null {
  switch (value) {
    case "claude_oauth":
      return { kind: "claude_oauth" };
    case "codex_subscription":
      return { kind: "codex_subscription" };
    case "satyr_platform":
      return { kind: "satyr_platform" };
    case "organisation_openai_api_key":
      return { kind: "organisation_openai_api_key" };
    case "organisation_anthropic_api_key":
      return { kind: "organisation_anthropic_api_key" };
    default:
      return null;
  }
}
