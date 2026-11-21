import { runtimeFetch } from "../../../runtime-fetch";
import type { Env } from "../../../env";
import { resolveActiveSlackOrganisationCredential } from "../../../credential-vault";
import {
  prepareControlMutationReceipt,
  readControlMutationReplay,
  prepareControlMutationReceiptCompletion,
} from "../../../data/control-mutation";
import {
  parseChannelId,
  parseSlackInstallationId,
  parseSlackOrganisationConnectionId,
  parseOrganisationId,
  parseWorkspaceId,
  type OrganisationId,
} from "../../../ids";
import { configuredValue } from "../../../provider-adapters/authorization";
import { uninstallSlackApplication } from "../../../provider-adapters/slack";
import {
  admitControlMutation,
  admitUserMutation,
  controlMutationIdentity,
  controlMutationScope,
  parseMutationBoundary,
  resolveMutationUser,
} from "../../admission/control-mutation";
import { authorizeOrganisationRequest } from "../../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../../http";
import {
  configureSlackChannelDefault,
  userMayChangeSlackChannelDefault,
  userMayDisconnectSlackInstallation,
  disconnectSlackInstallation,
  listSlackOrganisationRouting,
  prepareSlackRoutingAuditEvent,
  slackDmSelection,
  type SlackChannelDefaultChange,
} from "../../../slack/installation-store";
import { resolveConfiguredSlackInstallationIdentity } from "../../../slack/installation-identity";
import { isPositiveInteger, isRecord } from "@purin-labs/std";
import {
  prepareSlackDmSelectionAuditEvent,
  prepareSlackInstallationDisconnectAuditEvent,
} from "../../../data/slack-installation-records";
import {
  findSlackInstallationRouting,
  grantSlackChannelBaseline,
} from "../../../slack/channel-baseline-grant";

export async function handleSlackRouting(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const connections = await listSlackOrganisationRouting(
    env.DB,
    authorized.organisationId,
  );
  return controlJson({ ok: true, connections });
}

export async function handleSlackChannelDefault(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  installationIdRaw: string,
  channelIdRaw: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const installationId = parseSlackInstallationId(installationIdRaw);
  const channelId = parseChannelId(channelIdRaw);
  if (!installationId.ok || !channelId.ok) {
    return controlError("slack_channel_default_target_invalid", 404);
  }
  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("slack_channel_default_request_invalid", 422);
  }
  const identity = await resolveMutationUser(
    env,
    authorized.authenticated.session.userId,
  );
  if (identity instanceof Response) return identity;
  const change = parseSlackChannelDefaultChange({
    body: body.value,
    sourceOrganisationId: authorized.organisationId,
    installationId: installationId.value,
    channelId: channelId.value,
    userId: identity.userId,
    changedAt: Date.now(),
  });
  if (change === null) {
    return controlError("slack_channel_default_request_invalid", 422);
  }
  const admitted = await admitControlMutation({
    request,
    authorized,
    body: body.value,
    boundary: "unversioned",
    route: `/v1/control/organisations/${authorized.organisationId}/slack-routing/installations/${installationId.value}/channels/${channelId.value}`,
    operation: "slack.channel_default.change",
    db: env.DB,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope } = admitted;
  if (
    !(await userMayChangeSlackChannelDefault(env, {
      userId: identity.userId,
      change,
    }))
  ) {
    return controlError("slack_channel_default_authority_missing", 403);
  }
  const configured = await configureSlackChannelDefault(env.DB, change);
  if (!configured.ok) return controlError(configured.error.code, 409);
  // A channel Café posts in gets the baseline grants of its conversation,
  // as the setup channel does. The binding changes neither the setup nor the
  // workspace's lifecycle, so adding a channel keeps an active workspace on.
  if (configured.value.organisationId === authorized.organisationId) {
    const granted = await grantSlackChannelBaseline(
      env,
      authorized.executionScope,
      configured.value,
    );
    if (!granted) return controlError("slack_channel_grant_failed", 409);
  }
  const mutationIdentity = await controlMutationIdentity(
    request,
    identity,
    change.changedAt,
  );
  const responseBody = {
    kind: "success",
    channelDefault: configured.value,
    receipt: { receiptId: mutationIdentity.receiptId },
  };
  await env.DB.batch([
    prepareControlMutationReceipt(env.DB, {
      scope,
      boundary,
      identity: mutationIdentity,
      responseStatus: 200,
      responseBody,
    }),
    prepareSlackRoutingAuditEvent(env.DB, {
      change,
      revision: configured.value.revision,
      nextConnectionId: configured.value.connectionId,
      mutationIdentity,
    }),
  ]);
  return controlJson(responseBody);
}

