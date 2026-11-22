import { errorMessage } from "@purin-labs/std";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { ActorFenceToken } from "./actor-registry";
import {
  readActivationExportSource,
  type ActorExportError,
} from "./actor-export";

export function createActorExecutionBarrierSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS state_object_cleanup_export_barrier (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
  )`);
}

export function actorExecutionAdmissionOpen(sql: SqlStorage): boolean {
  return (
    sql.exec("SELECT 1 FROM state_object_cleanup_export_barrier").toArray()
      .length === 0
  );
}

export async function isActorExecutionActive(
  sql: SqlStorage,
  scope: OrganisationExecutionScope,
): Promise<boolean> {
  if (!actorExecutionAdmissionOpen(sql)) return false;
  const active = await scope.isActive();
  return active && actorExecutionAdmissionOpen(sql);
}

export function closeActorExecutionAdmission(
  sql: SqlStorage,
  expectedFenceToken: ActorFenceToken,
): Result<null, ActorExportError> {
  const activation = readActivationExportSource(sql);
  if (!activation.ok) return activation;
  if (activation.value.fenceToken !== expectedFenceToken)
    return { ok: false, error: { code: "actor_fence_mismatch" } };
  sql.exec(
    "INSERT OR IGNORE INTO state_object_cleanup_export_barrier (singleton) VALUES (1)",
  );
  return { ok: true, value: null };
}

export async function settleActorExecution<Value>(
  work: Promise<Value>,
): Promise<Result<null, ActorExportError>> {
  try {
    await work;
    return { ok: true, value: null };
  } catch (error) {
    return {
      ok: false,
      error: { code: "export_write_failed", detail: errorMessage(error) },
    };
  }
}

export async function isOrganisationExecutionActive(
  sql: SqlStorage,
  scope: OrganisationExecutionScope,
): Promise<boolean> {
  if (
    sql.exec("SELECT 1 FROM state_object_policy_export_barrier").toArray()
      .length > 0
  )
    return false;
  const active = await scope.isActive();
  return (
    active &&
    sql.exec("SELECT 1 FROM state_object_policy_export_barrier").toArray()
      .length === 0
  );
}
