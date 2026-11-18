import type { OrganisationDatabase } from "../database-handles";
import type { ActiveOrganisationMembership } from "../data/control-plane";
import { buildOnboardingProjection } from "../data/onboarding-projection";
import type { OrganisationId } from "../ids";
import { controlJson } from "./http";
import { isRecord } from "@seams/std";
export async function mutationProjectionResponse(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  membership: ActiveOrganisationMembership,
  receipt: { readonly responseStatus: number; readonly responseBody: unknown },
): Promise<Response> {
  if (
    !isRecord(receipt.responseBody) ||
    receipt.responseBody.organisation_id !== organisationId ||
    typeof receipt.responseBody.receipt_id !== "string"
  ) {
    throw new Error("control mutation receipt projection identity is invalid");
  }
  const projection = await buildOnboardingProjection({
    db,
    organisationId,
    membership,
    now: Date.now(),
  });
  if (projection === null) {
    throw new Error("control mutation replay projection is missing");
  }
  return controlJson(
    {
      kind: "success",
      projection,
      receipt: receipt.responseBody,
    },
    receipt.responseStatus,
  );
}
