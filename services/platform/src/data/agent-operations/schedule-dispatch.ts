import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type {
  ScheduleBinding,
  ScheduleDispatchReceipt,
} from "../agent-operations";
import { integer, text } from "./input";
import {
  type RawScheduleBinding,
  organisation,
  parseScheduleBindingRow,
} from "./rows";

export const SCHEDULE_BINDING_COLUMNS = `binding_id AS bindingId, organisation_id AS organisationId, area_id AS areaId,
   scope_ids_json AS scopeIds,
   installation_id AS installationId, cadence, minute_of_hour AS minuteOfHour,
   time_of_day AS timeOfDay, weekday, timezone,
   schedule_time_key AS scheduleTimeKey, instruction_body AS instructionBody,
   last_dispatched_window AS lastDispatchedWindow, enabled, revision,
   created_at AS createdAt, updated_at AS updatedAt`;

/**
 * Every enabled schedule binding whose organisation and installation are active,
 * across all organisations. The cron dispatcher computes each binding's current
 * window from this list.
 */
export async function listEnabledScheduleBindings(
  db: OrganisationDatabase,
): Promise<readonly ScheduleBinding[]> {
  const rows = (
    await db
      .prepare(
        `SELECT ${scheduleBindingColumnsFor("binding")}
     FROM schedule_binding AS binding
     JOIN organisation ON organisation.organisation_id = binding.organisation_id AND organisation.status = 'active'
     JOIN agent_installation AS installation
       ON installation.installation_id = binding.installation_id
      AND installation.organisation_id = binding.organisation_id
      AND installation.lifecycle = 'active'
     WHERE binding.enabled = 1
     ORDER BY binding.organisation_id, binding.binding_id`,
      )
      .all<RawScheduleBinding>()
  ).results;
  return rows.map(parseScheduleBindingRow);
}

export function scheduleBindingColumnsFor(alias: string): string {
  return `${alias}.binding_id AS bindingId, ${alias}.organisation_id AS organisationId,
    ${alias}.area_id AS areaId, ${alias}.scope_ids_json AS scopeIds,
    ${alias}.installation_id AS installationId,
    ${alias}.cadence, ${alias}.minute_of_hour AS minuteOfHour,
    ${alias}.time_of_day AS timeOfDay, ${alias}.weekday, ${alias}.timezone,
    ${alias}.schedule_time_key AS scheduleTimeKey,
    ${alias}.instruction_body AS instructionBody,
    ${alias}.last_dispatched_window AS lastDispatchedWindow,
    ${alias}.enabled, ${alias}.revision,
    ${alias}.created_at AS createdAt, ${alias}.updated_at AS updatedAt`;
}

/**
 * Atomically claims one dispatch window for a binding. Returns true exactly
 * once per (binding, window): a concurrent or repeated tick observes the
 * already-advanced window and returns false. Disabling the binding also
 * fences the claim.
 */
export async function claimScheduleDispatchWindow(
  scope: OrganisationExecutionScope,
  bindingId: string,
  windowKey: string,
): Promise<boolean> {
  if (!(await scope.isActive())) return false;
  const result = await scope.database
    .prepare(
      `UPDATE schedule_binding
        SET last_dispatched_window = ?
      WHERE organisation_id = ? AND binding_id = ? AND enabled = 1
        AND (last_dispatched_window IS NULL OR last_dispatched_window <> ?)
        AND EXISTS (
          SELECT 1 FROM organisation_placement
          WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
            AND fence_token = ? AND status = 'active'
        )`,
    )
    .bind(
      windowKey,
      scope.organisationId,
      bindingId,
      windowKey,
      scope.organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      scope.fenceToken,
    )
    .run();
  return result.meta.changes === 1;
}

export async function readScheduleDispatchReceipt(
  db: OrganisationDatabase,
  bindingId: string,
  windowKey: string,
): Promise<ScheduleDispatchReceipt | null> {
  const row = await db
    .prepare(
      `SELECT binding_id AS bindingId, window_key AS windowKey, organisation_id AS organisationId,
            case_id AS caseId, dispatched_at AS dispatchedAt
     FROM schedule_dispatch_receipt WHERE binding_id = ? AND window_key = ?`,
    )
    .bind(bindingId, windowKey)
    .first<{
      readonly bindingId: unknown;
      readonly windowKey: unknown;
      readonly organisationId: unknown;
      readonly caseId: unknown;
      readonly dispatchedAt: unknown;
    }>();
  if (row === null) {
    return null;
  }
  return {
    bindingId: text(row.bindingId),
    windowKey: text(row.windowKey),
    organisationId: organisation(row.organisationId),
    caseId: text(row.caseId),
    dispatchedAt: integer(row.dispatchedAt),
  };
}

export async function recordScheduleDispatchReceipt(
  db: OrganisationDatabase,
  receipt: ScheduleDispatchReceipt,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO schedule_dispatch_receipt (
       binding_id, window_key, organisation_id, case_id, dispatched_at
     ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      receipt.bindingId,
      receipt.windowKey,
      receipt.organisationId,
      receipt.caseId,
      receipt.dispatchedAt,
    )
    .run();
}
