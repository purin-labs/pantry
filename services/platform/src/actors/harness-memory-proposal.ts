import { assertNever } from "@purin-labs/std";

import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { readAdmittedChatInput } from "../chat/turn-access";
import { validateLiveRequestAuthority } from "@purin-labs/authority/request-authority/index";
import { readSessionTurnFlowBinding } from "./agent-session-information-flow";
import type {
  HarnessMemoryProposalRequest,
  HarnessMemoryProposalResult,
} from "../agent-tools/catalog/types";
import {
  requireSessionExecution,
} from "./session-execution-admission";
import type { SessionToolContext } from "../agent-tools/context";
import { turnMayProposeMemory } from "./session/turn-tool-offers";
import type { MemoryProposalPort } from "./session/tool-wiring";


/**
 * The agent's proposal of one Memory from what a person told it in a Portal
 * conversation.
 *
 * The candidate cites the Case entry of the message that started this turn,
 * and nothing else: the agent cannot name another entry, another Case or its
 * own words. Its label joins what this turn observed with the label recorded
 * with that message. The candidate is not in use until a person accepts it.
 * A refusal that the agent can explain is a result. A lookup that fails
 * throws, so the tool reports no outcome that it does not know.
 */
export async function proposeMemoryForHarness(
  proposeMemoryFromInstruction: MemoryProposalPort,
  input: SessionToolContext,
  request: HarnessMemoryProposalRequest,
): Promise<HarnessMemoryProposalResult> {
  await requireSessionExecution(input.execution, input.lease);
  const authority = input.lease.requestAuthority;
  if (authority.kind !== "control" || !turnMayProposeMemory(authority))
    throw new Error("memory proposal authority unavailable");
  const scope = input.execution.scope;
  const live = await validateLiveRequestAuthority({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      input.lease.session.sessionId,
      input.lease.turn.turnId,
    ),
    action: "execute",
    authority,
  });
  if (!live.ok) throw new Error("memory proposal authority has changed");
  const turnId = String(input.lease.turn.turnId);
  // The read also checks that the person may still open the conversation.
  const chat = await readAdmittedChatInput(scope.database, authority, turnId);
  if (chat === null || !turnId.startsWith("turn_trigger_"))
    return notProposed(
      "This turn did not start from a message in a Portal chat.",
    );
  // The Case keeps the message that started a turn as the entry of its
  // trigger. The assignment's snapshot holds the digest of that entry.
  const entryId = `trigger:${turnId.slice("turn_".length)}`;
  const entry = input.assignment.context.entries.find(
    (candidate) => candidate.entryId === entryId,
  );
  if (entry === undefined)
    return notProposed("The message of this turn is not available to cite.");
  const informationFlow = await readSessionTurnFlowBinding(input.storage.sql, {
    organisationId: String(scope.organisationId),
    sessionId: String(input.assignment.sessionId),
    turnId,
  });
  if (
    !informationFlow.ok ||
    informationFlow.value === null ||
    informationFlow.value.authorityPartitionDigest !==
      input.lease.authorityPartitionDigest
  )
    throw new Error("memory proposal information-flow binding unavailable");
  await requireSessionExecution(input.execution, input.lease);
  const proposed = await proposeMemoryFromInstruction({
    env: input.env,
    execution: scope,
    organisationId: scope.organisationId,
    agent: {
      caseId: String(input.assignment.caseId),
      assignmentId: String(input.assignment.assignmentId),
      sessionId: String(input.assignment.sessionId),
    },
    instruction: {
      kind: "operator_instruction",
      caseId: String(input.assignment.caseId),
      entryId,
      digest: entry.digest,
    },
    turnLabel: informationFlow.value.binding.flowLabel,
    memoryKind: request.memoryKind,
    statement: request.statement,
    now: Date.now(),
  });
  if (proposed.ok)
    return {
      kind: "memory_proposed",
      state: "waiting_for_review",
      detail:
        "The memory waits for a person's review in Brain. It is not in use until someone accepts it.",
    };
  switch (proposed.error.code) {
    case "memory_evidence_unavailable":
    case "memory_evidence_invalid":
      return notProposed("The message of this turn cannot support a memory.");
    case "memory_invalid":
      return notProposed(
        "The statement is not valid. Use one or two plain sentences.",
      );
    case "memory_capacity_exceeded":
      return notProposed(
        "The organisation holds the maximum number of memories.",
      );
    case "memory_unavailable":
      throw new Error("memory proposal unavailable");
    default:
      return assertNever(proposed.error.code);
  }
}

function notProposed(reason: string): HarnessMemoryProposalResult {
  return { kind: "memory_not_proposed", reason };
}
