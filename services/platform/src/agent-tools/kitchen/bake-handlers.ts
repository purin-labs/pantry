import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { requireSessionExecution } from "@purin-labs/agent/actors/session-execution-admission";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import type { StaffPageToolReceipt } from "@purin-labs/agent-tools/catalog/types";
import type { SessionToolContext } from "@purin-labs/agent/agent-tools/context";
import { readMemberRecord } from "../member-record-read";
import { liveDeviceMember, type ToolEffect } from "../session-support";
import {
  BakeRequestError,
  type BakeProposeRequest,
  type BakeRunRequest,
} from "./services";

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
        : "Purin Pantry could not store the proposal now. Nothing was stored.",
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

/** Plan 24 S4: the one read of a bake run, under the bake board's label. */
export function readBakeRunForEmbeddedHarness(
  context: SessionToolContext,
  request: BakeRunRequest,
): Promise<unknown> {
  const { scope } = context.execution;
  return readMemberRecord(context, {
    source: "bake_board",
    recordId: `bake_run:${request.proposalId}`,
    refusal: () =>
      new BakeRequestError(
        "Only a member of this workspace can read its bake runs. Nothing was read. Tell the person.",
      ),
    read: async () => {
      const organisation = await requireActiveOrganisationActor({
        env: context.env,
        organisationId: scope.organisationId,
        now: Date.now(),
      });
      const run = await organisation.readBakeRun({
        organisationId: scope.organisationId,
        proposalId: request.proposalId,
      });
      if (!run.ok) throw new Error("The bake run is unavailable.");
      if (run.value === null)
        throw new BakeRequestError(
          "That proposal has no bake run. Call bake_read for the approved proposals.",
        );
      return run.value;
    },
  });
}

/**
 * Plan 24 S4: a pause of a bake run for the person who asked. The
 * Organisation Actor runs the same role check as the Bakes page, and the
 * pause of each cobot is the Devices page's own pause with its receipt.
 */
export async function pauseBakeRunForEmbeddedHarness(
  context: SessionToolContext,
  request: BakeRunRequest,
  operationId: string,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  const { env, execution, lease } = context;
  await requireSessionExecution(execution, lease);
  const { scope } = execution;
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null)
    throw new BakeRequestError(
      "Only a member of this workspace can pause a bake run. Nothing changed. Tell the person.",
    );
  return {
    kind: "effect",
    label: {
      source: "turn",
      unavailable: "bake run pause information-flow authority unavailable",
    },
    sink: {
      kind: "tool_effect" as const,
      destinationAuthority: lease.requestAuthority,
      capabilityId: CAPABILITY_KEYS.bakeRunPause,
      integrationAccountId: "platform",
      resourceScope: `bake_run:${request.proposalId}`,
      approvalSatisfied: false,
    },
    action: { operation: "kitchen.bake_run.pause", arguments: request },
    refusal: (decision) => `Bake run pause is not authorized: ${decision}`,
    run: async () => {
      const organisation = await requireActiveOrganisationActor({
        env,
        organisationId: scope.organisationId,
        now: Date.now(),
      });
      const paused = await organisation.runBakeCommand({
        organisationId: scope.organisationId,
        command: {
          kind: "run_action",
          proposalId: request.proposalId,
          action: { kind: "pause" },
          requester: { userId: member.userId, role: member.role, via: "agent" },
        },
      });
      if (!paused.ok)
        throw new BakeRequestError(
          "message" in paused.error && typeof paused.error.message === "string"
            ? `${paused.error.message} Nothing changed. Tell the person; do not retry.`
            : "Purin Pantry could not pause the run now. Nothing changed.",
        );
      const digest = await digestCanonical({
        sessionId: lease.session.sessionId,
        turnId: lease.turn.turnId,
        operationId,
        proposalId: request.proposalId,
      });
      return {
        receiptId: `bakepause_${digest.replace(/[^0-9a-f]/gu, "").slice(-24)}`,
        result:
          "The run sends no next task, and its cobots got a pause. A person resumes, settles or stops the run on the Bakes page. Emergency stop stays on the machine.",
      };
    },
  };
}
