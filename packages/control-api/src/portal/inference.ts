import { assertNever } from "@purin-labs/std";
import type {
  ApiKeyInferenceSelectionKind,
  OrganisationInferenceSelection,
  SelectInferenceCommand,
} from "./settings.ts";

/** The form field and the empty-field message of each key selection. */
const API_KEY_FIELDS: Readonly<
  Record<
    ApiKeyInferenceSelectionKind,
    { readonly field: string; readonly missing: string }
  >
> = {
  organisation_openai_api_key: {
    field: "openAiApiKey",
    missing: "Enter an OpenAI API key.",
  },
  organisation_anthropic_api_key: {
    field: "anthropicApiKey",
    missing: "Enter an Anthropic API key.",
  },
  organisation_google_api_key: {
    field: "googleApiKey",
    missing: "Enter a Gemini API key.",
  },
};

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
    case "pantry_platform":
      return {
        kind: "valid",
        command: { kind: "select_inference", selection },
      };
    case "organisation_openai_api_key":
    case "organisation_anthropic_api_key":
    case "organisation_google_api_key": {
      const fields = API_KEY_FIELDS[selection.kind];
      const rawApiKey = formData.get(fields.field);
      if (typeof rawApiKey !== "string" || rawApiKey.trim().length === 0) {
        return { kind: "invalid", message: fields.missing };
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

/** One inference selection from a form value or a server answer. */
export function parseInferenceSelection(
  value: unknown,
): OrganisationInferenceSelection | null {
  switch (value) {
    case "claude_oauth":
    case "codex_subscription":
    case "pantry_platform":
    case "organisation_openai_api_key":
    case "organisation_anthropic_api_key":
    case "organisation_google_api_key":
      return { kind: value };
    default:
      return null;
  }
}
