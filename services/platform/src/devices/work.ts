import { deviceFleetStub } from "../actors/device-fleet";
import type { Env } from "../env";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { readKitchenDeviceView } from "./views";
import { eventStatement, readDevice, readGateway } from "./store";

/**
 * The Work fact of a device (Plan 85). Plan 24 owns physical runs and dispatch,
 * and it calls these functions. A device holds at most one task, and only a
 * device that is ready can take one.
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
  if (view === null || view.readiness.kind !== "ready")
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
