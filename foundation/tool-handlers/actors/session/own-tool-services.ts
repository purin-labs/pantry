import {
  queryWorkspaceForEmbeddedHarness,
  readFileForEmbeddedHarness,
  searchFilesForEmbeddedHarness,
} from "../../agent-tools/files/handlers";
import type { FileToolServices } from "@purin-labs/agent-tools/files/files";
import type { MessageToolServices } from "@purin-labs/agent-tools/messages/messages";
import type { TurnToolServices } from "@purin-labs/agent-tools/turn/turn";
import { withToolContext } from "@purin-labs/agent/agent-tools/context";
import { scheduleFollowUpForHarness } from "../harness-follow-up";
import { proposeMemoryForHarness } from "../harness-memory-proposal";
import { proposeSideCaseForHarness } from "../harness-side-case-proposal";
import {
  createAttachmentInspectionTool,
  createMessageLinkTool,
} from "@purin-labs/agent/actors/message-tools";
import { admittedSessionOperation } from "@purin-labs/agent/actors/session-execution-admission";
import { readPreparedInspection } from "@purin-labs/agent/actors/session/attachments";
import { admittedMessageLinkEgress } from "@purin-labs/agent/actors/session/model-route";
import {
  recordMessageAttachmentObservation,
  recordMessageLinkObservation,
  type MessageObservationContext,
} from "@purin-labs/agent/actors/session/message-observations";
import type {
  OwnToolServicesSession,
  ToolTurnContext,
} from "@purin-labs/agent/actors/session/tool-wiring";

/**
 * The services of the tool families that the foundation owns: files, the
 * turn's own message, and the tools that a turn offers by its origin.
 */
export type SessionOwnToolServices = Readonly<{
  files: FileToolServices;
  messages: MessageToolServices;
  turn: TurnToolServices;
}>;

export function sessionOwnToolServices(
  turn: ToolTurnContext,
  session: OwnToolServicesSession,
): SessionOwnToolServices {
  const tool = withToolContext(turn);
  const observed: MessageObservationContext = {
    execution: turn.execution,
    storage: turn.storage,
    lease: turn.lease,
    caseId: turn.assignment.caseId,
  };
  return {
    files: {
      searchFiles: tool(searchFilesForEmbeddedHarness),
      readFile: tool(readFileForEmbeddedHarness),
      queryWorkspace: queryWorkspaceForEmbeddedHarness.bind(
        null,
        turn.env,
        session.persistence,
        turn.storage,
        turn.execution,
        turn.lease,
      ),
    },
    messages: {
      // Both message tools are scoped to this turn's own message, so neither
      // can reach a file or a link from another conversation.
      inspectMessageAttachment: createAttachmentInspectionTool({
        attachments: session.attachments,
        readPreparation: readPreparedInspection.bind(
          null,
          turn.execution,
          turn.storage,
          turn.env.ARCHIVE,
          turn.lease,
        ),
        recordObservation: recordMessageAttachmentObservation.bind(
          null,
          observed,
        ),
      }),
      readMessageLink: admittedSessionOperation(
        turn.execution,
        turn.lease,
        createMessageLinkTool({
          links: session.links,
          egress: admittedMessageLinkEgress(
            turn.execution,
            turn.lease,
            turn.env,
          ),
          recordObservation: recordMessageLinkObservation.bind(null, observed),
        }),
      ),
    },
    turn: {
      proposeMemory: proposeMemoryForHarness.bind(
        null,
        session.wiring.proposeMemory,
        turn,
      ),
      scheduleFollowUp: scheduleFollowUpForHarness.bind(null, {
        env: turn.env,
        execution: turn.execution,
        lease: turn.lease,
      }),
      proposeSideCase: proposeSideCaseForHarness.bind(
        null,
        session.wiring.slackThreadSideCase,
        turn,
      ),
    },
  };
}
