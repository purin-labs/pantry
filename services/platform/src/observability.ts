import type { RequestId } from "./ids";
import { isolateLocation } from "./isolate-location";

type TraceFields = {
  requestId: RequestId;
} & Record<string, unknown>;

export function traceLog(event: string, fields: TraceFields): void {
  console.log(JSON.stringify(traceRecord("info", event, fields)));
}

export function traceWarn(event: string, fields: TraceFields): void {
  console.warn(JSON.stringify(traceRecord("warn", event, fields)));
}

function traceRecord(
  level: "info" | "warn",
  event: string,
  fields: TraceFields,
): Record<string, unknown> {
  const colo = isolateLocation();
  return {
    level,
    event,
    at: Date.now(),
    request_id: fields.requestId,
    // Where the record was written. Absent until the isolate has read it.
    ...(colo === null ? {} : { colo }),
    ...fields,
  };
}
