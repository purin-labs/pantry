import type { RequestAuthority } from "@purin-labs/contracts";
import type {
  RequestableCapability,
  RequestableEntityTypeRead,
} from "../authorization/requestable-capabilities";
import type { AgentPermissionRequest } from "../data/agent-permission-request";
import type {
  HeldOutputReason,
  HeldOutputRequest,
} from "../data/held-output-request";
import type { OrganisationDatabase } from "../database-handles";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { FlowLabel } from "../policy/information-flow";
import { definePort } from "../port";

/**
 * Slack's answer about one conversation. `memberIds` is null for a public
 * channel, which needs no list, and for a conversation whose members Pantry
 * could not read.
 */
export type SlackConversationFact = Readonly<{
  isPrivate: boolean;
  reachesOutside: boolean;
  memberIds: readonly string[] | null;
}>;

/**
 * The Slack parts that the foundation and the areas ask for (Refactor 17):
 * the texts of the Slack cards of a held answer, a held step and a
 * permission request, the reply of an agent after such a card, the facts of
 * a Slack conversation, the check if a Slack channel reaches people outside,
 * and the hand-over of a decision to its Slack thread. The Slack surface
 * owns them, and the Worker registers them (`worker-ports.ts`).
 */
export type SlackSurfaceParts = Readonly<{
  /** The card text of an answer that waits for approval. */
  heldOutputNoticeText(reason: HeldOutputReason): string;
  /** The card text of a step that waits for approval. */
  heldEffectNoticeText(reason: HeldOutputReason): string;
  /** The card text of a permission request. */
  permissionRequestNoticeText(
    capabilityIds: readonly RequestableCapability[],
    entityTypeReads: readonly RequestableEntityTypeRead[],
  ): string;
  /** The words of a tool result for the reply after a card. */
  cardOnlyReplyInstruction: string;
  /**
   * What Slack says about one conversation, from Slack when the stored facts
   * are old. Null means that nothing is known.
   */
  readConversationFact(
    env: Env,
    database: OrganisationDatabase,
    organisationId: OrganisationId,
    channelId: string,
  ): Promise<SlackConversationFact | null>;
  /** Whether a Slack channel reaches people outside for a label. */
  conversationReachesOutside(
    env: Env,
    authority: RequestAuthority,
    label: FlowLabel,
    channelId: string,
  ): Promise<boolean>;
  /** Hands a decided permission request to its asking turn. */
  releaseAgentPermissionDecision(
    env: Env,
    scope: OrganisationExecutionScope,
    stored: AgentPermissionRequest,
  ): Promise<boolean>;
  /** Hands a decided held answer or step to its thread. */
  releaseHeldOutputDecision(
    env: Env,
    scope: OrganisationExecutionScope,
    stored: HeldOutputRequest,
  ): Promise<boolean>;
}>;

export const slackSurfaceParts = definePort<SlackSurfaceParts>(
  "slack_surface_parts",
);
