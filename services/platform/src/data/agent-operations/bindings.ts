import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import {
  computeScheduleWindowKey,
  scheduleTimeKey,
} from "../../schedules/window";
import type { Variant } from "@purin-labs/type-utils";
import type { AgentOperationCommand } from "../agent-operations";
import { requireActiveArea, requirePublishedScopes } from "./areas";
import { requireActiveInstallation } from "./definitions";
import { AgentOperationFailure, commitWithTrailing } from "./failure";
import { positive } from "./input";
import { type RawScheduleBinding, parseScheduleBindingRow } from "./rows";
import { SCHEDULE_BINDING_COLUMNS } from "./schedule-dispatch";

export async function configureCueBinding(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "configure_cue_binding">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  await requireActiveArea(db, organisationId, command.areaId);
  await requireActiveInstallation(db, organisationId, command.installationId);
  await requirePublishedScopes(
    db,
    organisationId,
    command.areaId,
    command.scopeIds,
  );
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO cue_binding (
       binding_id, organisation_id, area_id, scope_ids_json, installation_id, cue_source,
       cue_event_type, enabled, instruction_body, revision,
       updated_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (organisation_id, cue_source, cue_event_type) DO UPDATE SET
       area_id = excluded.area_id,
       scope_ids_json = excluded.scope_ids_json,
       installation_id = excluded.installation_id,
       enabled = excluded.enabled,
       instruction_body = excluded.instruction_body,
       revision = cue_binding.revision + 1,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.areaId,
          JSON.stringify(command.scopeIds),
          command.installationId,
          command.cueSource,
          command.cueEventType,
          command.enabled ? 1 : 0,
          command.instructionBody,
          command.actorUserId,
          command.now,
          command.now,
        ),
    ],
    trailing,
  );
}

export async function updateCueBinding(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "update_cue_binding">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const current = await db
    .prepare(
      `SELECT revision FROM cue_binding WHERE binding_id = ? AND organisation_id = ?`,
    )
    .bind(command.bindingId, organisationId)
    .first<{ readonly revision: unknown }>();
  if (current === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "bindingId",
    });
  }
  if (positive(current.revision) !== command.expectedRevision) {
    throw new AgentOperationFailure({
      code: "agent_operation_conflict",
      field: "expectedRevision",
    });
  }
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `UPDATE cue_binding
        SET enabled = ?, instruction_body = ?, revision = revision + 1,
            updated_by_user_id = ?, updated_at = ?
      WHERE binding_id = ? AND organisation_id = ? AND revision = ?`,
        )
        .bind(
          command.enabled ? 1 : 0,
          command.instructionBody,
          command.actorUserId,
          command.now,
          command.bindingId,
          organisationId,
          command.expectedRevision,
        ),
    ],
    trailing,
  );
}

export async function configureScheduleBinding(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "configure_schedule_binding">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  await requireActiveArea(db, organisationId, command.areaId);
  await requireActiveInstallation(db, organisationId, command.installationId);
  await requirePublishedScopes(
    db,
    organisationId,
    command.areaId,
    command.scopeIds,
  );
  const spec = command.spec;
  const currentWindow = computeScheduleWindowKey(spec, command.now);
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO schedule_binding (
       binding_id, organisation_id, area_id, scope_ids_json, installation_id, cadence,
       minute_of_hour, time_of_day, weekday, timezone, schedule_time_key,
       instruction_body, last_dispatched_window, enabled, revision,
       updated_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (organisation_id, installation_id, cadence, schedule_time_key) DO UPDATE SET
       area_id = excluded.area_id,
       scope_ids_json = excluded.scope_ids_json,
       instruction_body = excluded.instruction_body,
       last_dispatched_window = CASE
         WHEN excluded.enabled = 1 AND schedule_binding.enabled = 0
           THEN excluded.last_dispatched_window
         ELSE schedule_binding.last_dispatched_window
       END,
       enabled = excluded.enabled,
       revision = schedule_binding.revision + 1,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
        )
        .bind(
          command.operationId,
          organisationId,
          command.areaId,
          JSON.stringify(command.scopeIds),
          command.installationId,
          spec.cadence,
          spec.cadence === "hourly" ? spec.minuteOfHour : null,
          spec.cadence === "hourly" ? null : spec.timeOfDay,
          spec.cadence === "weekly" ? spec.weekday : null,
          spec.cadence === "hourly" ? null : spec.timezone,
          scheduleTimeKey(spec),
          command.instructionBody,
          currentWindow,
          command.enabled ? 1 : 0,
          command.actorUserId,
          command.now,
          command.now,
        ),
    ],
    trailing,
  );
}

export async function updateScheduleBinding(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "update_schedule_binding">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const current = await db
    .prepare(
      `SELECT ${SCHEDULE_BINDING_COLUMNS}
       FROM schedule_binding WHERE binding_id = ? AND organisation_id = ?`,
    )
    .bind(command.bindingId, organisationId)
    .first<RawScheduleBinding>();
  if (current === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "bindingId",
    });
  }
  const binding = parseScheduleBindingRow(current);
  if (binding.revision !== command.expectedRevision) {
    throw new AgentOperationFailure({
      code: "agent_operation_conflict",
      field: "expectedRevision",
    });
  }
  const reseededWindow =
    command.enabled && !binding.enabled
      ? computeScheduleWindowKey(binding.spec, command.now)
      : binding.lastDispatchedWindow;
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `UPDATE schedule_binding
        SET enabled = ?, instruction_body = ?, last_dispatched_window = ?,
            revision = revision + 1, updated_by_user_id = ?, updated_at = ?
      WHERE binding_id = ? AND organisation_id = ? AND revision = ?`,
        )
        .bind(
          command.enabled ? 1 : 0,
          command.instructionBody,
          reseededWindow,
          command.actorUserId,
          command.now,
          command.bindingId,
          organisationId,
          command.expectedRevision,
        ),
    ],
    trailing,
  );
}

export async function configureInstallationGovernance(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "configure_installation_governance">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  await requireActiveInstallation(db, organisationId, command.installationId);
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO agent_installation_governance (
       installation_id, organisation_id, max_session_budget_tokens, revision,
       updated_by_user_id, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (installation_id) DO UPDATE SET
       max_session_budget_tokens = excluded.max_session_budget_tokens,
       revision = agent_installation_governance.revision + 1,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
        )
        .bind(
          command.installationId,
          organisationId,
          command.maxSessionBudgetTokens,
          command.actorUserId,
          command.now,
        ),
    ],
    trailing,
  );
}

export async function configureEscalationPolicy(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "configure_escalation_policy">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  await requireActiveArea(db, organisationId, command.areaId);
  await requirePublishedScopes(
    db,
    organisationId,
    command.areaId,
    command.scopeIds,
  );
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `INSERT INTO escalation_policy (
       area_id, organisation_id, scope_ids_json, approval_reminder_after_ms, escalate_after_ms,
       escalate_to, revision, updated_by_user_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'organisation_owner', 1, ?, ?)
     ON CONFLICT (area_id) DO UPDATE SET
       scope_ids_json = excluded.scope_ids_json,
       approval_reminder_after_ms = excluded.approval_reminder_after_ms,
       escalate_after_ms = excluded.escalate_after_ms,
       revision = escalation_policy.revision + 1,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
        )
        .bind(
          command.areaId,
          organisationId,
          JSON.stringify(command.scopeIds),
          command.approvalReminderAfterMs,
          command.escalateAfterMs,
          command.actorUserId,
          command.now,
        ),
    ],
    trailing,
  );
}
