import {
  parseMailOrganizationCommand,
  parseMailClassificationSelection,
} from "@purin-labs/control-api";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../http";
import {
  mailControlAuthority,
} from "../../mail-inbox/contract/control-authority";
import { authorizeMailSource } from "../../mail-inbox/contract/mail-source-authorization";
import { resolveActiveConnectorActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { gmailConnectorId } from "../../mail-inbox/contract/connector-ids";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type OrganisationId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import type { Env } from "@purin-labs/kernel/env";
export type MailOrganizationRoute = Readonly<{
  kind: "mailOrganization";
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
}>;
export function matchMailOrganizationRoute(
  pathname: string,
): MailOrganizationRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/mail-inbox\/([^/]+)\/organization$/.exec(
      pathname,
    );
  if (match === null) return null;
  const organisationId = parseOrganisationId(match[1] ?? "");
  const accountId = parseIntegrationAccountId(match[2] ?? "");
  return organisationId.ok && accountId.ok
    ? {
        kind: "mailOrganization",
        organisationId: organisationId.value,
        integrationAccountId: accountId.value,
      }
    : null;
}
export async function handleMailOrganizationRoute(
  request: Request,
  env: Env,
  route: MailOrganizationRoute,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    request.method === "GET" ? "viewer" : "admin",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  try {
    const authority = await mailControlAuthority(authorized);
    if (
      authority === null ||
      (await authorizeMailSource(
        env,
        authority,
        route.integrationAccountId,
      )) === null
    )
      return controlError("mail_inbox_not_found", 404);
    const connectorId = gmailConnectorId(route.integrationAccountId);
    if (!connectorId.ok) return controlError("mail_inbox_not_found", 404);
    const connector = await resolveActiveConnectorActor({
      env: env,
      namespace: env.CONNECTOR,
      organisationId: route.organisationId,
      connectorId: connectorId.value,
      now: Date.now(),
    });
    if (!connector.ok)
      return controlError("mail_organization_unavailable", 503);
    const input = {
      identity: {
        organisationId: route.organisationId,
        connectorId: connectorId.value,
      },
      integrationAccountId: route.integrationAccountId,
      authority,
    };
    let result;
    if (request.method === "GET") {
      const messageIds = parseMailClassificationSelection(
        new URL(request.url).searchParams.getAll("messageId"),
      );
      if (messageIds === null)
        return controlError("mail_classification_selection_invalid", 422);
      result = await connector.value.readMailOrganization({
        ...input,
        messageIds,
      });
    } else {
      const command = parseMailOrganizationCommand(
        await readBoundedJsonRecord(request, 16_384),
      );
      if (command === null) return controlError("mail_rules_invalid", 422);
      result = await connector.value.manageMailOrganization({
        ...input,
        command,
      });
    }
    const live = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationId,
      "viewer",
      false,
    );
    if (!live.ok) return controlError("mail_inbox_not_found", 404);
    const currentAuthority = await mailControlAuthority(live);
    if (
      currentAuthority === null ||
      (await authorizeMailSource(
        env,
        currentAuthority,
        route.integrationAccountId,
      )) === null
    )
      return controlError("mail_inbox_not_found", 404);
    if (result.ok) return controlJson(result.value);
    return controlError(
      result.error.code,
      result.error.code === "mail_inbox_not_found" ? 404 : 409,
    );
  } catch {
    return controlError("mail_organization_unavailable", 503);
  }
}
