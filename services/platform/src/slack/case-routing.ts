import {
  parseAssignmentId,
  parseCaseId,
  parseConnectorId,
  parseSessionId,
  type AssignmentId,
  type CaseId,
  type ConnectorId,
  type IntegrationAccountId,
  type SessionId,
} from "../ids";
import type { Result } from "../result";
import type { SlackMessageEvent } from "./events";

type SlackCaseRouteError = {
  readonly code: "slack_case_identity_invalid";
};

export function isSlackCaseRoutingCandidate(event: SlackMessageEvent): boolean {
  return (
    event.trigger === "mention" ||
    (event.trigger === "message" && event.messageTs !== event.threadTs)
  );
}

export function deriveSlackCaseRouteIdentities(
  integrationAccountId: IntegrationAccountId,
  event: SlackMessageEvent,
): Result<
  {
    readonly caseId: CaseId;
    readonly connectorId: ConnectorId;
    readonly sessionId: SessionId;
    readonly assignmentId: AssignmentId;
  },
  SlackCaseRouteError
> {
  const caseId = deriveSlackCaseId(event);
  const root = event.threadTs.replaceAll(".", "_");
  const connectorId = parseConnectorId(
    `connector_slack_${integrationAccountId}`,
  );
  const sessionId = parseSessionId(
    `session_case_slack_${event.workspaceId}_${event.channelId}_${root}`,
  );
  const assignmentId = parseAssignmentId(
    `assignment_case_slack_${event.workspaceId}_${event.channelId}_${root}`,
  );
  return caseId !== null && connectorId.ok && sessionId.ok && assignmentId.ok
    ? {
        ok: true,
        value: {
          caseId,
          connectorId: connectorId.value,
          sessionId: sessionId.value,
          assignmentId: assignmentId.value,
        },
      }
    : { ok: false, error: { code: "slack_case_identity_invalid" } };
}

export function deriveSlackCaseId(event: SlackMessageEvent): CaseId | null {
  const root = event.threadTs.replaceAll(".", "_");
  const parsed = parseCaseId(
    `case_slack_${event.workspaceId}_${event.channelId}_${root}`,
  );
  return parsed.ok ? parsed.value : null;
}