export async function handleSlackDmSelection(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  installationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const installationId = parseSlackInstallationId(installationIdRaw);
  if (!installationId.ok) {
    return controlError("slack_installation_not_found", 404);
  }
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("slack_dm_selection_request_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/slack-routing/installations/${installationId.value}/dm-selection`,
    operation: "slack.dm_organisation.select",
    db: env.DB,
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const routing = await listSlackOrganisationRouting(
    env.DB,
    authorized.organisationId,
  );
  const connection = findSlackInstallationRouting(
    routing,
    installationId.value,
  );
  if (connection === null || connection.lifecycle !== "active") {
    return controlError("slack_installation_not_found", 404);
  }
  const selectedAt = Date.now();
  const selected = await slackDmSelection.use().selectOrganisation(env, {
    installationId: installationId.value,
    destinationConnectionId: connection.connectionId,
    destinationOrganisationId: authorized.organisationId,
    userId: identity.userId,
    selectedAt,
  });
  if (!selected.ok) return controlError(selected.error.code, 403);
  const mutationIdentity = await controlMutationIdentity(
    request,
    identity,
    selectedAt,
  );
  const responseBody = {
    kind: "success",
    installationId: installationId.value,
    revision: selected.value.revision,
    receipt: { receiptId: mutationIdentity.receiptId },
  };
  await env.DB.batch([
    prepareControlMutationReceipt(env.DB, {
      scope,
      boundary,
      identity: mutationIdentity,
      responseStatus: 200,
      responseBody,
    }),
    prepareSlackDmSelectionAuditEvent(env.DB, {
      auditEventId: mutationIdentity.auditEventId,
      installationId: installationId.value,
      externalUserId: selected.value.externalUserId,
      connectionId: connection.connectionId,
      revision: selected.value.revision,
      actorUserId: identity.userId,
      receiptId: mutationIdentity.receiptId,
      occurredAt: selectedAt,
    }),
  ]);
  return controlJson(responseBody);
}

export async function handleDisconnectSlackInstallation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  installationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const installationId = parseSlackInstallationId(installationIdRaw);
  if (!installationId.ok) {
    return controlError("slack_installation_not_found", 404);
  }
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("slack_installation_disconnect_request_invalid", 422);
  }
  const boundary = await parseMutationBoundary(
    request,
    body.value,
    "unversioned",
  );
  if (boundary instanceof Response) return boundary;
  const identity = await resolveMutationUser(
    env,
    authorized.authenticated.session.userId,
  );
  if (identity instanceof Response) return identity;
  const scope = controlMutationScope(
    authorized,
    `/v1/control/organisations/${authorized.organisationId}/slack-routing/installations/${installationId.value}/disconnect`,
    "slack.installation.disconnect",
  );
  // A disconnect that waits on its cleanup (202) runs again on a retry.
  const replay = await readControlMutationReplay({
    db: env.DB,
    scope,
    boundary,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "replay" && replay.receipt.responseStatus !== 202) {
    return controlJson(
      replay.receipt.responseBody,
      replay.receipt.responseStatus,
    );
  }
  const now = Date.now();
  const proposedIdentity = await controlMutationIdentity(
    request,
    identity,
    now,
  );
  let cleanupReceiptId: string;
  let cleanupAuditEventId: string;
  let disconnectedAt: number;
  if (replay.kind === "replay") {
    const pending = replay.receipt.responseBody;
    if (
      !isRecord(pending) ||
      pending.kind !== "provider_removed" ||
      pending.installationId !== installationId.value ||
      typeof pending.receiptId !== "string" ||
      typeof pending.auditEventId !== "string" ||
      typeof pending.disconnectedAt !== "number" ||
      !Number.isSafeInteger(pending.disconnectedAt)
    ) {
      return controlError("slack_installation_disconnect_receipt_invalid", 409);
    }
    cleanupReceiptId = pending.receiptId;
    cleanupAuditEventId = pending.auditEventId;
    disconnectedAt = pending.disconnectedAt;
  } else {
    const permitted = await userMayDisconnectSlackInstallation(env, {
      userId: identity.userId,
      installationId: installationId.value,
    });
    if (!permitted) {
      return controlError(
        "slack_installation_disconnect_authority_missing",
        403,
      );
    }
    const routing = await listSlackOrganisationRouting(
      env.DB,
      authorized.organisationId,
    );
    const connection = findSlackInstallationRouting(
      routing,
      installationId.value,
    );
    const installationIdentity = resolveConfiguredSlackInstallationIdentity({
      deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
      appId: env.SLACK_APP_ID,
    });
    const workspaceId =
      connection === null ? null : parseWorkspaceId(connection.workspaceId);
    if (
      connection === null ||
      !installationIdentity.ok ||
      workspaceId === null ||
      !workspaceId.ok
    ) {
      return controlError("slack_installation_not_found", 404);
    }
    const credential = await resolveActiveSlackOrganisationCredential({
      env,
      keys: env,
      installationIdentity: installationIdentity.value,
      organisationId: authorized.organisationId,
      integrationAccountId: connection.integrationAccountId,
      workspaceId: workspaceId.value,
    });
    const clientId = configuredValue(env.SLACK_CLIENT_ID);
    const clientSecret = configuredValue(env.SLACK_CLIENT_SECRET);
    if (
      !credential.ok ||
      credential.value.kind !== "bearer" ||
      clientId === null ||
      clientSecret === null
    ) {
      return controlError("provider_cleanup_credential_unavailable", 409);
    }
    const uninstalled = await uninstallSlackApplication({
      fetcher: runtimeFetch,
      token: credential.value.value,
      clientId,
      clientSecret,
    });
    if (uninstalled.kind !== "removed") {
      return controlError(
        uninstalled.reason,
        uninstalled.kind === "retryable_failure" ? 503 : 409,
      );
    }
    cleanupReceiptId = proposedIdentity.receiptId;
    cleanupAuditEventId = proposedIdentity.auditEventId;
    disconnectedAt = now;
    await prepareControlMutationReceipt(env.DB, {
      scope,
      boundary,
      identity: proposedIdentity,
      responseStatus: 202,
      responseBody: {
        kind: "provider_removed",
        installationId: installationId.value,
        receiptId: cleanupReceiptId,
        auditEventId: cleanupAuditEventId,
        disconnectedAt,
      },
    }).run();
  }
  const disconnected = await disconnectSlackInstallation({
    env,
    installationId: installationId.value,
    disconnectedAt,
  });
  if (!disconnected.ok) return controlError(disconnected.error.code, 409);
  const responseBody = {
    kind: "success",
    installationId: installationId.value,
    disconnectedConnectionCount: disconnected.value.disconnectedConnectionCount,
    receipt: { receiptId: cleanupReceiptId },
  };
  await env.DB.batch([
    prepareControlMutationReceiptCompletion(env.DB, {
      receiptId: cleanupReceiptId,
      requestHash: boundary.requestHash,
      responseBody,
    }),
    prepareSlackInstallationDisconnectAuditEvent(env.DB, {
      auditEventId: cleanupAuditEventId,
      installationId: installationId.value,
      actorUserId: identity.userId,
      receiptId: cleanupReceiptId,
      occurredAt: now,
    }),
  ]);
  return controlJson(responseBody);
}

