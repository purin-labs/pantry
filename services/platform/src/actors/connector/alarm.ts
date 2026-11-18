import type { RequestId } from "../../ids";
import { traceLog } from "../../observability";
import { nextAlarmAt, setActorAlarm } from "../lifecycle/actor-alarm";
import { connectorAlarmReconcilers } from "../connector-alarm";
import { invalid } from "./support";
import type { ConnectorResult } from "./types";

export async function armConnectorAlarm(
  storage: DurableObjectStorage,
): Promise<ConnectorResult<null>> {
  const now = Date.now();
  const next = nextAlarmAt(connectorAlarmReconcilers(storage.sql), now);
  try {
    await setActorAlarm(storage, next, now);
    return { ok: true, value: null };
  } catch {
    return invalid("connector_alarm_failed");
  }
}

export async function scheduleCaseWorkAlarm(
  storage: DurableObjectStorage,
  requestId: RequestId,
): Promise<ConnectorResult<null>> {
  let rowsRead = 0;
  const now = Date.now();
  const next = nextAlarmAt(
    connectorAlarmReconcilers(storage.sql, (rows) => {
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
