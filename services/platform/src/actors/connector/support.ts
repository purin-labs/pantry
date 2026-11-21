import type { ConnectorIdentity } from "@purin-labs/contracts";
import type { RequestId } from "../../ids";
import { traceWarn } from "../../observability";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type { CountRow } from "../sql-rows";
import { scheduleCaseWorkAlarm } from "./alarm";
import type { ChannelAlarmDue } from "./channel-adapter";
// The pure parsers live in a module with no Actor imports, so that a module
// outside the Connector can parse a stored delivery (Refactor 15).
export { invalid } from "./ingress-content";

export async function scheduleAcceptedCaseWorkAlarm(
  storage: DurableObjectStorage,
  channels: readonly ChannelAlarmDue[],
  requestId: RequestId,
): Promise<void> {
  const scheduled = await scheduleCaseWorkAlarm(storage, channels, requestId);
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

/**
 * How many turns for different Cases one Connector runs at a time. Messages
 * for different Cases run at the same time, up to this bound, so one long
 * turn does not hold back the rest of the workspace. Messages for one Case
 * run one after another.
 */
export const CASE_WORK_CONCURRENCY = 4;

export function count(
  sql: SqlStorage,
  table: "connector_ingress" | "connector_delivery",
): number {
  return (
    sql.exec<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0]
      ?.count ?? 0
  );
}
