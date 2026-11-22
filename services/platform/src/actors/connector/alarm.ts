import type { RequestId } from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";
import { nextAlarmAt, setActorAlarm } from "../lifecycle/actor-alarm";
import { connectorAlarmReconcilers } from "../connector-alarm";
import type { ChannelAlarmDue } from "./channel-adapter";
import { invalid } from "./support";
import type { ConnectorResult } from "./types";

/**
 * Sets the alarm to the earliest due work. `channels` gives the due times
 * of each channel's work.
 */
export async function armConnectorAlarm(
  storage: DurableObjectStorage,
  channels: readonly ChannelAlarmDue[],
): Promise<ConnectorResult<null>> {
  const now = Date.now();
  const next = nextAlarmAt(
    connectorAlarmReconcilers(storage.sql, channels),
    now,
  );
  try {
    await setActorAlarm(storage, next, now);
    return { ok: true, value: null };
  } catch {
    return invalid("connector_alarm_failed");
  }
}

export async function scheduleCaseWorkAlarm(
  storage: DurableObjectStorage,
  channels: readonly ChannelAlarmDue[],
  requestId: RequestId,
): Promise<ConnectorResult<null>> {
  let rowsRead = 0;
  const now = Date.now();
  const next = nextAlarmAt(
    connectorAlarmReconcilers(storage.sql, channels, (rows) => {
      rowsRead = rows;
    }),
    now,
  );
  traceLog("connector.case_work_alarm_query", {
    requestId,
    rows_read: rowsRead,
    alarm_scheduled: next !== null,
  });
  try {
    await setActorAlarm(storage, next, now);
    return { ok: true, value: null };
  } catch {
    return invalid("connector_case_work_alarm_failed");
  }
}
