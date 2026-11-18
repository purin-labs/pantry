import type { CaseBinding } from "@seams/contracts";
import type { Env } from "../env";
import {
  parseCaseId,
  parseIntegrationAccountId,
  type CaseId,
  type IntegrationAccountId,
} from "../ids";
import type { Result } from "../result";
import { resolveActiveCaseActor } from "./actor-router";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";

export type CollaborationSlackThread = Readonly<{
  caseId: CaseId;
  integrationAccountId: IntegrationAccountId;
  conversationId: string;
  threadUrl: string;
}>;

type CollaborationSlackThreadError = Readonly<{
  code: "draft_thread_link_invalid" | "draft_thread_unavailable";
}>;

export async function resolveCollaborationSlackThread(
  env: Env,
  scope: OrganisationExecutionScope,
  value: string,
): Promise<Result<CollaborationSlackThread, CollaborationSlackThreadError>> {
  const target = parseSlackThreadUrl(value);
  if (target === null) return failure("draft_thread_link_invalid");
  const organisationId = scope.organisationId;
  if (!(await scope.isActive())) return failure("draft_thread_unavailable");
  const channels = await scope.database
    .prepare(
      "SELECT workspace_id, integration_account_id FROM organisation_slack_channel WHERE organisation_id = ? AND channel_id = ?",
    )
    .bind(organisationId, target.channelId)
    .all<{
      workspace_id: string;
      integration_account_id: string;
    }>();
  const channel = channels.results[0];
  if (!(await scope.isActive())) return failure("draft_thread_unavailable");
  if (channels.results.length !== 1 || channel === undefined)
    return failure("draft_thread_unavailable");
  const caseId = parseCaseId(
    `case_slack_${channel.workspace_id}_${target.channelId}_${target.threadTs.replace(".", "_")}`,
  );
  const account = parseIntegrationAccountId(channel.integration_account_id);
  if (!caseId.ok || !account.ok) return failure("draft_thread_unavailable");
  const actor = await resolveActiveCaseActor({
    env: env,
    namespace: env.CASE,
    organisationId,
    caseId: caseId.value,
    now: Date.now(),
  });
  if (!actor.ok) return failure("draft_thread_unavailable");
  if (!(await scope.isActive())) return failure("draft_thread_unavailable");
  const snapshot = await actor.value.inspect();
  if (!(await scope.isActive())) return failure("draft_thread_unavailable");
  if (
    !snapshot.ok ||
    snapshot.value.identity.organisationId !== organisationId ||
    snapshot.value.identity.caseId !== caseId.value ||
    !hasSlackThreadBinding(
      snapshot.value.bindings,
      channel.workspace_id,
      target.channelId,
      target.threadTs,
    )
  ) {
    return failure("draft_thread_unavailable");
  }
  return {
    ok: true,
    value: {
      caseId: caseId.value,
      integrationAccountId: account.value,
      conversationId: target.channelId,
      threadUrl: target.threadUrl,
    },
  };
}

function parseSlackThreadUrl(value: string): Readonly<{
  channelId: string;
  threadTs: string;
  threadUrl: string;
}> | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = /^\/archives\/(C[A-Z0-9]+)\/p([0-9]{10})([0-9]{6})$/u.exec(
    url.pathname,
  );
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".slack.com") ||
    match === null
  )
    return null;
  const channelId = match[1];
  const seconds = match[2];
  const micros = match[3];
  if (channelId === undefined || seconds === undefined || micros === undefined)
    return null;
  return {
    channelId,
    threadTs: `${seconds}.${micros}`,
    threadUrl: `${url.origin}${url.pathname}`,
  };
}

function hasSlackThreadBinding(
  bindings: readonly CaseBinding[],
  workspaceId: string,
  channelId: string,
  threadTs: string,
): boolean {
  for (const binding of bindings) {
    if (
      binding.address.kind === "slack" &&
      binding.address.workspaceId === workspaceId &&
      binding.address.channelId === channelId &&
      binding.address.threadTs === threadTs
    )
      return true;
  }
  return false;
}

function failure(
  code: CollaborationSlackThreadError["code"],
): Result<never, CollaborationSlackThreadError> {
  return { ok: false, error: { code } };
}
