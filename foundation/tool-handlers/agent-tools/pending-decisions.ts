import type { PendingDecisionList } from "@purin-labs/control-api";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import type { SessionToolContext } from "@purin-labs/agent/agent-tools/context";
import { readTurnControlSession } from "@purin-labs/conversation/chat/turn-access";
import { authorizeOrganisationSession } from "@purin-labs/control/worker/authorization";
import {
  listPendingDecisions,
  type PendingDecisionSources,
} from "@purin-labs/control/worker/pending-decisions";
import { readMemberRecord } from "./member-record-read";

/**
 * The decisions that wait for the person who asked, through the one read of
 * the Portal (FND-06). The read runs as that person's Portal sign-in of this
 * turn, so each store applies the check of its own page, and the list enters
 * the turn with the label of the person's own message.
 */
export function readPendingDecisionsForEmbeddedHarness(
  sources: PendingDecisionSources,
  context: SessionToolContext,
): Promise<PendingDecisionList> {
  const { env, execution, lease } = context;
  const { scope } = execution;
  return readMemberRecord(context, {
    source: "ingress",
    recordId: "pending-decisions",
    refusal: () =>
      new ToolRequestError(
        "The person who asked is not a member of this Organisation now. Nothing was read. Tell the person.",
      ),
    read: async (member) => {
      const turn = await readTurnControlSession(
        scope.database,
        scope.organisationId,
        lease.session.sessionId,
        lease.turn.turnId,
      );
      const reader =
        turn === null || turn.userId !== member.userId
          ? null
          : await authorizeOrganisationSession({
              env,
              scope,
              controlSessionId: turn.controlSessionId,
              userId: turn.userId,
              role: "viewer",
              action: "disclose",
            });
      if (reader === null)
        throw new ToolRequestError(
          "The list of what waits for a person reads their Portal sign-in, and this request has none that is current. Nothing was read. Tell the person to ask in a Portal chat, or to open the decisions in the Portal.",
        );
      const decisions = await listPendingDecisions(sources, reader);
      if (decisions === null)
        throw new Error("Pending decisions are unavailable");
      return decisions;
    },
  });
}
