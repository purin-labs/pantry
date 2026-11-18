import {
  parseContactVerificationCommand,
  publishContactVerification,
} from "../../data/contact-verification";
import type { Env } from "../../env";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../http";
import { requireActiveOrganisationActorAtPlacement } from "../../actors/actor-router";

export async function handleContactVerification(
  request: Request,
  env: Env,
  organisationId: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationId,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readBoundedJsonRecord(request, 16_384);
  const command = parseContactVerificationCommand(body);
  if (command === null)
    return controlError("contact_verification_invalid", 422);
  try {
    const result = await publishContactVerification({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
      actorId: authorized.authenticated.session.userId,
      command,
      now: Date.now(),
    });
    if (result.ok) {
      const organisation = await requireActiveOrganisationActorAtPlacement({
        env,
        placement: authorized.executionScope.placement,
        organisationId: authorized.organisationId,
        now: Date.now(),
      });
      await organisation.invalidateCaseContextCollectionVerification({
        organisationId: authorized.organisationId,
        verificationId: command.verificationId,
        revision: result.value.revision,
      });
    }
    return result.ok
      ? controlJson(result)
      : controlError(result.error.code, 409);
  } catch {
    return controlError("contact_verification_unavailable", 503);
  }
}
