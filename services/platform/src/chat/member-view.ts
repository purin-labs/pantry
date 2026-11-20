import { assertNever } from "@purin-labs/std";

import type { RequestAuthority } from "@purin-labs/contracts";
import { authorizeConversation } from "./conversation-access";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import type { AuthorizedConversationScope } from "../organisation-access/access";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { FlowLabel } from "../policy/information-flow";
import { slackChannelIsPublic } from "../policy/information-flow/source-labels";
import { slackSurfaceParts } from "../slack/surface-parts";
import type {
  FlowAudience,
  FlowPolicyOwner,
} from "../policy/information-flow/types";
import type { Variant } from "@purin-labs/type-utils";

/** The member that a view is for, with what is needed to judge a reader. */
export type MemberViewer = Readonly<{
  env: Env;
  organisationId: OrganisationId;
  execution: OrganisationExecutionScope;
  scope: AuthorizedConversationScope;
  authority: Variant<RequestAuthority, "control">;
}>;

/**
 * Whether a member sees content under `label` in the Portal (Plan 27C). The
 * Portal shows a member every record of their Organisation except a record
 * from a private source: another person's own input, a Portal chat that they
 * cannot open, or a private Slack conversation that they are not in. A
 * policy is private only when each of its readers is private, so one reader
 * of the whole Organisation opens it. The label shows when each policy does.
 */
export async function memberMaySee(
  viewer: MemberViewer,
  label: FlowLabel,
): Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  const sees = (reader: FlowAudience): Promise<boolean> => {
    const key = JSON.stringify(reader);
    let decision = seen.get(key);
    if (decision === undefined) {
      decision = readerIsOpen(viewer, reader);
      seen.set(key, decision);
    }
    return decision;
  };
  for (const policy of label.policies) {
    if (!ownedHere(policy.owner, viewer.organisationId)) return false;
    let open = false;
    for (const reader of policy.readers)
      if (await sees(reader)) {
        open = true;
        break;
      }
    if (!open) return false;
  }
  return true;
}

function ownedHere(owner: FlowPolicyOwner, organisationId: string): boolean {
  return owner.kind === "platform" || owner.organisationId === organisationId;
}

async function readerIsOpen(
  viewer: MemberViewer,
  reader: FlowAudience,
): Promise<boolean> {
  switch (reader.kind) {
    // A role, a Case, a schedule, a mailbox and a WhatsApp line belong to
    // the whole Organisation. A Project groups work and hides none of it.
    case "organisation_role":
    case "case":
    case "workflow":
    case "agent_mailbox":
    case "whatsapp_support":
      return true;
    case "project":
      return reader.organisationId === viewer.organisationId;
    case "person":
      return reader.personId === viewer.authority.requesterPersonId;
    case "chat_conversation":
      return (
        reader.organisationId === viewer.organisationId &&
        (await authorizeConversation(
          viewer.execution.database,
          viewer.scope,
          reader.conversationId,
        )) !== null
      );
    case "conversation":
      return slackConversationIsOpen(viewer, reader);
    default:
      return assertNever(reader);
  }
}

/**
 * Whether the member may read a Slack conversation: a public channel of the
 * workspace, or a private one that their linked Slack user is in now. A
 * conversation whose members Pantry cannot read stays hidden.
 */
async function slackConversationIsOpen(
  viewer: MemberViewer,
  reader: Variant<FlowAudience, "conversation">,
): Promise<boolean> {
  const database = viewer.execution.database;
  if (await slackChannelIsPublic(database, viewer.organisationId, reader))
    return true;
  const fact = await slackSurfaceParts
    .use()
    .readConversationFact(
      viewer.env,
      database,
      viewer.organisationId,
      reader.conversationId,
    );
  if (fact?.memberIds === null || fact === null) return false;
  const links = await database
    .prepare(
      `SELECT external_user_id FROM external_identity_link
       WHERE organisation_id = ? AND user_id = ?`,
    )
    .bind(viewer.organisationId, viewer.scope.userId)
    .all<{ external_user_id: string }>();
  const members = new Set(fact.memberIds);
  return links.results.some((link) => members.has(link.external_user_id));
}
