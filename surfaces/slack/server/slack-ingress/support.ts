import { prepareSlackInstallationLifecycleEvent } from "@purin-labs/authority/data/slack-installation-records";
import {
  disconnectSlackInstallation,
  resolveSlackInstallation,
} from "@purin-labs/authority/slack/installation-store";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { resolveConfiguredSlackInstallationIdentity } from "@purin-labs/connections/slack/installation-identity";
import type { Env } from "@purin-labs/kernel/env";
import {
  errorResponse,
  jsonResponse,
} from "@purin-labs/kernel/http";
import type { RequestId } from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";
import { assertNever } from "@purin-labs/std";
import type { OrganisationInstallRecord } from "@purin-labs/tenancy/data/organisation";
import type { Variant } from "@purin-labs/type-utils";

import type {
  SlackEnvelope,
  SlackPayloadError,
} from "../events";

export async function handleSlackInstallationRevoked(
  env: Env,
  event: Variant<SlackEnvelope, "installation_revoked">["event"],
  requestId: RequestId,
  receivedAt: number,
): Promise<Response> {
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (
    !installationIdentity.ok ||
    installationIdentity.value.appId !== event.appId
  ) {
    return errorResponse(
      "slack_installation_identity_mismatch",
      "Slack app identity does not match this deployment.",
      401,
    );
  }
  const installation = await resolveSlackInstallation(env.DB, {
    ...installationIdentity.value,
    workspaceId: event.workspaceId,
  });
  if (installation.kind !== "existing") {
    return installation.kind === "available"
      ? jsonResponse({ ok: true, requestId, ignored: "installation_missing" })
      : errorResponse(
          "slack_installation_corrupt",
          "Slack installation state is unavailable.",
          503,
        );
  }
  if (installation.lifecycle !== "revoked") {
    const disconnected = await disconnectSlackInstallation({
      env,
      installationId: installation.installationId,
      disconnectedAt: event.occurredAt,
    });
    if (!disconnected.ok) {
      return errorResponse(
        disconnected.error.code,
        "Slack installation revocation could not be recorded.",
        503,
      );
    }
  }
  await prepareSlackInstallationLifecycleEvent(env.DB, {
    eventId: event.eventId,
    installationId: installation.installationId,
    reason: event.reason,
    occurredAt: event.occurredAt,
    recordedAt: receivedAt,
  }).run();
  traceLog("integration_gateway.slack.installation_revoked", {
    requestId,
    workspace_id: event.workspaceId,
    event_id: event.eventId,
    reason: event.reason,
  });
  return jsonResponse({ ok: true, requestId, revoked: event.reason });
}

export async function ensureOrganisationObject(
  env: Env,
  install: OrganisationInstallRecord,
): Promise<void> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: install.organisationId,
    now: install.installedAt,
  });

  await organisation.ensureOrganisation({
    organisationId: install.organisationId,
    name: install.name,
    plan: install.plan,
    status: install.organisationStatus,
    createdAt: install.installedAt,
  });
}

export function identityLinkBrowserUrl(env: Env, token: string): string {
  return `${env.PANTRY_PUBLIC_ORIGIN.replace(/\/$/u, "")}/identity/link?token=${token}`;
}

export function slackPayloadErrorResponse(error: SlackPayloadError): Response {
  switch (error.code) {
    case "invalid_json":
      return errorResponse(error.code, "Slack body is not valid JSON.", 400);
    case "object_required":
      return errorResponse(
        error.code,
        "Slack body must be a JSON object.",
        400,
      );
    case "missing_field":
      return errorResponse(
        error.code,
        `Slack body is missing field: ${error.field}.`,
        400,
      );
    case "invalid_field":
      return errorResponse(
        error.code,
        `Slack body has invalid field: ${error.field}.`,
        400,
      );
    default:
      return assertNever(error);
  }
}
