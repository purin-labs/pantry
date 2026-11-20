import {
  queryWorkspaceForEmbeddedHarness,
  readFileForEmbeddedHarness,
  searchFilesForEmbeddedHarness,
} from "../../agent-tools/files/handlers";
import type { FileToolServices } from "../../agent-tools/files/files";
import type { MessageToolServices } from "../../agent-tools/messages/messages";
import type { TurnToolServices } from "../../agent-tools/turn/turn";
import { withToolContext } from "../../agent-tools/context";
import { scheduleFollowUpForHarness } from "../harness-follow-up";
import { proposeMemoryForHarness } from "../harness-memory-proposal";
import { proposeSideCaseForHarness } from "../harness-side-case-proposal";
import {
  createAttachmentInspectionTool,
  createMessageLinkTool,
} from "../message-tools";
import { admittedSessionOperation } from "../session-execution-admission";
import { readPreparedInspection } from "./attachments";
import {
  admittedMessageLinkEgress,
  recordMessageAttachmentObservation,
} from "./model-route";
import type { OwnToolServicesSession, ToolTurnContext } from "./tool-wiring";

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
        recordObservation: recordMessageAttachmentObservation.bind(null, {
          execution: turn.execution,
          storage: turn.storage,
          lease: turn.lease,
          caseId: turn.assignment.caseId,
        }),
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
