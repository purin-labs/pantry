import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  parseSlackProposalRow,
  type SlackSideCaseProposal,
} from "../slack/side-cases";
import { parseProposalRow, type SideCaseProposal } from "./side-cases";

/** The proposal that started a side Case, in a Portal chat or a Slack thread. */
export type SideCaseOrigin =
  | Readonly<{ kind: "portal_chat"; proposal: SideCaseProposal }>
  | Readonly<{ kind: "slack_thread"; proposal: SlackSideCaseProposal }>;

/**
 * The proposal that started this Case, when the Case is a side Case (Plan
 * 74). Each turn of the side Case admits it before inference, so each turn
 * makes this one read for both kinds.
 */
export async function readSideCaseOrigin(
  placement: OrganisationExecutionScope,
  caseId: string,
): Promise<SideCaseOrigin | null> {
  const raw = await placement.database
    .prepare(
      "SELECT * FROM side_case_proposal WHERE organisation_id = ? AND destination_case_id = ?",
    )
    .bind(placement.organisationId, caseId)
    .first();
  if (raw === null) return null;
  switch (raw.source_kind) {
    case "portal_chat":
      return { kind: "portal_chat", proposal: await parseProposalRow(raw) };
    case "slack_thread":
      return {
        kind: "slack_thread",
        proposal: await parseSlackProposalRow(raw),
      };
    default:
      throw new Error("side_case_storage_invalid");
  }
}