function parseSlackChannelDefaultChange(input: {
  readonly body: JsonRecord;
  readonly sourceOrganisationId: OrganisationId;
  readonly installationId: SlackChannelDefaultChange["installationId"];
  readonly channelId: SlackChannelDefaultChange["channelId"];
  readonly userId: SlackChannelDefaultChange["boundByUserId"];
  readonly changedAt: number;
}): SlackChannelDefaultChange | null {
  const destinationOrganisationId =
    typeof input.body.destinationOrganisationId === "string"
      ? parseOrganisationId(input.body.destinationOrganisationId)
      : null;
  const destinationConnectionId =
    typeof input.body.destinationConnectionId === "string"
      ? parseSlackOrganisationConnectionId(input.body.destinationConnectionId)
      : null;
  if (
    destinationOrganisationId === null ||
    !destinationOrganisationId.ok ||
    destinationConnectionId === null ||
    !destinationConnectionId.ok
  ) {
    return null;
  }
  const common = {
    installationId: input.installationId,
    channelId: input.channelId,
    destinationConnectionId: destinationConnectionId.value,
    destinationOrganisationId: destinationOrganisationId.value,
    boundByUserId: input.userId,
    changedAt: input.changedAt,
  };
  if (input.body.kind === "bind_unbound") {
    return destinationOrganisationId.value === input.sourceOrganisationId
      ? { kind: "bind_unbound", ...common }
      : null;
  }
  return input.body.kind === "replace" &&
    isPositiveInteger(input.body.expectedRevision)
    ? {
        kind: "replace",
        ...common,
        sourceOrganisationId: input.sourceOrganisationId,
        expectedRevision: input.body.expectedRevision,
      }
    : null;
}
