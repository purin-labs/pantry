import { requireActiveOrganisationActor } from "../../actors/actor-router";
import { requireSessionExecution } from "../../actors/session-execution-admission";
import type { SessionToolContext } from "../context";
import { readMemberRecord } from "../member-record-read";
import { liveDeviceMember } from "../session-support";
import { BakeRequestError, type BakeProposeRequest } from "./services";

/**
 * Plan 24 S1: the Bakes page for the Portal chat agent. The read admits the
 * board through the information-flow boundary, as the Devices read does. A
 * proposal goes to the Organisation Actor for the person who asked, so the
 * same role check runs as on the page; the agent has no decision tool.
 */
export function readBakesForEmbeddedHarness(
  context: SessionToolContext,
): Promise<unknown> {
  const { scope } = context.execution;
  return readMemberRecord(context, {
    source: "bake_board",
    recordId: "bakes",
    refusal: () =>
      new BakeRequestError(
        "Only a member of this workspace can read its bakes. Nothing was read. Tell the person.",
      ),
    read: async () => {
      const organisation = await requireActiveOrganisationActor({
        env: context.env,
        organisationId: scope.organisationId,
        now: Date.now(),
      });
      const board = await organisation.readBakeBoard({
        organisationId: scope.organisationId,
      });
      if (!board.ok) throw new Error("The bakes are unavailable.");
      const { ok: _ok, ...value } = board.value;
      return value;
    },
  });
}

export async function proposeBakeForEmbeddedHarness(
  context: SessionToolContext,
  request: BakeProposeRequest,
): Promise<unknown> {
  const { env, execution, lease } = context;
  await requireSessionExecution(execution, lease);
  const { scope } = execution;
  if (lease.requestAuthority.kind !== "control")
    throw new BakeRequestError(
      "A person asks for a bake from the Portal chat. Nothing was stored.",
    );
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null)
    throw new BakeRequestError(
      "Only a member of this workspace can ask for a bake. Nothing was stored. Tell the person.",
    );
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: scope.organisationId,
    now: Date.now(),
  });
  const proposed = await organisation.runBakeCommand({
    organisationId: scope.organisationId,
    command: {
      kind: "propose",
      inventoryItemId: request.inventoryItemId,
      pieces: request.pieces,
      requester: { userId: member.userId, role: member.role },
    },
  });
  await requireSessionExecution(execution, lease);
  if (!proposed.ok)
    throw new BakeRequestError(
      "message" in proposed.error && typeof proposed.error.message === "string"
        ? proposed.error.message
        : "Seams Pantry could not store the proposal now. Nothing was stored.",
    );
  if (proposed.value.kind !== "proposed")
    throw new Error("A bake proposal returned another outcome.");
  const proposal = proposed.value.proposal;
  return {
    kind: "bake_proposed",
    proposalId: proposal.proposalId,
    state: proposal.state,
    productName: proposal.productName,
    quantityPieces: proposal.quantityPieces,
    mouldGroups: proposal.mouldGroups,
    workflowId: proposal.workflowId,
    workflowRevision: proposal.workflowRevision,
    oven: proposal.oven,
    decision:
      proposal.state === "waiting"
        ? "It waits until the product's active proposal ends. Then an operator, an admin or the owner decides it on the Bakes page or on its Slack card."
        : "An operator, an admin or the owner decides it on the Bakes page or on its Slack card. You cannot approve it.",
  };
}
