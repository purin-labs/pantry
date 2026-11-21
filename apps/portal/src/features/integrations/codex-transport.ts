import { controlRead } from "../../control-client";
import type { IntegrationsCommandResult } from "./settings-types";
import type { SelectInferenceCommand, OrganisationCodexConnection, OrganisationInferenceSelection } from "@purin-labs/control-api/portal/settings";
import {
  codexConnectionPath,
  inferencePath,
} from "../../control-paths";
import { parseCredentialInventoryResponse, type CredentialInventory } from "@purin-labs/control-api/portal/credential-inventory";
import { parseOrganisationCodexConnectionResponse, parseOrganisationInferenceSelectionResponse } from "@purin-labs/control-api/portal/codex";

export function codexAuthorizationResult(raw: unknown): IntegrationsCommandResult {
  const connection = parseOrganisationCodexConnectionResponse(raw);
  if (connection.kind !== "authorizing") {
    throw new Error("OpenAI authorization did not return a pending sign-in.");
  }
  return {
    kind: "authorization",
    authorizationUrl: connection.attempt.verificationUrl,
  };
}

export function isOrganisationApiKeyInferenceCommand(
  command: SelectInferenceCommand,
): command is Extract<SelectInferenceCommand, { readonly apiKey: string }> {
  return (
    command.selection.kind === "organisation_openai_api_key" ||
    command.selection.kind === "organisation_anthropic_api_key" ||
    command.selection.kind === "organisation_google_api_key"
  );
}

/**
 * Credential inventory is admin-scoped and additive to the integrations page:
 * a forbidden or failed read must not take down connection management, so it
 * degrades to null and the page omits credential lifecycle detail.
 */
export async function fetchCredentialInventory(
  organisationId: string,
): Promise<CredentialInventory | null> {
  try {
    return parseCredentialInventoryResponse(
      await controlRead(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/credentials`,
      ),
    );
  } catch {
    return null;
  }
}

export async function fetchOrganisationCodexConnection(
  organisationId: string,
): Promise<OrganisationCodexConnection> {
  return parseOrganisationCodexConnectionResponse(
    await controlRead(codexConnectionPath(organisationId)),
  );
}

export async function fetchCodexUsagePercent(
  organisationId: string,
): Promise<number | null> {
  const connection = await fetchOrganisationCodexConnection(organisationId);
  if (connection.kind !== "connected" && connection.kind !== "action_required")
    return null;
  if (connection.allowance.kind !== "available") return null;
  return Math.round(
    Math.max(0, Math.min(100, connection.allowance.usedPercent)),
  );
}

export async function fetchOrganisationInferenceSelection(
  organisationId: string,
): Promise<OrganisationInferenceSelection> {
  return parseOrganisationInferenceSelectionResponse(
    await controlRead(inferencePath(organisationId)),
  );
}
