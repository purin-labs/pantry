import { sha256Hex } from "@purin-labs/std";
import {
  OPERATOR_DRAFT_TTL_MS,
  type ProposalStaging,
  type ProposalTurn,
} from "../../actors/session/proposal-staging";
import { requireSessionExecution } from "../../actors/session-execution-admission";
import {
  createOperatorConfigurationDraft,
  type OperatorConfigurationDraft,
} from "../../data/operator-configuration-draft";

/**
 * What the staging of a configuration draft needs from outside the
 * Organisation area. The Worker gives each part.
 */
export type ConfigurationDraftPorts = Readonly<{
  /**
   * Fills in the reference that a command is measured from, when the command
   * names a record and carries none. Another command comes back as it is.
   */
  bindReference(rawCommand: unknown): Promise<unknown>;
  /** The words of one command for a person. */
  present(
    command: OperatorConfigurationDraft["command"],
  ): Readonly<{ actionLabel: string; summary: string }>;
  /** The short code that a person types to confirm a command. */
  previewCode(commandDigest: string): string;
}>;

/**
 * Writes one draft and returns the exact words that will confirm it.
 *
 * The reply matcher accepts only "<action label> <code>", so the model has
 * to be told both; returning a summary the operator could paraphrase would
 * produce a confirmation that never settles.
 */
export async function stageConfigurationDraft(
  input: ProposalTurn,
  ports: ConfigurationDraftPorts,
  staging: Pick<
    ProposalStaging,
    "caseId" | "actorPersonId" | "actorUserId" | "now"
  >,
  rawCommandInput: unknown,
  extra: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  // A price allowance is measured from a reference price. Capturing the
  // Offer's revision and price at staging binds the preview to what the
  // operator is shown; confirmation then refuses if the price has moved
  // since, instead of silently measuring the band from a price nobody
  // approved.
  await requireSessionExecution(input.execution, input.lease);
  const rawCommand = await ports.bindReference(rawCommandInput);
  const digest = await sha256Hex(JSON.stringify(rawCommand));
  // The id carries the attempt, not only the content: a change staged again
  // after an earlier draft of it was decided must get a fresh row, and the
  // store returns the pending twin itself when one is still open.
  const draftId = `draft_agent_${input.assignment.assignmentId}_${digest.slice(0, 16)}_${staging.now.toString(36)}`;
  const created = await createOperatorConfigurationDraft({
    scope: input.execution.scope,
    authorizeCommit: requireSessionExecution.bind(
      null,
      input.execution,
      input.lease,
    ),
    draftId,
    caseId: staging.caseId,
    actorUserId: staging.actorUserId,
    actorPersonId: staging.actorPersonId,
    rawCommand,
    mutationId: `mutation_${draftId}`,
    now: staging.now,
    expiresAt: staging.now + OPERATOR_DRAFT_TTL_MS,
  });
  if (!created.ok) {
    throw new Error(`configuration draft refused: ${created.error.code}`);
  }
  await requireSessionExecution(input.execution, input.lease);
  const presented = ports.present(created.value.command);
  // A Portal chat has a card for this draft; Slack has only the reply.
  const confirmation =
    input.lease.requestAuthority.kind === "control"
      ? {
          confirmOn:
            "The person who asked confirms this on the card in this chat. Nothing has changed yet.",
        }
      : {
          confirmWith: `${presented.actionLabel} ${ports.previewCode(created.value.commandDigest)}`,
        };
  return {
    kind: "configuration_drafted",
    draftId,
    summary: presented.summary,
    ...confirmation,
    ...extra,
  };
}
