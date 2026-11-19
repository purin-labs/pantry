import type { ConnectorIdentity } from "@purin-labs/contracts";
import type { RequestId, SessionId } from "../../ids";
import { slackAuthoredText } from "../../slack/events";
import { traceWarn } from "../../observability";
import type { SlackCaseCommand } from "../../ingress-queue";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type { SessionActorRoute } from "../actor-router";
import type { SessionDO } from "../agent-session";
import type { CountRow } from "../sql-rows";
import { scheduleCaseWorkAlarm } from "./alarm";
// The pure parsers live in a module with no Actor imports, so that a module
// outside the Connector can parse a stored delivery (Refactor 15).
export { invalid, parseIngressContent } from "./ingress-content";

export async function scheduleAcceptedCaseWorkAlarm(
  storage: DurableObjectStorage,
  requestId: RequestId,
): Promise<void> {
  const scheduled = await scheduleCaseWorkAlarm(storage, requestId);
  if (scheduled.ok) return;
  traceWarn("connector.case_work_alarm_deferred", {
    requestId,
    reason: scheduled.error.code,
  });
}

/** Admits one Connector call for the identity it names, or refuses it. */
export type ConnectorAdmission = (
  identity: ConnectorIdentity,
) => Promise<OrganisationExecutionScope | null>;

/** How many Slack turns for different Cases one Connector runs at a time. */
export const CASE_WORK_CONCURRENCY = 4;

/**
 * Runs the Slack work a Connector accepted. Messages for different Cases run
 * at the same time, up to a bound, so one long turn does not hold back the
 * rest of the workspace. Messages for one Case run one after another.
 */
export type LiveSlackTurn = Readonly<{
  sessionId: SessionId;
  sessionRoute: SessionActorRoute;
}>;

/**
 * Provider ingress content.
 *
 * An admitted user message is revalidated through Lexicon so the Connector
 * never stores a message its own contract would refuse. Generated entries stay
 * on the text branch.
 */

export function count(
  sql: SqlStorage,
  table: "connector_ingress" | "connector_delivery",
): number {
  return (
    sql.exec<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0]
      ?.count ?? 0
  );
}

export type SessionStub = DurableObjectStub<SessionDO>;

/**
 * A reply may steer the running turn of its Case when the turn's requester
 * sent it, in the same thread, with text and no files. An edit changes an
 * earlier message and waits for the next turn.
 */
export function replyMaySteer(
  reply: SlackCaseCommand,
  running: SlackCaseCommand,
): boolean {
  return (
    reply.principalId === running.principalId &&
    reply.event.threadTs === running.event.threadTs &&
    reply.event.trigger !== "edit" &&
    reply.event.files.length === 0 &&
    slackAuthoredText(reply.event.authored).trim().length > 0
  );
}

export type EmailCaseContextCollectionAccess =
  | Readonly<{ kind: "ready"; accessToken: string }>
  | Readonly<{ kind: "inactive"; reason: string }>
  | Readonly<{ kind: "retry"; reason: string }>;
