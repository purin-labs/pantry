import type { ConversationId } from "@seams/control-api";
import { isRecord } from "@seams/std";
import {
  ControlApiError,
  controlRefusal,
  controlWrite,
  readCookie,
} from "../../control-client";
import { type ConfigurationDraftView, parseConfigurationDraft } from "@seams/control-api/portal/configuration-drafts";

export type ConfigurationDraftActions = Readonly<{
  confirm: (draft: ConfigurationDraftView) => Promise<ConfigurationDraftView>;
  cancel: (draft: ConfigurationDraftView) => Promise<ConfigurationDraftView>;
}>;

export function createConfigurationDraftActions(
  organisationId: string,
  conversationId: ConversationId,
): ConfigurationDraftActions {
  const base = `/v1/control/organisations/${encodeURIComponent(organisationId)}/chat/conversations/${encodeURIComponent(conversationId)}/configuration-drafts`;
  return {
    confirm: (draft) =>
      configurationDraftMutation(
        `${base}/${encodeURIComponent(draft.draftId)}/confirm`,
      ),
    cancel: (draft) =>
      configurationDraftMutation(
        `${base}/${encodeURIComponent(draft.draftId)}/cancel`,
      ),
  };
}

export async function configurationDraftMutation(
  path: string,
): Promise<ConfigurationDraftView> {
  const csrf = readCookie("satyr_control_csrf");
  if (csrf === null) throw new Error("Sign in again to act on this change.");
  let raw: unknown;
  try {
    raw = await controlWrite(path, "POST", {});
  } catch (error) {
    if (!(error instanceof ControlApiError)) throw error;
    const refused = controlRefusal(error);
    throw new Error(
      configurationRefusalText(
        isRecord(refused?.body) ? refused.body.error : undefined,
      ),
    );
  }
  if (!isRecord(raw)) throw new Error(configurationRefusalText(undefined));
  return parseConfigurationDraft(raw.draft);
}

export function configurationRefusalText(code: unknown): string {
  switch (code) {
    case "operator_draft_expired":
      return "This change timed out. Ask the agent to set it up again.";
    case "offer_price_allowance_price_moved":
      return "The price changed after this card was written. Ask the agent to set it up again.";
    case "offer_price_allowance_stale":
    case "agent_operation_conflict":
      return "The setup changed after this card was written. Ask the agent to set it up again.";
    case "configuration_draft_waits_on_requester":
      return "Only the person who asked can confirm this change.";
    default:
      return "Pantry could not make this change. Nothing changed. Try again.";
  }
}
