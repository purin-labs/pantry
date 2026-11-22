import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { CAPABILITY_KEYS } from "../../../authorization/capability-catalogue";
import {
  permissionRequiredResponse,
  personPermission,
} from "../../permission-required";
import { controlError } from "../../http";

/**
 * The refusal of a person's direct commerce write that the organisation's
 * policy does not admit. While the capability is switched off, the owner or
 * admin can switch it on from the prompt. A new workspace has no policy
 * snapshot until its first Access change, so the stored mode decides.
 */
export async function capabilitySwitchedOffRefusal(
  scope: OrganisationExecutionScope,
  capabilityId:
    | typeof CAPABILITY_KEYS.commerceListEntryPatch
    | typeof CAPABILITY_KEYS.commerceSavedViewPublish,
  action: "commerce_list_entry_patch" | "commerce_saved_view_patch",
): Promise<Response> {
  const permission = await personPermission(scope, capabilityId, null);
  return permission === null || permission.mode !== "disabled"
    ? controlError(`${action}_forbidden`, 403)
    : permissionRequiredResponse(`${action}_permission_required`, permission);
}

export function commerceActionLedgerError(error: { readonly code: string }): Response {
  switch (error.code) {
    case "action_not_found":
      return controlError(error.code, 404);
    case "action_expired":
    case "action_replay":
    case "resource_busy":
    case "invalid_action_transition":
      return controlError(error.code, 409);
    default:
      return controlError(error.code, 422);
  }
}
