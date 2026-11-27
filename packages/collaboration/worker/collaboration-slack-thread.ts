import type { CaseBinding } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseCaseId,
  parseIntegrationAccountId,
  type CaseId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import { resolveActiveCaseActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * The Slack channels of the Organisation that a draft thread link can name
 * (Refactor 17). The Organisation area owns them, and the Worker registers
 * its read (`worker-ports.ts`).
 */
export type OrganisationSlackChannels = Readonly<{
  /** The workspace and the account of each record of a channel. One D1 read. */
  listChannelAccounts(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    channelId: string,
  ): Promise<
    readonly Readonly<{ workspaceId: string; integrationAccountId: string }>[]
  >;
}>;

export const organisationSlackChannels = definePort<OrganisationSlackChannels>(
  "organisation_slack_channels",
);

type CollaborationSlackThread = Readonly<{
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
  const channels = await organisationSlackChannels
    .use()
    .listChannelAccounts(scope.database, organisationId, target.channelId);
  const channel = channels[0];
  if (!(await scope.isActive())) return failure("draft_thread_unavailable");
  if (channels.length !== 1 || channel === undefined)
    return failure("draft_thread_unavailable");
  const caseId = parseCaseId(
    `case_slack_${channel.workspaceId}_${target.channelId}_${target.threadTs.replace(".", "_")}`,
  );
  const account = parseIntegrationAccountId(channel.integrationAccountId);
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
      channel.workspaceId,
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
