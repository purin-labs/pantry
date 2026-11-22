import { authorizeMailAssistant } from "../../mail-inbox/assistant-eligibility";
import { parseMailAssistantCommand } from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  parseIntegrationAccountId,
  type OrganisationId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "@purin-labs/control/worker/http";
import {
  mailControlAuthority,
} from "../../mail-inbox/contract/control-authority";
import { authorizeMailSource } from "../../mail-inbox/contract/mail-source-authorization";
import { gmailConnectorId } from "../../mail-inbox/contract/connector-ids";
import { resolveActiveConnectorActor } from "@purin-labs/actor-runtime/actors/actor-router";

export type MailAssistantRoute = Readonly<{
  kind: "mailAssistant";
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
}>;
export function matchMailAssistantRoute(
  pathname: string,
): MailAssistantRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/mail-inbox\/([^/]+)\/assistant$/.exec(
      pathname,
    );
  if (match === null) return null;
  const organisation = parseOrganisationId(match[1] ?? "");
  const account = parseIntegrationAccountId(match[2] ?? "");
  return organisation.ok && account.ok
    ? {
        kind: "mailAssistant",
        organisationId: organisation.value,
        integrationAccountId: account.value,
      }
    : null;
}
export async function handleMailAssistantRoute(
  request: Request,
  env: Env,
  route: MailAssistantRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "viewer",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  try {
    const authority = await mailControlAuthority(authorized);
    const source =
      authority === null
        ? null
        : await authorizeMailSource(env, authority, route.integrationAccountId);
    if (authority === null || source === null)
      return controlError("mail_inbox_not_found", 404);
    const command =
      request.method === "POST"
        ? parseMailAssistantCommand(await readBoundedJsonRecord(request, 8192))
        : null;
    if (request.method === "POST" && command === null)
      return controlError("mail_assistant_request_invalid", 422);
    const connectorId = gmailConnectorId(route.integrationAccountId);
    if (!connectorId.ok) return controlError("mail_inbox_not_found", 404);
    const connector = await resolveActiveConnectorActor({
      env: env,
      namespace: env.CONNECTOR,
      organisationId: route.organisationId,
      connectorId: connectorId.value,
      now: Date.now(),
    });
    if (!connector.ok) return controlError("mail_assistant_unavailable", 503);
    const result = await connector.value.mailAssistant({
      identity: {
        organisationId: route.organisationId,
        connectorId: connectorId.value,
      },
      integrationAccountId: route.integrationAccountId,
      authority,
      command,
      controlSessionId: authorized.authenticated.session.controlSessionId,
    });
    const live = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "viewer",
      false,
    );
    if (!live.ok) return controlError("mail_inbox_not_found", 404);
    const currentAuthority = await mailControlAuthority(live);
    const currentSource =
      currentAuthority === null
        ? null
        : await authorizeMailSource(
            env,
            currentAuthority,
            route.integrationAccountId,
          );
    if (currentSource === null || currentSource.sourcePin !== source.sourcePin)
      return controlError("mail_inbox_not_found", 404);
    if (command !== null && result.ok) {
      const processing = await authorizeMailAssistant(env, {
        identity: {
          organisationId: route.organisationId,
          connectorId: connectorId.value,
        },
        integrationAccountId: route.integrationAccountId,
        authority,
      });
      if (
        !processing.ok ||
        processing.value.modelRouteDigest !== command.modelRouteDigest
      )
        return controlError("mail_assistant_authority_changed", 409);
    }
    return result.ok
      ? controlJson(result.value)
      : controlError(
          result.error.code,
          result.error.code === "mail_inbox_not_found" ? 404 : 409,
        );
  } catch {
    return controlError("mail_assistant_unavailable", 503);
  }
}
