import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { traceWarn } from "@purin-labs/kernel/observability";

import type { Env } from "@purin-labs/kernel/env";
import {
  newRequestId,
  parseOrganisationId,
  parseWorkspaceId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  audiencesForDestination,
  policyAllowsAudiences,
  policyLevel,
  type FlowLabel,
} from "@purin-labs/authority/policy/information-flow/index";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { resolveActiveSlackPhysicalInstallationCredential } from "@purin-labs/authority/credential-vault/surface-installation-resolution";
import { resolveConfiguredSlackInstallationIdentity } from "@purin-labs/connections/slack/installation-identity";
import type { SlackConversationFact } from "@purin-labs/authority/slack/surface-parts";
import type { RequestAuthority } from "@purin-labs/contracts";
import { isRecord } from "@purin-labs/std";

/** What Slack says about one conversation, read at most once in this time. */
const FACT_MAX_AGE_MS = 5 * 60 * 1000;
const MEMBER_PAGE_LIMIT = 200;
const MEMBER_PAGES = 5;


/**
 * Reads the facts of a connected conversation, from Slack when the stored
 * ones are old. If Slack does not answer, the old facts stay in use. Null
 * means that Pantry has never had an answer, so nothing is known.
 */
export async function readSlackConversationFact(
  env: Env,
  database: OrganisationDatabase,
  organisationId: OrganisationId,
  channelId: string,
): Promise<SlackConversationFact | null> {
  const stored = await database
    .prepare(
      `SELECT is_private, reaches_outside, member_ids_json, read_at
       FROM slack_conversation_fact
       WHERE organisation_id = ? AND channel_id = ?`,
    )
    .bind(organisationId, channelId)
    .first<{
      is_private: number;
      reaches_outside: number;
      member_ids_json: string | null;
      read_at: number;
    }>();
  const now = Date.now();
  const known =
    stored === null
      ? null
      : {
          isPrivate: stored.is_private === 1,
          reachesOutside: stored.reaches_outside === 1,
          memberIds: parseMemberIds(stored.member_ids_json),
        };
  if (stored !== null && now - stored.read_at < FACT_MAX_AGE_MS) return known;
  const fresh = await fetchSlackConversationFact(
    env,
    database,
    organisationId,
    channelId,
  );
  if (fresh === null) return known;
  await database
    .prepare(
      `INSERT INTO slack_conversation_fact
         (organisation_id, channel_id, is_private, reaches_outside, member_ids_json, read_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id, channel_id) DO UPDATE SET
         is_private = excluded.is_private,
         reaches_outside = excluded.reaches_outside,
         member_ids_json = excluded.member_ids_json,
         read_at = excluded.read_at`,
    )
    .bind(
      organisationId,
      channelId,
      fresh.isPrivate ? 1 : 0,
      fresh.reachesOutside ? 1 : 0,
      fresh.memberIds === null ? null : JSON.stringify(fresh.memberIds),
      now,
    )
    .run();
  return fresh;
}

/**
 * Whether a delivery of this label to this conversation reaches people of
 * another company, when that matters. Content that names the destination goes
 * back to it, and private content from elsewhere stops at the exit, so only
 * internal content from elsewhere needs the answer. An ordinary turn in a
 * channel makes no read here. A conversation with no known answer counts as
 * outside, so a Slack failure cannot send internal content out.
 */
export async function slackConversationReachesOutside(
  env: Env,
  authority: RequestAuthority,
  label: FlowLabel,
  channelId: string,
): Promise<boolean> {
  const audiences = audiencesForDestination(authority);
  const foreignInternal = label.policies.some(
    (policy) =>
      policy.owner.kind !== "recipient_constraint" &&
      !policyAllowsAudiences(policy, audiences) &&
      policyLevel(policy) === "internal",
  );
  if (!foreignInternal) return false;
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok) return true;
  const scope = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!scope.ok) return true;
  const fact = await readSlackConversationFact(
    env,
    scope.value.database,
    organisationId.value,
    channelId,
  );
  return fact === null ? true : fact.reachesOutside;
}

async function fetchSlackConversationFact(
  env: Env,
  database: OrganisationDatabase,
  organisationId: OrganisationId,
  channelId: string,
): Promise<SlackConversationFact | null> {
  const token = await slackBotToken(env, database, organisationId, channelId);
  if (token === null) return null;
  try {
    const info = await slackGet(token, "conversations.info", {
      channel: channelId,
    });
    if (info === null || !isRecord(info.channel)) return null;
    const isPrivate = info.channel.is_private === true;
    return {
      isPrivate,
      reachesOutside: info.channel.is_ext_shared === true,
      memberIds: isPrivate ? await slackMembers(token, channelId) : null,
    };
  } catch (error) {
    traceWarn("slack.conversation_fact_failed", {
      requestId: newRequestId(),
      organisation_id: organisationId,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

async function slackMembers(
  token: string,
  channelId: string,
): Promise<readonly string[] | null> {
  const members: string[] = [];
  let cursor = "";
  for (let page = 0; page < MEMBER_PAGES; page += 1) {
    const answer = await slackGet(token, "conversations.members", {
      channel: channelId,
      limit: String(MEMBER_PAGE_LIMIT),
      ...(cursor === "" ? {} : { cursor }),
    });
    if (answer === null || !Array.isArray(answer.members)) return null;
    for (const member of answer.members)
      if (typeof member === "string") members.push(member);
    cursor =
      isRecord(answer.response_metadata) &&
      typeof answer.response_metadata.next_cursor === "string"
        ? answer.response_metadata.next_cursor
        : "";
    if (cursor === "") return members;
  }
  return null;
}

async function slackGet(
  token: string,
  method: "conversations.info" | "conversations.members",
  parameters: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, unknown>> | null> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(name, value);
  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const answer: unknown = await response.json();
  return isRecord(answer) && answer.ok === true ? answer : null;
}

async function slackBotToken(
  env: Env,
  database: OrganisationDatabase,
  organisationId: OrganisationId,
  channelId: string,
): Promise<string | null> {
  const channel = await database
    .prepare(
      `SELECT workspace_id FROM organisation_slack_channel
       WHERE organisation_id = ? AND channel_id = ?`,
    )
    .bind(organisationId, channelId)
    .first<{ workspace_id: string }>();
  if (channel === null) return null;
  const workspaceId = parseWorkspaceId(channel.workspace_id);
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!workspaceId.ok || !installationIdentity.ok) return null;
  const credential = await resolveActiveSlackPhysicalInstallationCredential({
    env,
    keys: env,
    installationIdentity: installationIdentity.value,
    workspaceId: workspaceId.value,
  });
  return credential.ok && credential.value.kind === "bearer"
    ? credential.value.value
    : null;
}

function parseMemberIds(raw: string | null): readonly string[] | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) && parsed.every((id) => typeof id === "string")
    ? parsed
    : null;
}
