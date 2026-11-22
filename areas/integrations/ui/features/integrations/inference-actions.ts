import React from "react";
import { assertNever } from "@purin-labs/std";
import { runIntegrationsCommand } from "./page-actions";
import type { IntegrationsRouteMutationContext } from "./settings-types";
import type { OrganisationInferenceSelection } from "@purin-labs/control-api/portal/settings";
import { parseInferenceSelectionCommand } from "@purin-labs/control-api/portal/inference";

export async function saveInferenceSelection(
  context: IntegrationsRouteMutationContext,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget;
  const parsed = parseInferenceSelectionCommand(new FormData(form));
  clearSubmittedInferenceSecret(form);
  if (parsed.kind === "invalid") {
    context.setFeedback({
      mutation: { kind: "inference_selection" },
      message: parsed.message,
    });
    return;
  }
  await runIntegrationsCommand(
    context,
    parsed.command,
    { kind: "inference_selection" },
    inferenceSelectionSuccessMessage(parsed.command.selection),
  );
}

function clearSubmittedInferenceSecret(form: HTMLFormElement): void {
  for (const name of ["openAiApiKey", "anthropicApiKey"]) {
    const apiKeyInput = form.querySelector<HTMLInputElement>(
      `input[name="${name}"]`,
    );
    if (apiKeyInput !== null) apiKeyInput.value = "";
  }
}

function inferenceSelectionSuccessMessage(
  selection: OrganisationInferenceSelection,
): string {
  switch (selection.kind) {
    case "claude_oauth":
      return "New agent conversations will use Claude OAuth through Pi.";
    case "codex_subscription":
      return "New agent conversations will use your ChatGPT subscription.";
    case "pantry_platform":
      return "New agent conversations will use Purin AI.";
    case "organisation_openai_api_key":
      return "New agent conversations will use Pi with your OpenAI API key.";
    case "organisation_anthropic_api_key":
      return "New agent conversations will use Pi with your Anthropic API key.";
    case "organisation_google_api_key":
      return "New agent conversations will use Pi with your Gemini API key.";
    default:
      return assertNever(selection, "Unexpected settings state");
  }
}
