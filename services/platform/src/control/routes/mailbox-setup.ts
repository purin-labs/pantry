import { parseMailboxSetupAgentChoice } from "@purin-labs/control-api";

import type { Env } from "../../env";
import { parseIntegrationAccountId } from "../../ids";
import { readMailboxSetupPlan } from "../../mail-inbox/mailbox-setup";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";

/**
 * What a connected mailbox still needs before its agent writes a reply.
 *
 * The read is for a person who can make the changes it names, so it asks for
 * the role that each of those changes asks for.
 */
export async function handleAgentMailboxSetup(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const accountId = parseIntegrationAccountId(integrationAccountIdRaw);
  if (!accountId.ok) return controlError("agent_mailbox_not_connected", 404);
  const choice = parseMailboxSetupAgentChoice(
    new URL(request.url).searchParams.get("agent"),
  );
  if (choice === null) return controlError("mailbox_setup_invalid", 422);
  const plan = await readMailboxSetupPlan({
    env,
    scope: authorized.executionScope,
    integrationAccountId: accountId.value,
    choice,
    requesterRole: authorized.membership.role,
    now: Date.now(),
  });
  if (plan.ok) return controlJson({ ok: true, setup: plan.value });
  switch (plan.error.code) {
    case "agent_mailbox_not_connected":
      return controlError(plan.error.code, 404);
    case "mailbox_setup_agent_unavailable":
      return controlError(plan.error.code, 409);
    case "mailbox_setup_unavailable":
      return controlError(plan.error.code, 503);
  }
}
