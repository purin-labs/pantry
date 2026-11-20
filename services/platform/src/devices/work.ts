import { deviceFleetStub } from "../actors/device-fleet";
import type { Env } from "../env";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { openResultUnknownAlert } from "./alerts";
import { readKitchenDeviceView } from "./views";
import { eventStatement, readDevice, readGateway } from "./store";

/**
 * The Work fact of a device (Plan 85). Plan 24 owns physical runs and dispatch,
 * and it calls these functions. A device holds at most one task, and only a
 * device that is ready can take one. The device fleet Actor moves the fact on
 * from the gateway's reports: `running` at the first report, `idle` after
 * `completed` or `rejected`, and `result_unknown` after `indeterminate` or a
 * lost socket. Only a person settles `result_unknown`.
 */
type ReserveDeviceWorkResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: "device_not_ready" }>;

export async function reserveDeviceWork(
  env: Env,
  scope: OrganisationExecutionScope,
  input: Readonly<{
    deviceId: string;
    taskRef: string;
    runRef: string | null;
    label: string;
    now: number;
  }>,
): Promise<ReserveDeviceWorkResult> {
  const view = await readKitchenDeviceView(
    env,
    scope,
    input.deviceId,
    input.now,
  );
  if (view === null) return { ok: false, code: "device_not_ready" };
  // A second reserve of the same task is the same reservation.
  if (
    view.readiness.kind === "busy" &&
    view.readiness.taskRef === input.taskRef
  )
    return { ok: true };
  if (view.readiness.kind !== "ready")
    return { ok: false, code: "device_not_ready" };
  const db = scope.database;
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE device_enrollment
            SET work_state = 'reserved', work_task_ref = ?, work_run_ref = ?,
                work_label = ?, work_at = ?
          WHERE device_id = ? AND organisation_id = ? AND state = 'active'
            AND work_state = 'idle'`,
      )
      .bind(
        input.taskRef,
        input.runRef,
        input.label,
        input.now,
        input.deviceId,
        scope.organisationId,
      ),
    eventStatement(db, {
      organisationId: scope.organisationId,
      subjectId: input.deviceId,
      kind: "task_reserved",
      actor: { kind: "platform", id: null },
      detail: { label: input.label },
      idempotencyKey: null,
      now: input.now,
    }),
  ]);
  if ((updated?.meta.changes ?? 0) === 0)
    return { ok: false, code: "device_not_ready" };
  const device = await readDevice(db, scope.organisationId, input.deviceId);
  const gateway =
    device === null
      ? null
      : await readGateway(db, scope.organisationId, device.gatewayId);
  if (gateway !== null)
    await deviceFleetStub(env, scope, gateway.locationId)?.refresh();
  return { ok: true };
}

export type DeviceWorkChange = "running" | "idle" | "result_unknown";

/**
 * Moves the Work fact of the task `taskRef` on. A device that holds another
 * task, or already holds this state, changes nothing and writes nothing.
 */
export async function changeDeviceWork(
  env: Env,
  scope: OrganisationExecutionScope,
  input: Readonly<{
    deviceId: string;
    taskRef: string;
    to: DeviceWorkChange;
    now: number;
  }>,
): Promise<boolean> {
  const from =
    input.to === "running" ? `('reserved')` : `('reserved', 'running')`;
  const assignments =
    input.to === "idle"
      ? `work_state = 'idle', work_task_ref = NULL, work_run_ref = NULL,
         work_label = NULL, work_at = ?`
      : `work_state = '${input.to}', work_at = ?`;
  const result = await scope.database
    .prepare(
      `UPDATE device_enrollment SET ${assignments}
        WHERE device_id = ? AND organisation_id = ? AND work_task_ref = ?
          AND work_state IN ${from}`,
    )
    .bind(input.now, input.deviceId, scope.organisationId, input.taskRef)
    .run();
  const changed = (result.meta.changes ?? 0) > 0;
  if (changed && input.to === "result_unknown") {
    const device = await readDevice(
      scope.database,
      scope.organisationId,
      input.deviceId,
    );
    if (device !== null)
      await openResultUnknownAlert(env, scope, device, input.now);
  }
  return changed;
}
