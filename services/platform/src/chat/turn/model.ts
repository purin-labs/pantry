import {
  selectOrganisationChatModel,
  organisationChatModelOptions,
  type OrganisationModelRoute,
} from "../../models/route";
import type { Conversation } from "../conversation";
import type { ChatEffort } from "@seams/control-api";

// The same default as the Portal composer: medium, "Balanced", when offered.
export function defaultChatEffort(route: OrganisationModelRoute): ChatEffort {
  const options =
    organisationChatModelOptions(route).find(
      modelOptionHasId.bind(null, route.model),
    )?.capabilities.effortOptions ?? [];
  return options.includes("medium") ? "medium" : (options[0] ?? "medium");
}

export function modelOptionHasId(
  id: string,
  option: { readonly id: string },
): boolean {
  return option.id === id;
}

export function selectStoredConversationModel(
  workspace: OrganisationModelRoute,
  conversation: Conversation,
): ReturnType<typeof selectOrganisationChatModel> {
  const stored = conversation.modelRoute;
  if (
    stored.keySource !== workspace.keySource ||
    stored.provider !== workspace.provider
  )
    return { ok: true, value: workspace };
  return selectOrganisationChatModel(workspace, stored.model);
}

export function conversationUsesInferenceSource(
  conversation: Conversation,
  workspace: OrganisationModelRoute,
): boolean {
  const stored = conversation.modelRoute;
  return (
    stored.keySource === workspace.keySource &&
    stored.provider === workspace.provider
  );
}
