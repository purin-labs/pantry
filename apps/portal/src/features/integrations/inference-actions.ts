import React from "react";
import { assertNever } from "@seams/std";
import { runIntegrationsCommand } from "./page-actions";
import type { IntegrationsRouteMutationContext } from "./settings-types";
import type { OrganisationInferenceSelection } from "@seams/control-api/portal/settings";
import { parseInferenceSelectionCommand } from "@seams/control-api/portal/inference";

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

export function clearSubmittedInferenceSecret(form: HTMLFormElement): void {
  for (const name of ["openAiApiKey", "anthropicApiKey"]) {
    const apiKeyInput = form.querySelector<HTMLInputElement>(
      `input[name="${name}"]`,
    );
    if (apiKeyInput !== null) apiKeyInput.value = "";
  }
}

export function inferenceSelectionSuccessMessage(
  selection: OrganisationInferenceSelection,
): string {
  switch (selection.kind) {
    case "claude_oauth":
      return "New agent conversations will use Claude OAuth through Pi.";
    case "codex_subscription":
      return "New agent conversations will use your ChatGPT subscription.";
    case "satyr_platform":
      return "New agent conversations will use Seams AI.";
    case "organisation_openai_api_key":
      return "New agent conversations will use Pi with your OpenAI API key.";
    case "organisation_anthropic_api_key":
      return "New agent conversations will use Pi with your Anthropic API key.";
    default:
      return assertNever(selection, "Unexpected settings state");
  }
}
