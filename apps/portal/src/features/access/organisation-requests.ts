import {
  parseCreatedOrganisation,
  type CreatedOrganisation,
  type OrganisationCreationRequest,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { controlMutation } from "../../control-client";
import { controlPath } from "../../control-paths";

/**
 * The calls of the setup dialog and the invitation page (Plan 95 step 2).
 * Each one fails with a `ControlApiError` when Pantry refuses, so the page
 * reads the kind of the refusal.
 */

/**
 * Makes the organisation, or answers the organisation that an earlier
 * request with the same operation id made.
 */
export async function createOrganisation(
  request: OrganisationCreationRequest,
): Promise<CreatedOrganisation> {
  const created = parseCreatedOrganisation(
    await controlMutation(
      "/v1/control/organisations",
      "POST",
      request,
      undefined,
      { kind: "prepared", idempotencyKey: request.operationId },
    ),
  );
  if (created === null)
    throw new Error("Pantry did not return the new organisation.");
  return created;
}

export type OrganisationInvitation = Readonly<{
  organisationId: string;
  invitationId: string;
  token: string;
}>;

/** Makes the signed-in person a member through the invitation link. */
export async function acceptOrganisationInvitation(
  invitation: OrganisationInvitation,
): Promise<void> {
  const answer = await controlMutation(
    controlPath(
      invitation.organisationId,
      `invitations/${encodeURIComponent(invitation.invitationId)}/accept`,
    ),
    "POST",
    { token: invitation.token },
  );
  if (!isRecord(answer) || answer.ok !== true || !isRecord(answer.member))
    throw new Error("Pantry did not return the new membership.");
}
