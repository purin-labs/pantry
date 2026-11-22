import type { FirstOperationalTask } from "@purin-labs/contracts";

import {
  parseOrganisationId,
  type ActivationReceiptId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  parseCommerceSystemRevision,
  type CommerceSystemRevision,
} from "./organisation-commerce-system";
import type { OrganisationQuerySource } from "@purin-labs/tenancy/data/query-source";

type FirstTaskSourceRow = {
  readonly organisationId: unknown;
  readonly commerceSystemRevision: unknown;
  readonly destinationId: unknown;
};

type FirstTaskRow = FirstTaskSourceRow;

export async function deriveFirstOperationalTask(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<FirstOperationalTask> {
  const row = await db
    .prepare(
      `SELECT onboarding.organisation_id AS organisationId,
            commerce.revision AS commerceSystemRevision,
            destination.channel_id AS destinationId
     FROM organisation_onboarding AS onboarding
     JOIN organisation_commerce_system AS commerce
       ON commerce.organisation_id = onboarding.organisation_id
     JOIN organisation_communication_destination AS destination
       ON destination.organisation_id = onboarding.organisation_id
     WHERE onboarding.organisation_id = ?`,
    )
    .bind(organisationId)
    .first<FirstTaskSourceRow>();
  if (row === null) {
    throw new Error("first operational task authority is missing");
  }
  return parseFirstOperationalTask(row);
}

export function prepareFirstOperationalTask(
  db: OrganisationQuerySource,
  activationReceiptId: ActivationReceiptId,
  task: FirstOperationalTask,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO organisation_first_operational_task (
       organisation_id, activation_receipt_id, task_kind,
       commerce_system_revision, destination_id, created_at
     ) VALUES (?, ?, 'observe_recent_commerce', ?, ?, ?)
     ON CONFLICT (organisation_id) DO UPDATE SET
       activation_receipt_id = excluded.activation_receipt_id,
       task_kind = excluded.task_kind,
       commerce_system_revision = excluded.commerce_system_revision,
       destination_id = excluded.destination_id,
       created_at = excluded.created_at`,
    )
    .bind(
      task.organisation_id,
      activationReceiptId,
      task.commerce_system_revision,
      task.destination_id,
      now,
    );
}

export async function readFirstOperationalTask(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<FirstOperationalTask | null> {
  const row = await db
    .prepare(
      `SELECT organisation_id AS organisationId,
            commerce_system_revision AS commerceSystemRevision,
            destination_id AS destinationId
     FROM organisation_first_operational_task
     WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<FirstTaskRow>();
  return row === null ? null : parseFirstOperationalTask(row);
}

function parseFirstOperationalTask(row: FirstTaskRow): FirstOperationalTask {
  return {
    kind: "observe_recent_commerce",
    organisation_id: requireOrganisationId(row.organisationId),
    commerce_system_revision: requireCommerceSystemRevision(
      row.commerceSystemRevision,
    ),
    destination_id: requireString(row.destinationId, "destination id"),
  };
}

function requireOrganisationId(raw: unknown): OrganisationId {
  if (typeof raw !== "string") {
    throw new Error("first operational task organisation id is invalid");
  }
  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) {
    throw new Error("first operational task organisation id is invalid");
  }
  return parsed.value;
}

function requireCommerceSystemRevision(raw: unknown): CommerceSystemRevision {
  const parsed = parseCommerceSystemRevision(raw);
  if (!parsed.ok) {
    throw new Error(
      "first operational task commerce system revision is invalid",
    );
  }
  return parsed.value;
}

function requireString(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`first operational task ${name} is invalid`);
  }
  return raw;
}
