import React from "react";
import { assertNever } from "@purin-labs/std";
import { runIntegrationsCommand } from "./page-actions";
import type {
  IntegrationsRouteMutationContext,
  SignedInInferenceSelection,
} from "@purin-labs/area-integrations-contract/ui/features/integrations/settings-types";
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

/**
 * The sign-in of the account that the owner chose also selects it, with the
 * same command and checks as the save button.
 */
export async function selectSignedInAccount(
  context: IntegrationsRouteMutationContext,
  selection: SignedInInferenceSelection,
): Promise<void> {
  await runIntegrationsCommand(
    context,
    { kind: "select_inference", selection },
    { kind: "inference_selection" },
    inferenceSelectionSuccessMessage(selection),
  );
}

/** Each key field of the form is a password field: none keeps its key. */
function clearSubmittedInferenceSecret(form: HTMLFormElement): void {
  for (const input of form.querySelectorAll<HTMLInputElement>(
    'input[type="password"]',
  ))
    input.value = "";
}

function inferenceSelectionSuccessMessage(
  selection: OrganisationInferenceSelection,
): string {
  switch (selection.kind) {
    case "claude_oauth":
      return "New agent conversations will use Claude.";
    case "codex_subscription":
      return "New agent conversations will use ChatGPT.";
    case "pantry_platform":
      return "New agent conversations will use Purin AI.";
    case "organisation_openai_api_key":
      return "New agent conversations will use your OpenAI API key.";
    case "organisation_anthropic_api_key":
      return "New agent conversations will use your Anthropic API key.";
    case "organisation_google_api_key":
      return "New agent conversations will use your Gemini API key.";
    default:
      return assertNever(selection, "Unexpected settings state");
  }
}
